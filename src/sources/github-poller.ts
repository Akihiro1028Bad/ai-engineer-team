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
  reactions: {
    createForIssue: (params: {
      owner: string;
      repo: string;
      issue_number: number;
      content: string;
    }) => Promise<unknown>;
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

  /** Issue にリアクション（スタンプ）を付ける */
  async reactToIssue(taskId: string, reaction: "eyes" | "rocket" | "+1" | "-1" | "confused" | "heart"): Promise<void> {
    const match = /^gh-(\d+)/.exec(taskId);
    if (!match) return;
    const issueNumber = Number(match[1]);

    try {
      await this.octokit.reactions.createForIssue({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber,
        content: reaction,
      });
    } catch {
      // リアクション失敗は非致命的
    }
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

  /** Issue・PR の全コメントを監視し、リアクション + 返信タスクを投入する */
  async pollAllComments(): Promise<void> {
    try {
      // awaiting_approval の PR 番号を取得（これらは pollApprovals が担当）
      const awaitingTasks = this.queue.getAwaitingApproval();
      const awaitingPrNumbers = new Set(
        awaitingTasks
          .map((t) => t.approvalPrUrl ? this.extractPrNumber(t.approvalPrUrl) : null)
          .filter((n): n is number => n !== null),
      );

      const { data: issues } = await this.octokit.issues.listForRepo({
        owner: this.owner,
        repo: this.repo,
        state: "open",
      });

      for (const issue of issues) {
        // awaiting_approval の PR はスキップ（pollApprovals が承認/却下を処理）
        if (awaitingPrNumbers.has(issue.number)) continue;

        try {
          const { data: issueComments } = await this.octokit.issues.listComments({
            owner: this.owner,
            repo: this.repo,
            issue_number: issue.number,
          });
          // PR の場合はレビューコメントも取得
          let reviewComments: { body: string; user: { login: string } | null }[] = [];
          if ("pull_request" in issue) {
            try {
              const { data: rc } = await this.octokit.pulls.listReviewComments({
                owner: this.owner,
                repo: this.repo,
                pull_number: issue.number,
              });
              reviewComments = rc;
            } catch { /* non-critical */ }
          }
          const comments = [...issueComments, ...reviewComments];

          for (const comment of comments) {
            // --- bot フィルタ（ユーザー名ベース） ---
            const login = comment.user?.login?.toLowerCase() ?? "";
            const BOT_LOGINS = ["vercel", "github-actions", "dependabot", "renovate"];
            const isBot = login.includes("bot") || login.includes("[bot]") || BOT_LOGINS.includes(login);
            if (isBot) continue;

            // --- コンテンツフィルタ ---
            if (comment.body.includes("🤖")) continue;           // AI Agent Orchestrator 自身
            if (comment.body.startsWith("@claude")) continue;    // Claude Code コマンド
            if (comment.body.startsWith("[vc]:")) continue;      // Vercel プレビュー

            // 既に処理済みか確認
            const commentSource = `github_comment:${issue.number}:${comment.body.slice(0, 50)}`;
            if (this.queue.isDuplicate(commentSource)) continue;

            // 👀 リアクション
            try {
              await this.octokit.reactions.createForIssue({
                owner: this.owner,
                repo: this.repo,
                issue_number: issue.number,
                content: "eyes",
              });
            } catch { /* リアクション重複は無視 */ }

            // Issue の全コメント履歴を構築
            const allComments = comments
              .map((c) => `[${c.user?.login ?? "unknown"}]: ${c.body}`)
              .join("\n\n---\n\n");

            // 返信タスクを投入
            this.queue.push({
              id: `gh-${issue.number}-reply-${Date.now()}`,
              taskType: "fix",
              title: `Re: ${issue.title}`,
              description: [
                `## Issue #${issue.number}: ${issue.title}`,
                "",
                issue.body ?? "",
                "",
                "## コメント履歴",
                "",
                allComments,
                "",
                "## タスク",
                "上記のコメント履歴を踏まえて、適切に返信してください。",
                "質問に回答するか、調査結果を報告するか、修正提案をしてください。",
              ].join("\n"),
              source: commentSource,
              priority: 3,
              dependsOn: null,
              parentTaskId: null,
            });
          }
        } catch {
          // 個別 Issue のコメント取得失敗は非致命的
        }
      }
    } catch {
      // API エラーは非致命的
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

        // 👀 Issue 検出リアクション
        try {
          await this.octokit.reactions.createForIssue({
            owner: this.owner,
            repo: this.repo,
            issue_number: issue.number,
            content: "eyes",
          });
        } catch { /* non-critical */ }

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
        // 最後の人間コメントで判定: 「承認」「却下」またはフィードバック
        let lastHumanAction: "approve" | "reject" | "feedback" | null = null;
        let lastFeedbackComment = "";
        try {
          // Issue/PR コメント + PR レビューコメントの両方を取得
          const { data: issueComments } = await this.octokit.issues.listComments({
            owner: this.owner,
            repo: this.repo,
            issue_number: prNumber,
          });
          let reviewComments: { body: string; user: { login: string } | null }[] = [];
          try {
            const { data: rc } = await this.octokit.pulls.listReviewComments({
              owner: this.owner,
              repo: this.repo,
              pull_number: prNumber,
            });
            reviewComments = rc;
          } catch { /* PR review comments 取得失敗は非致命的 */ }

          const allComments = [...issueComments, ...reviewComments];

          const botMarker = "🤖";
          const humanComments: string[] = [];

          for (const comment of allComments) {
            // bot / GitHub App のコメントは無視
            if (comment.body.includes(botMarker)) continue;
            if (comment.body.startsWith("[vc]:")) continue;
            if (comment.body.startsWith("@claude")) continue;
            if (comment.body.startsWith("**Claude")) continue;

            const login = comment.user?.login?.toLowerCase() ?? "";
            if (!login) continue;
            const BOT_LOGINS = ["vercel", "github-actions", "dependabot", "renovate"];
            if (login.includes("bot") || login.includes("[bot]") || BOT_LOGINS.includes(login)) continue;

            humanComments.push(comment.body.trim());
          }

          // 最後の人間コメントで判定
          const lastComment = humanComments.length > 0 ? humanComments[humanComments.length - 1]! : "";
          if (lastComment === "承認") {
            lastHumanAction = "approve";
          } else if (lastComment === "却下") {
            lastHumanAction = "reject";
          } else if (lastComment.length > 0) {
            lastHumanAction = "feedback";
            lastFeedbackComment = lastComment;
          }
        } catch {
          // コメント取得失敗は非致命的
        }

        if (lastHumanAction === "reject") {
          this.queue.rejectTask(task.id);
        } else if (approvedByReview || lastHumanAction === "approve") {
          this.queue.approveTask(task.id);
        } else if (lastHumanAction === "feedback" && lastFeedbackComment) {
          // フィードバック → Reviewer が設計書を修正して再コミット
          await this.handleDesignFeedback(task.id, prNumber, lastFeedbackComment);
        }
      } catch {
        // PR API エラーはログのみ
      }
    }
  }

  /** フィードバックに基づいて設計書を修正するタスクを投入する */
  private async handleDesignFeedback(taskId: string, prNumber: number, feedback: string): Promise<void> {
    const feedbackSource = `design_feedback:${taskId}:${feedback.slice(0, 50)}`;
    if (this.queue.isDuplicate(feedbackSource)) return;

    // PR のブランチ名を取得
    let prBranch = "";
    try {
      const { data: pr } = await this.octokit.pulls.get({
        owner: this.owner,
        repo: this.repo,
        pull_number: prNumber,
      });
      prBranch = (pr as unknown as { head: { ref: string } }).head.ref;
    } catch { /* non-critical */ }

    // 設計書修正タスクを投入（Reviewer/Opus が修正）
    this.queue.push({
      id: `${taskId}-feedback-${Date.now()}`,
      taskType: "review",
      title: `[設計修正] PR #${prNumber} のフィードバック対応`,
      description: [
        `PR #${prNumber} の設計書に対してフィードバックがありました。設計書を修正してください。`,
        "",
        prBranch ? `**既存ブランチ**: \`${prBranch}\`（このブランチ上で修正してください）` : "",
        "",
        "## フィードバック内容",
        feedback,
        "",
        "## 指示",
        "1. 既存の design.md を読む",
        "2. フィードバックの内容を反映して design.md を更新する",
        "3. 修正内容をコミットする",
        "",
        "新しいファイルは作成せず、既存の design.md を直接修正してください。",
      ].join("\n"),
      source: feedbackSource,
      priority: 2,
      dependsOn: null,
      parentTaskId: null,
    });

    // PR にリアクション
    try {
      await this.octokit.reactions.createForIssue({
        owner: this.owner,
        repo: this.repo,
        issue_number: prNumber,
        content: "eyes",
      });
    } catch { /* non-critical */ }
  }

  private extractPrNumber(url: string): number | null {
    const match = /\/pull\/(\d+)/.exec(url);
    return match ? Number(match[1]) : null;
  }
}
