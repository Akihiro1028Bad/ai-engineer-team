import { Classifier } from "../agents/classifier.js";
import type { TaskQueue } from "../queue/task-queue.js";
import type { Dispatcher } from "../agents/dispatcher.js";
import { getAgentConfig } from "../agents/agent-config.js";

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
    listReviewComments: (params: {
      owner: string;
      repo: string;
      pull_number: number;
    }) => Promise<{ data: { body: string; user: { login: string } | null }[] }>;
    get: (params: {
      owner: string;
      repo: string;
      pull_number: number;
    }) => Promise<{ data: { state: string; merged: boolean; head: { ref: string } } }>;
  };
  reactions: {
    createForIssue: (params: {
      owner: string;
      repo: string;
      issue_number: number;
      content: string;
    }) => Promise<unknown>;
  };
}

function isBot(comment: { body: string; user: { login: string } | null }): boolean {
  const login = comment.user?.login?.toLowerCase() ?? "";
  if (!login) return true; // null user = GitHub App
  const BOT_LOGINS = ["vercel", "github-actions", "dependabot", "renovate"];
  if (login.includes("bot") || login.includes("[bot]") || BOT_LOGINS.includes(login)) return true;
  if (comment.body.includes("🤖")) return true;
  if (comment.body.startsWith("[vc]:")) return true;
  if (comment.body.startsWith("@claude")) return true;
  if (comment.body.startsWith("**Claude")) return true;
  return false;
}

export class GitHubPoller {
  private readonly classifier: Classifier;

  constructor(
    private readonly octokit: OctokitLike,
    private readonly queue: TaskQueue,
    private readonly owner: string,
    private readonly repo: string,
    private readonly dispatcher?: Dispatcher,
  ) {
    this.classifier = new Classifier(octokit, owner, repo);
  }

  /** Issue にリアクション（スタンプ）を付ける */
  async reactToIssue(taskId: string, reaction: "eyes" | "rocket" | "+1" | "-1" | "confused" | "heart"): Promise<void> {
    const match = /^gh-(\d+)/.exec(taskId);
    if (!match) return;
    const issueNumber = Number(match[1]);
    try {
      await this.octokit.reactions.createForIssue({
        owner: this.owner, repo: this.repo, issue_number: issueNumber, content: reaction,
      });
    } catch { /* non-critical */ }
  }

  /** Issue に通知コメントを投稿する */
  async postResultToIssue(taskId: string, message: string): Promise<void> {
    const match = /^gh-(\d+)-/.exec(taskId);
    if (!match) return;
    const issueNumber = Number(match[1]);
    try {
      await this.octokit.issues.createComment({
        owner: this.owner, repo: this.repo, issue_number: issueNumber,
        body: `🤖 **AI Agent Orchestrator** (Task: \`${taskId}\`)\n\n${message}`,
      });
    } catch { /* non-critical */ }
  }

  /** 全 open Issue をポーリングし、未処理の Issue をタスクキューに投入する */
  async pollIssues(): Promise<void> {
    try {
      const { data: issues } = await this.octokit.issues.listForRepo({
        owner: this.owner, repo: this.repo, state: "open",
      });

      for (const issue of issues) {
        if ("pull_request" in issue) continue;

        const source = `github_issue:${issue.number}`;
        if (this.queue.isDuplicate(source)) continue;

        const labels = issue.labels.map((l) => l.name);
        const result = await this.classifier.classify({
          number: issue.number, title: issue.title, body: issue.body ?? "", labels,
        });

        // 👀 Issue 検出リアクション
        try {
          await this.octokit.reactions.createForIssue({
            owner: this.owner, repo: this.repo, issue_number: issue.number, content: "eyes",
          });
        } catch { /* non-critical */ }

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

  /**
   * awaiting_approval の設計 PR を監視する（一元化）
   * - 「承認」→ approve → fix タスク開始
   * - 「却下」→ reject → キャンセル
   * - それ以外の人間コメント → Dispatcher で直接 design.md 修正 → PR にコメント
   */
  async pollApprovals(): Promise<void> {
    const awaiting = this.queue.getAwaitingApproval();
    if (awaiting.length === 0) return;

    for (const task of awaiting) {
      if (!task.approvalPrUrl) continue;

      try {
        const prNumber = this.extractPrNumber(task.approvalPrUrl);
        if (!prNumber) continue;

        // PR の状態確認
        const { data: pr } = await this.octokit.pulls.get({
          owner: this.owner, repo: this.repo, pull_number: prNumber,
        });

        if (pr.state === "closed" && !pr.merged) {
          this.queue.rejectTask(task.id);
          continue;
        }

        // GitHub Review API で APPROVED チェック
        const { data: reviews } = await this.octokit.pulls.listReviews({
          owner: this.owner, repo: this.repo, pull_number: prNumber,
        });
        const approvedByReview = reviews.some((r) => r.state === "APPROVED");

        if (approvedByReview) {
          this.queue.approveTask(task.id);
          continue;
        }

        // コメントから承認/却下/フィードバックを判定
        const action = await this.detectCommentAction(prNumber);

        if (action.type === "approve") {
          this.queue.approveTask(task.id);
        } else if (action.type === "reject") {
          this.queue.rejectTask(task.id);
        } else if (action.type === "feedback" && action.comment) {
          // フィードバック → 直接 Dispatcher で design.md を修正（タスクキューを介さない）
          await this.handleFeedbackDirectly(task.id, prNumber, pr.head.ref, action.comment);
        }
      } catch {
        // PR API エラーはログのみ
      }
    }
  }

  /** PR のコメント（通常+レビュー）から人間の最新アクションを判定 */
  private async detectCommentAction(prNumber: number): Promise<
    { type: "approve" } | { type: "reject" } | { type: "feedback"; comment: string } | { type: "none" }
  > {
    try {
      const { data: issueComments } = await this.octokit.issues.listComments({
        owner: this.owner, repo: this.repo, issue_number: prNumber,
      });

      let reviewComments: { body: string; user: { login: string } | null }[] = [];
      try {
        const { data: rc } = await this.octokit.pulls.listReviewComments({
          owner: this.owner, repo: this.repo, pull_number: prNumber,
        });
        reviewComments = rc;
      } catch { /* non-critical */ }

      const allComments = [...issueComments, ...reviewComments];

      // 承認/却下は最優先で検出（全コメントをスキャン）
      let hasApprove = false;
      let hasReject = false;
      let latestFeedback = "";

      for (const comment of allComments) {
        if (isBot(comment)) continue;

        const body = comment.body.trim();
        if (body === "承認") {
          hasApprove = true;
        } else if (body === "却下") {
          hasReject = true;
        } else if (body.length > 0) {
          latestFeedback = body;
        }
      }

      // 承認/却下が優先（どちらもあれば承認が勝つ）
      if (hasApprove) return { type: "approve" };
      if (hasReject) return { type: "reject" };

      // フィードバックがある場合（既に処理済みでないか確認）
      if (latestFeedback) {
        const feedbackKey = `feedback:${prNumber}:${latestFeedback.slice(0, 50)}`;
        if (!this.queue.isDuplicate(feedbackKey)) {
          return { type: "feedback", comment: latestFeedback };
        }
      }

      return { type: "none" };
    } catch {
      return { type: "none" };
    }
  }

  /** フィードバックを直接 Dispatcher で処理（タスクキューを介さない） */
  private async handleFeedbackDirectly(
    taskId: string,
    prNumber: number,
    prBranch: string,
    feedback: string,
  ): Promise<void> {
    if (!this.dispatcher) return;

    // フィードバック処理済みフラグを記録
    const feedbackKey = `feedback:${prNumber}:${feedback.slice(0, 50)}`;
    this.queue.push({
      id: `${taskId}-fb-${Date.now()}`,
      taskType: "review",
      title: `[feedback-marker] PR #${prNumber}`,
      description: "フィードバック処理済みマーカー（実行不要）",
      source: feedbackKey,
      priority: 10,
      dependsOn: null,
      parentTaskId: null,
    });
    // マーカータスクを即座に完了
    this.queue.updateStatus(`${taskId}-fb-${Date.now()}`, "completed");

    // 👀 リアクション
    try {
      await this.octokit.reactions.createForIssue({
        owner: this.owner, repo: this.repo, issue_number: prNumber, content: "eyes",
      });
    } catch { /* non-critical */ }

    // Reviewer (Opus) で design.md を修正
    const config = getAgentConfig("reviewer");
    const issueMatch = /^gh-(\d+)-/.exec(taskId);
    const issueNumber = issueMatch ? issueMatch[1]! : "unknown";

    const feedbackTask = {
      id: taskId,
      taskType: "review" as const,
      title: `[設計修正] PR #${prNumber}`,
      description: [
        `PR #${prNumber} の設計書に対してフィードバックがありました。`,
        "",
        "## フィードバック内容",
        feedback,
        "",
        "## 指示",
        `1. specs/issue-${issueNumber}/design.md を読む`,
        "2. フィードバックの内容を反映して design.md を更新する",
        "3. 新しいファイルは作成せず、既存の design.md を直接修正してください",
      ].join("\n"),
      source: feedbackKey,
      priority: 1,
      status: "in_progress" as const,
      result: null,
      costUsd: 0,
      turnsUsed: 0,
      retryCount: 0,
      dependsOn: null,
      parentTaskId: null,
      contextFile: null,
      approvalPrUrl: null,
      prNumber: null,
      ciFixCount: 0,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: null,
    };

    const result = await this.dispatcher.dispatch(feedbackTask, config, prBranch);

    if (result.pushed) {
      // PR にコメント + @claude /review
      try {
        await this.octokit.issues.createComment({
          owner: this.owner, repo: this.repo, issue_number: prNumber,
          body: `🤖 **AI Agent Orchestrator**\n\n✏️ フィードバックを反映して設計書を修正しました。再度ご確認ください。\n\n変更を確認後、「承認」とコメントしてください。`,
        });
        await this.octokit.issues.createComment({
          owner: this.owner, repo: this.repo, issue_number: prNumber,
          body: "@claude /review",
        });
      } catch { /* non-critical */ }
    } else {
      // 修正失敗 → PR にコメント
      try {
        await this.octokit.issues.createComment({
          owner: this.owner, repo: this.repo, issue_number: prNumber,
          body: `🤖 **AI Agent Orchestrator**\n\n⚠️ フィードバックの反映に失敗しました。\n\n${result.error ?? ""}`,
        });
      } catch { /* non-critical */ }
    }
  }

  private extractPrNumber(url: string): number | null {
    const match = /\/pull\/(\d+)/.exec(url);
    return match ? Number(match[1]) : null;
  }
}
