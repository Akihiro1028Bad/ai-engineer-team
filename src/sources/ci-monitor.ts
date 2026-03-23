import type { TaskQueue } from "../queue/task-queue.js";
import type { Dispatcher } from "../agents/dispatcher.js";
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
    // ci_fixing のタスクで修正タスクが完了/失敗していれば ci_checking に戻す
    await this.checkFixingTasks();

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

        // Check Runs を取得（GitHub Actions）
        const { data } = await this.octokit.checks.listForRef({
          owner: this.owner,
          repo: this.repo,
          ref: sha,
        });

        if (data.check_runs.length === 0) continue; // CI 未開始

        // まだ実行中のチェックがあればスキップ
        const inProgress = data.check_runs.filter(
          (cr) => cr.status === "queued" || cr.status === "in_progress",
        );
        if (inProgress.length > 0) {
          this.logger.debug(
            { taskId: task.id, inProgress: inProgress.map((cr) => cr.name) },
            "CI still in progress",
          );
          continue;
        }

        // Commit Statuses も確認（Vercel 等の外部 CI）
        try {
          const { data: combinedStatus } = await (this.octokit as unknown as {
            repos: { getCombinedStatusForRef: (p: { owner: string; repo: string; ref: string }) => Promise<{ data: { state: string } }> };
          }).repos.getCombinedStatusForRef({
            owner: this.owner,
            repo: this.repo,
            ref: sha,
          });
          if (combinedStatus.state === "pending") {
            this.logger.debug({ taskId: task.id }, "Combined status still pending");
            continue;
          }
        } catch {
          // Combined Status API がない場合は Check Runs のみで判定
        }

        const completedRuns = data.check_runs.filter((cr) => cr.status === "completed");
        const allSuccess = completedRuns.every(
          (cr) => cr.conclusion === "success" || cr.conclusion === "neutral" || cr.conclusion === "skipped",
        );
        const failedRuns = completedRuns.filter((cr) => cr.conclusion === "failure");

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

  private async checkFixingTasks(): Promise<void> {
    const fixingTasks = this.queue.getByStatus("ci_fixing");

    for (const task of fixingTasks) {
      // 最新の cifix パイプラインの impl タスクを探す
      const implTaskId = `${task.id}-cifix-${task.ciFixCount}-impl`;
      const implTask = this.queue.getById(implTaskId);

      // review タスクも確認（impl が存在しない場合は review を確認）
      const reviewTaskId = `${task.id}-cifix-${task.ciFixCount}-review`;
      const reviewTask = this.queue.getById(reviewTaskId);

      const taskToCheck = implTask ?? reviewTask;
      if (!taskToCheck) continue;

      // まだ実行中/待機中 → 何もしない（待機）
      if (taskToCheck.status === "pending" || taskToCheck.status === "in_progress") {
        continue;
      }

      // 完了 or 失敗 → ci_checking に戻して CI を再確認
      this.queue.updateStatus(task.id, "ci_checking", { prNumber: task.prNumber ?? undefined });

      // impl 完了時は @claude /review をリクエスト
      if (implTask?.status === "completed" && task.prNumber) {
        try {
          await this.octokit.issues.createComment({
            owner: this.owner,
            repo: this.repo,
            issue_number: task.prNumber,
            body: "@claude /review",
          });
        } catch { /* non-critical */ }
      }

      this.logger.info(
        { taskId: task.id, fixTaskId: implTaskId, fixResult: taskToCheck.status },
        "CI fix task done, returning to ci_checking",
      );
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

    // PR のブランチ名を取得
    let prBranch = "";
    try {
      const { data: pr } = await this.octokit.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
      }) as { data: { head: { ref: string; sha: string } } };
      prBranch = pr.head.ref;
    } catch {
      // ブランチ名取得失敗時は空文字のまま（Dispatcher が通常のブランチを作成する）
    }

    // CI 修正も設計書駆動: Opus で原因分析+修正方針 → Sonnet で実装
    const reviewTaskId = `${fixTaskId}-review`;
    const implTaskId = `${fixTaskId}-impl`;

    this.queue.pushPipeline([
      {
        id: reviewTaskId,
        taskType: "review",
        title: `[CI分析] CI 修正設計 (試行 ${attempt}/${MAX_CI_FIX_ATTEMPTS})`,
        description: [
          `PR #${prNumber} の CI が失敗しました。原因を分析し、修正設計書を作成してください。`,
          "",
          prBranch ? `**既存ブランチ**: \`${prBranch}\`` : "",
          "",
          "## CI 失敗ログ",
          failureLogs,
          "",
          "## 指示",
          "1. CI 失敗ログからエラーの原因を特定する",
          "2. 修正方針を決定する",
          `3. specs/ci-fix/${parentTaskId}-${attempt}/design.md に設計書を作成する`,
          "4. テストケースも含める",
          "",
          "コードの修正は行わないでください。設計書の作成のみです。",
        ].join("\n"),
        source,
        priority: 1,
        dependsOn: null,
        parentTaskId: null,
        repo: `${this.owner}/${this.repo}`,
      },
      {
        id: implTaskId,
        taskType: "fix",
        title: `[CI修正] CI 修正実装 (試行 ${attempt}/${MAX_CI_FIX_ATTEMPTS})`,
        description: [
          `PR #${prNumber} の CI 修正設計書に従って修正を実装してください。`,
          "",
          prBranch ? `**既存ブランチ**: \`${prBranch}\`（このブランチ上で修正してください）` : "",
          "",
          `設計書: specs/ci-fix/${parentTaskId}-${attempt}/design.md`,
          "",
          "## 指示",
          "1. 設計書を読む",
          "2. 設計書の修正方針に従ってコードを修正する",
          "3. テストを実行し、通ることを確認する",
          "4. 既存のブランチ上で修正し、新しいブランチは作らないでください",
        ].join("\n"),
        source: `${source}:impl`,
        priority: 1,
        dependsOn: reviewTaskId,
        parentTaskId: null,
        repo: `${this.owner}/${this.repo}`,
      },
    ]);

    // PR にもコメント
    await this.octokit.issues.createComment({
      owner: this.owner,
      repo: this.repo,
      issue_number: prNumber,
      body: `🤖 **AI Agent Orchestrator**\n\n⚠️ CI 失敗を検出しました（試行 ${attempt}/${MAX_CI_FIX_ATTEMPTS}）。自動修正を開始します...`,
    });
  }
}
