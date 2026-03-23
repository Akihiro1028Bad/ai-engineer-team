import type { TaskQueue } from "../queue/task-queue.js";
import type { Dispatcher } from "../agents/dispatcher.js";
import { getAgentConfig } from "../agents/agent-config.js";
import type pino from "pino";

interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

interface WorkflowJob {
  name: string;
  conclusion: string | null;
  steps?: { name: string; conclusion: string | null }[];
}

interface OctokitLike {
  checks: {
    listForRef: (params: {
      owner: string;
      repo: string;
      ref: string;
    }) => Promise<{ data: { check_runs: CheckRun[] } }>;
  };
  pulls: {
    get: (params: {
      owner: string;
      repo: string;
      pull_number: number;
    }) => Promise<{ data: { head: { sha: string } } }>;
  };
  issues: {
    createComment: (params: {
      owner: string;
      repo: string;
      issue_number: number;
      body: string;
    }) => Promise<unknown>;
  };
  actions: {
    listWorkflowRunsForRepo: (params: {
      owner: string;
      repo: string;
      head_sha: string;
      status?: string;
    }) => Promise<{ data: { workflow_runs: { id: number; name: string; html_url: string }[] } }>;
    listJobsForWorkflowRun: (params: {
      owner: string;
      repo: string;
      run_id: number;
    }) => Promise<{ data: { jobs: WorkflowJob[] } }>;
  };
}

const MAX_CI_FIX_ATTEMPTS = 3;

export class CIMonitor {
  constructor(
    private readonly octokit: OctokitLike,
    private readonly queue: TaskQueue,
    private readonly dispatcher: Dispatcher,
    private readonly owner: string,
    private readonly repo: string,
    private readonly logger: pino.Logger,
  ) {}

  async checkPendingPRs(): Promise<void> {
    const tasks = this.queue.getByStatus("ci_checking");

    for (const task of tasks) {
      if (!task.prNumber) continue;

      try {
        // PR の head commit SHA を取得
        const { data: pr } = await this.octokit.pulls.get({
          owner: this.owner,
          repo: this.repo,
          pull_number: task.prNumber,
        });
        const sha = pr.head.sha;

        // Check Runs を取得
        const { data } = await this.octokit.checks.listForRef({
          owner: this.owner,
          repo: this.repo,
          ref: sha,
        });

        if (data.check_runs.length === 0) continue; // CI 未開始

        const allCompleted = data.check_runs.every((cr) => cr.status === "completed");
        if (!allCompleted) continue; // まだ実行中

        const allSuccess = data.check_runs.every(
          (cr) => cr.conclusion === "success" || cr.conclusion === "neutral" || cr.conclusion === "skipped",
        );
        const failedRuns = data.check_runs.filter((cr) => cr.conclusion === "failure");

        if (allSuccess) {
          // ✅ CI 全パス
          await this.octokit.issues.createComment({
            owner: this.owner,
            repo: this.repo,
            issue_number: task.prNumber,
            body: "🤖 **AI Agent Orchestrator**\n\n✅ CI 全パス。マージ可能です。",
          });
          this.queue.updateStatus(task.id, "ci_passed");
          this.logger.info({ taskId: task.id, prNumber: task.prNumber }, "CI passed");
        } else if (failedRuns.length > 0 && task.ciFixCount < MAX_CI_FIX_ATTEMPTS) {
          // ❌ CI 失敗 → 自動修正を試行
          const logs = await this.getFailureLogs(sha);
          await this.dispatchCIFix(task.id, task.prNumber, logs, task.ciFixCount + 1);
          this.queue.updateStatus(task.id, "ci_fixing");
          this.logger.warn(
            { taskId: task.id, attempt: task.ciFixCount + 1 },
            "CI failed, dispatching fix",
          );
        } else {
          // 3回失敗 → 手動対応依頼
          await this.octokit.issues.createComment({
            owner: this.owner,
            repo: this.repo,
            issue_number: task.prNumber,
            body: `🤖 **AI Agent Orchestrator**\n\n❌ CI が ${MAX_CI_FIX_ATTEMPTS} 回連続で失敗しました。手動での対応をお願いします。\n\n失敗した Check:\n${failedRuns.map((r) => `- ${r.name}`).join("\n")}`,
          });
          this.queue.updateStatus(task.id, "ci_failed");
          this.logger.error({ taskId: task.id }, "CI failed after max attempts");
        }
      } catch (error: unknown) {
        this.logger.error({ taskId: task.id, error }, "CI check error");
      }
    }
  }

  private async getFailureLogs(sha: string): Promise<string> {
    try {
      const { data: runs } = await this.octokit.actions.listWorkflowRunsForRepo({
        owner: this.owner,
        repo: this.repo,
        head_sha: sha,
      });

      const failedLogs: string[] = [];

      for (const run of runs.workflow_runs) {
        const { data: jobsData } = await this.octokit.actions.listJobsForWorkflowRun({
          owner: this.owner,
          repo: this.repo,
          run_id: run.id,
        });

        for (const job of jobsData.jobs) {
          if (job.conclusion === "failure") {
            const failedSteps = (job.steps ?? [])
              .filter((s) => s.conclusion === "failure")
              .map((s) => s.name);
            failedLogs.push(
              `### ${run.name} / ${job.name}\n失敗ステップ: ${failedSteps.join(", ")}\nログ: ${run.html_url}`,
            );
          }
        }
      }

      return failedLogs.join("\n\n") || "CI 失敗の詳細ログを取得できませんでした。";
    } catch {
      return "CI 失敗ログの取得に失敗しました。";
    }
  }

  private async dispatchCIFix(
    parentTaskId: string,
    prNumber: number,
    failureLogs: string,
    attempt: number,
  ): Promise<void> {
    const fixTaskId = `${parentTaskId}-cifix-${attempt}`;
    const source = `ci_fix:${parentTaskId}:${attempt}`;

    if (this.queue.isDuplicate(source)) return;

    this.queue.push({
      id: fixTaskId,
      taskType: "fix",
      title: `CI 修正 (試行 ${attempt}/${MAX_CI_FIX_ATTEMPTS})`,
      description: [
        `PR #${prNumber} の CI が失敗しました。以下のエラーを修正してください。`,
        "",
        "## CI 失敗ログ",
        failureLogs,
        "",
        "## 指示",
        "1. エラーの原因を特定してください",
        "2. コードを修正してください",
        "3. 修正はこのブランチ上で行ってください（新しいブランチは作らないでください）",
      ].join("\n"),
      source,
      priority: 1, // 最優先
      dependsOn: null,
      parentTaskId: null,
    });

    // PR にもコメント
    await this.octokit.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: prNumber,
      body: `🤖 **AI Agent Orchestrator**\n\n⚠️ CI 失敗を検出しました（試行 ${attempt}/${MAX_CI_FIX_ATTEMPTS}）。自動修正を開始します...`,
    });
  }
}
