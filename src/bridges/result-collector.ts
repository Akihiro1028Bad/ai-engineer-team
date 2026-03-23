import type { SlackNotifier } from "../notifications/slack-notifier.js";
import type { Task } from "../types.js";

interface OctokitWithIssues {
  issues: {
    createComment: (params: {
      owner: string;
      repo: string;
      issue_number: number;
      body: string;
    }) => Promise<unknown>;
  };
}

interface OctokitLike {
  pulls: {
    create: (params: {
      owner: string;
      repo: string;
      title: string;
      body: string;
      head: string;
      base: string;
    }) => Promise<{ data: { html_url: string } }>;
  };
  repos: {
    compareCommits: (params: {
      owner: string;
      repo: string;
      base: string;
      head: string;
    }) => Promise<{ data: string }>;
  };
}

interface PRResult {
  success: boolean;
  prUrl?: string;
  error?: string;
}

const DIFF_LIMIT = 500;

export class ResultCollector {
  constructor(
    private readonly octokit: OctokitLike,
    private readonly slackNotifier: SlackNotifier,
    private readonly owner: string,
    private readonly repo: string,
  ) {}

  async createDesignPR(task: Task, branch: string): Promise<PRResult> {
    return this.createPR({
      title: `[設計] ${task.title}`,
      body: this.buildPRBody(task, "設計レビュー結果"),
      branch,
      notificationEvent: "approval_requested",
      notificationTitle: `設計PR承認依頼: ${task.title}`,
    });
  }

  async createFinalPR(tasks: Task[], branch: string): Promise<PRResult> {
    const mainTask = tasks[0];
    if (!mainTask) {
      return { success: false, error: "No tasks provided" };
    }
    const summary = tasks.map((t) => `- ${t.taskType}: ${t.title}`).join("\n");
    return this.createPR({
      title: mainTask.title,
      body: this.buildPRBody(mainTask, `パイプライン完了\n\n${summary}`),
      branch,
      notificationEvent: "pipeline_pr_created",
      notificationTitle: `実装PR作成: ${mainTask.title}`,
    });
  }

  async createSinglePR(task: Task, branch: string): Promise<PRResult> {
    return this.createPR({
      title: task.title,
      body: this.buildPRBody(task, "タスク完了"),
      branch,
      notificationEvent: "task_completed",
      notificationTitle: `タスク完了: ${task.title}`,
    });
  }

  private async createPR(params: {
    title: string;
    body: string;
    branch: string;
    notificationEvent: string;
    notificationTitle: string;
  }): Promise<PRResult> {
    try {
      // Check diff size
      try {
        const { data: diff } = await this.octokit.repos.compareCommits({
          owner: this.owner,
          repo: this.repo,
          base: "main",
          head: params.branch,
        });
        const lineCount = diff.split("\n").filter((l) => l.startsWith("+") || l.startsWith("-")).length;
        if (lineCount > DIFF_LIMIT) {
          return {
            success: false,
            error: `diff が ${lineCount} 行あり、上限 ${DIFF_LIMIT} 行を超えています。PRを分割してください。`,
          };
        }
      } catch {
        // Diff check failure is non-blocking
      }

      const { data: pr } = await this.octokit.pulls.create({
        owner: this.owner,
        repo: this.repo,
        title: params.title,
        body: params.body,
        head: params.branch,
        base: "main",
      });

      // @claude /review を投稿してレビューをリクエスト
      const prNumber = Number(pr.html_url.split("/").pop());
      try {
        await (this.octokit as unknown as OctokitWithIssues).issues.createComment({
          owner: this.owner,
          repo: this.repo,
          issue_number: prNumber,
          body: "@claude /review",
        });
      } catch {
        // レビューリクエスト失敗は非致命的
      }

      await this.slackNotifier.send({
        level: "info",
        event: params.notificationEvent,
        title: params.notificationTitle,
        body: `PR: ${pr.html_url}`,
        fields: { prUrl: pr.html_url },
        timestamp: new Date().toISOString(),
      });

      return { success: true, prUrl: pr.html_url };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return { success: false, error: message };
    }
  }

  private buildPRBody(task: Task, summary: string): string {
    return [
      `## 変更内容`,
      summary,
      "",
      `## エビデンス`,
      "### タスク実行結果",
      "```json",
      task.result ?? "{}",
      "```",
      "",
      `- コスト: $${task.costUsd.toFixed(2)}`,
      `- ターン数: ${task.turnsUsed}`,
      `- タスクID: ${task.id}`,
    ].join("\n");
  }
}
