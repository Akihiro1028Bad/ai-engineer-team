import { Classifier } from "../agents/classifier.js";
import type { TaskQueue } from "../queue/task-queue.js";

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: { name: string }[];
  state: string;
}

interface GitHubComment {
  id: number;
  user: { login: string } | null;
  body: string;
  created_at: string;
}

interface OctokitLike {
  issues: {
    listForRepo: (params: {
      owner: string;
      repo: string;
      labels?: string;
      state: string;
    }) => Promise<{ data: GitHubIssue[] }>;
    listComments: (params: {
      owner: string;
      repo: string;
      issue_number: number;
      since?: string;
    }) => Promise<{ data: GitHubComment[] }>;
    createComment: (params: {
      owner: string;
      repo: string;
      issue_number: number;
      body: string;
    }) => Promise<unknown>;
  };
  pulls: {
    listReviews: (params: {
      owner: string;
      repo: string;
      pull_number: number;
    }) => Promise<{ data: { state: string }[] }>;
    get: (params: {
      owner: string;
      repo: string;
      pull_number: number;
    }) => Promise<{ data: { state: string; merged: boolean } }>;
  };
}

export class GitHubPoller {
  private readonly classifier: Classifier;
  // 起動時は1時間前からのコメントをチェック（起動前の未応答コメントを拾う）
  private lastCommentCheck = new Date(Date.now() - 3_600_000).toISOString();
  private readonly botMarker = "🤖 **AI Agent Orchestrator**";

  constructor(
    private readonly octokit: OctokitLike,
    private readonly queue: TaskQueue,
    private readonly owner: string,
    private readonly repo: string,
  ) {
    this.classifier = new Classifier(octokit, owner, repo);
  }

  /** タスク完了時に Issue へ結果をコメント投稿する */
  async postResultToIssue(taskId: string, result: string): Promise<void> {
    // taskId は "gh-{issueNumber}-{index}" 形式
    const match = /^gh-(\d+)-/.exec(taskId);
    if (!match) return;
    const issueNumber = Number(match[1]);

    try {
      await this.octokit.issues.createComment({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        body: `🤖 **AI Agent Orchestrator** (Task: \`${taskId}\`)\n\n${result}`,
      });
    } catch {
      // コメント投稿失敗は非致命的
    }
  }

  /** open Issue のコメントを監視し、人間の返信があれば再度タスクを投入する */
  async pollComments(): Promise<void> {
    try {
      const { data: issues } = await this.octokit.issues.listForRepo({
        owner: this.owner,
        repo: this.repo,
        state: "open",
      });

      for (const issue of issues) {
        if ("pull_request" in issue) continue;

        try {
          const { data: comments } = await this.octokit.issues.listComments({
            owner: this.owner,
            repo: this.repo,
            issue_number: issue.number,
            since: this.lastCommentCheck,
          });

          // 自分（bot）のコメントは除外し、人間の新しいコメントのみ処理
          const humanComments = comments.filter(
            (c) => c.body && !c.body.startsWith(this.botMarker),
          );

          if (humanComments.length === 0) continue;

          // 最新の人間コメントを取得
          const latestComment = humanComments[humanComments.length - 1]!;

          // 既にこの返信に対するタスクがあるかチェック
          const replySource = `github_comment:${issue.number}:${latestComment.id}`;
          if (this.queue.isDuplicate(replySource)) continue;

          // Issue の全文 + コメント履歴をコンテキストとして含める
          const allComments = comments.map(
            (c) => `[${c.user?.login ?? "unknown"}]: ${c.body}`,
          ).join("\n\n---\n\n");

          const description = [
            `## Issue #${issue.number}: ${issue.title}`,
            "",
            issue.body ?? "",
            "",
            "## コメント履歴",
            "",
            allComments,
            "",
            "## タスク",
            "",
            "上記のコメント履歴を踏まえて、Issue の問題を調査・修正してください。",
            "不明点があれば具体的に質問してください。",
          ].join("\n");

          // fix タスクとして投入
          this.queue.push({
            id: `gh-${issue.number}-reply-${latestComment.id}`,
            taskType: "fix",
            title: `Re: ${issue.title}`,
            description,
            source: replySource,
            priority: 3,
            dependsOn: null,
            parentTaskId: null,
          });

        } catch {
          // 個別 Issue のコメント取得失敗は非致命的
        }
      }

      this.lastCommentCheck = new Date().toISOString();
    } catch {
      // API エラーは非致命的
    }
  }

  async pollIssues(): Promise<void> {
    try {
      const { data: issues } = await this.octokit.issues.listForRepo({
        owner: this.owner,
        repo: this.repo,
        state: "open",
      });

      for (const issue of issues) {
        // PRはスキップ（GitHub APIはPRもissueとして返す）
        if ("pull_request" in issue) continue;

        const source = `github_issue:${issue.number}`;
        if (this.queue.isDuplicate(source)) continue;

        const labels = issue.labels.map((l) => l.name);
        const classification = await this.classifier.classify({
          number: issue.number,
          title: issue.title,
          body: issue.body ?? "",
          labels,
        });

        if (classification.complexity === "single") {
          this.queue.push({
            id: `gh-${issue.number}-0`,
            taskType: classification.taskType,
            title: issue.title,
            description: issue.body ?? issue.title,
            source,
            priority: 5,
            dependsOn: null,
            parentTaskId: null,
          });
        } else if (classification.complexity === "pipeline") {
          const tasks = classification.subTasks.map((sub, i) => ({
            id: `gh-${issue.number}-${i}`,
            taskType: sub.taskType,
            title: sub.title,
            description: sub.description,
            source: i === 0 ? source : `${source}:${i}`,
            priority: 5,
            dependsOn: sub.dependsOnIndex !== null ? `gh-${issue.number}-${sub.dependsOnIndex}` : null,
            parentTaskId: `gh-${issue.number}-0`,
          }));
          this.queue.pushPipeline(tasks);
        }
        // unclear → comment already posted by classifier
      }
    } catch {
      // GitHub API errors are logged but not thrown (FR-001a)
    }
  }

  async pollApprovals(): Promise<void> {
    const awaiting = this.queue.getAwaitingApproval();
    if (awaiting.length === 0) return;

    for (const task of awaiting) {
      if (!task.approvalPrUrl) continue;

      try {
        const prNumber = this.extractPrNumber(task.approvalPrUrl);
        if (!prNumber) continue;

        // Check if PR is closed
        const { data: pr } = await this.octokit.pulls.get({
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
        });

        if (pr.state === "closed" && !pr.merged) {
          this.queue.rejectTask(task.id);
          continue;
        }

        // Check reviews
        const { data: reviews } = await this.octokit.pulls.listReviews({
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
        });

        const approved = reviews.some((r) => r.state === "APPROVED");
        if (approved) {
          this.queue.approveTask(task.id);
        }
      } catch {
        // PR API errors are logged but not thrown
      }
    }
  }

  private extractPrNumber(url: string): number | null {
    const match = /\/pull\/(\d+)/.exec(url);
    return match ? Number(match[1]) : null;
  }
}
