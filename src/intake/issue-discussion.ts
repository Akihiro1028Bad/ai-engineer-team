import type pino from "pino";

interface OctokitLike {
  issues: {
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
    }) => Promise<{ data: { body: string; user: { login: string; type?: string } | null; created_at: string }[] }>;
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

/** Issue ディスカッション状態を管理するストア */
export interface DiscussionState {
  issueNumber: number;
  roundCount: number;
  lastQuestionAt: string;
  status: "waiting_answer" | "answered" | "timed_out" | "resolved";
  questions: string[];
  answers: string[];
}

/** ディスカッション設定 */
const MAX_ROUNDS = 3;
const TIMEOUT_DAYS = 7;

function isBot(comment: { body: string; user: { login: string; type?: string } | null }): boolean {
  if (comment.user?.type === "Bot") return true;
  const login = comment.user?.login.toLowerCase() ?? "";
  if (!login) return true;
  if (login.includes("[bot]")) return true;
  const BOT_LOGINS = ["vercel", "github-actions", "dependabot", "renovate"];
  if (login.includes("bot") || BOT_LOGINS.includes(login)) return true;
  return false;
}

export class IssueDiscussion {
  /** issueNumber → DiscussionState */
  private readonly discussions = new Map<number, DiscussionState>();

  constructor(
    private readonly octokit: OctokitLike,
    private readonly owner: string,
    private readonly repo: string,
    private readonly logger: pino.Logger,
  ) {}

  /** 不明確な Issue に対して質問を投稿する */
  async askClarification(
    issueNumber: number,
    questions: string[],
  ): Promise<DiscussionState> {
    const existing = this.discussions.get(issueNumber);
    if (existing && existing.roundCount >= MAX_ROUNDS) {
      this.logger.info({ issueNumber }, "Max discussion rounds reached");
      return { ...existing, status: "timed_out" };
    }

    const roundCount = (existing?.roundCount ?? 0) + 1;

    // 🤔 リアクション
    try {
      await this.octokit.reactions.createForIssue({
        owner: this.owner, repo: this.repo,
        issue_number: issueNumber, content: "confused",
      });
    } catch { /* non-critical */ }

    // 質問をコメントとして投稿
    const body = [
      "🤖 **AI Agent Orchestrator** — 確認事項",
      "",
      "この Issue を処理するにあたり、以下の点を確認させてください。",
      "",
      ...questions.map((q, i) => `${i + 1}. ${q}`),
      "",
      `---`,
      `💡 コメントで回答いただければ、自動的に処理を再開します。（${roundCount}/${MAX_ROUNDS} 回目）`,
    ].join("\n");

    await this.octokit.issues.createComment({
      owner: this.owner, repo: this.repo,
      issue_number: issueNumber, body,
    });

    const state: DiscussionState = {
      issueNumber,
      roundCount,
      lastQuestionAt: new Date().toISOString(),
      status: "waiting_answer",
      questions: [...(existing?.questions ?? []), ...questions],
      answers: existing?.answers ?? [],
    };
    this.discussions.set(issueNumber, state);
    this.logger.info({ issueNumber, roundCount }, "Clarification question posted");
    return state;
  }

  /** 待機中の Issue に対して回答がないかチェックする */
  async checkForAnswers(issueNumber: number): Promise<DiscussionState | null> {
    const state = this.discussions.get(issueNumber);
    if (!state || state.status !== "waiting_answer") return null;

    // タイムアウトチェック
    const lastQuestionTime = new Date(state.lastQuestionAt).getTime();
    const timeoutMs = TIMEOUT_DAYS * 24 * 60 * 60 * 1000;
    if (Date.now() - lastQuestionTime > timeoutMs) {
      state.status = "timed_out";
      this.discussions.set(issueNumber, state);
      this.logger.info({ issueNumber }, "Discussion timed out");
      return state;
    }

    // 最新コメントを取得
    try {
      const { data: comments } = await this.octokit.issues.listComments({
        owner: this.owner, repo: this.repo, issue_number: issueNumber,
      });

      // 最後の質問以降の人間コメントを探す
      const humanAnswers = comments.filter((c) => {
        if (isBot(c)) return false;
        const commentTime = new Date(c.created_at).getTime();
        return commentTime > lastQuestionTime;
      });

      if (humanAnswers.length > 0) {
        state.answers.push(...humanAnswers.map((c) => c.body));
        state.status = "answered";
        this.discussions.set(issueNumber, state);
        this.logger.info({ issueNumber, answerCount: humanAnswers.length }, "Received answers");
        return state;
      }
    } catch {
      this.logger.warn({ issueNumber }, "Failed to check comments for discussion");
    }

    return state;
  }

  /** ディスカッション状態を取得 */
  getState(issueNumber: number): DiscussionState | undefined {
    return this.discussions.get(issueNumber);
  }

  /** ディスカッションを解決済みにする */
  resolve(issueNumber: number): void {
    const state = this.discussions.get(issueNumber);
    if (state) {
      state.status = "resolved";
      this.discussions.set(issueNumber, state);
    }
  }

  /** 待機中のディスカッション一覧 */
  getPendingDiscussions(): DiscussionState[] {
    return [...this.discussions.values()].filter((s) => s.status === "waiting_answer");
  }
}
