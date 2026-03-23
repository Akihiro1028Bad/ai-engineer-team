import { Classifier } from "../agents/classifier.js";
import type { TaskQueue } from "../queue/task-queue.js";

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: { name: string }[];
  state: string;
}

interface OctokitLike {
  issues: {
    listForRepo: (params: {
      owner: string;
      repo: string;
      labels?: string;
      state: string;
    }) => Promise<{ data: GitHubIssue[] }>;
    createComment: (params: {
      owner: string;
      repo: string;
      issue_number: number;
      body: string;
    }) => Promise<unknown>;
    listComments: (params: {
      owner: string;
      repo: string;
      issue_number: number;
    }) => Promise<{ data: { body: string; user: { login: string } | null }[] }>;
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

  constructor(
    private readonly octokit: OctokitLike,
    private readonly queue: TaskQueue,
    private readonly owner: string,
    private readonly repo: string,
  ) {
    this.classifier = new Classifier(octokit, owner, repo);
  }

  /** Issue に PR リンク通知をコメント投稿する */
  async postResultToIssue(taskId: string, message: string): Promise<void> {
    const match = /^gh-(\d+)-/.exec(taskId);
    if (!match) return;
    const issueNumber = Number(match[1]);

    try {
      await this.octokit.issues.createComment({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        body: `🤖 **AI Agent Orchestrator** (Task: \`${taskId}\`)\n\n${message}`,
      });
    } catch {
      // コメント投稿失敗は非致命的
    }
  }

  /** 全 open Issue をポーリングし、未処理の Issue をタスクキューに投入する */
  async pollIssues(): Promise<void> {
    try {
      const { data: issues } = await this.octokit.issues.listForRepo({
        owner: this.owner,
        repo: this.repo,
        state: "open",
      });

      for (const issue of issues) {
        if ("pull_request" in issue) continue;

        const source = `github_issue:${issue.number}`;
        if (this.queue.isDuplicate(source)) continue;

        const labels = issue.labels.map((l) => l.name);
        const result = await this.classifier.classify({
          number: issue.number,
          title: issue.title,
          body: issue.body ?? "",
          labels,
        });

        // 各スコープごとに独立パイプラインを作成
        for (const { scopeId, classification } of result.pipelines) {
          if (classification.complexity !== "pipeline") continue;

          const prefix = result.pipelines.length > 1
            ? `gh-${issue.number}-${scopeId}`
            : `gh-${issue.number}`;

          const tasks = classification.subTasks.map((sub, i) => ({
            id: `${prefix}-${i}`,
            taskType: sub.taskType,
            title: sub.title,
            description: sub.description,
            source: i === 0 ? source : `${source}:${scopeId}:${i}`,
            priority: 5,
            dependsOn: sub.dependsOnIndex !== null ? `${prefix}-${sub.dependsOnIndex}` : null,
            parentTaskId: `${prefix}-0`,
          }));
          this.queue.pushPipeline(tasks);
        }
      }
    } catch {
      // GitHub API エラーはログのみ
    }
  }

  /** awaiting_approval の設計 PR の approve/reject を監視する */
  async pollApprovals(): Promise<void> {
    const awaiting = this.queue.getAwaitingApproval();
    if (awaiting.length === 0) return;

    for (const task of awaiting) {
      if (!task.approvalPrUrl) continue;

      try {
        const prNumber = this.extractPrNumber(task.approvalPrUrl);
        if (!prNumber) continue;

        const { data: pr } = await this.octokit.pulls.get({
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
        });

        if (pr.state === "closed" && !pr.merged) {
          this.queue.rejectTask(task.id);
          continue;
        }

        const { data: reviews } = await this.octokit.pulls.listReviews({
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
        });

        const approvedByReview = reviews.some((r) => r.state === "APPROVED");

        // コメントによる承認も検出（自分の PR を自分で approve できないため）
        let approvedByComment = false;
        let rejectedByComment = false;
        try {
          const { data: comments } = await this.octokit.issues.listComments({
            owner: this.owner,
            repo: this.repo,
            issue_number: prNumber,
          });

          const APPROVE_KEYWORDS = ["承認", "lgtm", "approve", "approved", "ok", "実装開始", "進めてください"];
          const REJECT_KEYWORDS = ["却下", "reject", "やり直し", "修正してください"];
          const botMarker = "🤖";

          for (const comment of comments) {
            // bot のコメントは無視
            if (comment.body.includes(botMarker)) continue;

            const lower = comment.body.toLowerCase().trim();
            if (APPROVE_KEYWORDS.some((kw) => lower.includes(kw))) {
              approvedByComment = true;
            }
            if (REJECT_KEYWORDS.some((kw) => lower.includes(kw))) {
              rejectedByComment = true;
            }
          }
        } catch {
          // コメント取得失敗は非致命的
        }

        if (rejectedByComment) {
          this.queue.rejectTask(task.id);
        } else if (approvedByReview || approvedByComment) {
          this.queue.approveTask(task.id);
        }
      } catch {
        // PR API エラーはログのみ
      }
    }
  }

  private extractPrNumber(url: string): number | null {
    const match = /\/pull\/(\d+)/.exec(url);
    return match ? Number(match[1]) : null;
  }
}
