import type pino from "pino";

import type { AgentConfigV3 } from "../types.js";
import { getAgentConfigV3 } from "../agents/agent-config.js";
import type { WorktreeManager } from "../agents/worktree-manager.js";

interface ReviewComment {
  id: number;
  body: string;
  path?: string;
  line?: number;
  user: { login: string } | null;
  diff_hunk?: string;
  in_reply_to_id?: number;
}

interface OctokitLike {
  pulls: {
    listReviewComments: (params: {
      owner: string;
      repo: string;
      pull_number: number;
    }) => Promise<{ data: ReviewComment[] }>;
    createReviewComment: (params: {
      owner: string;
      repo: string;
      pull_number: number;
      body: string;
      commit_id?: string;
      path?: string;
      line?: number;
      in_reply_to?: number;
    }) => Promise<unknown>;
  };
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
    }) => Promise<{ data: { body: string; user: { login: string } | null }[] }>;
  };
}

/** コメントの分類結果 */
interface ClassifiedComment {
  type: "fix" | "question" | "suggestion" | "approval" | "ignore";
  comment: ReviewComment;
  instruction: string;
}

/** PR レビューコメントの最大対応回数 */
const MAX_ITERATIONS = 5;

function isBot(comment: { user: { login: string } | null }): boolean {
  const login = comment.user?.login?.toLowerCase() ?? "";
  if (!login) return true;
  return login.includes("bot") || login.includes("[bot]");
}

/**
 * PR レビューコメント自動対応。
 * - fix: Implementer で修正→コミット→プッシュ
 * - question: design.md コンテキストから回答
 * - suggestion: GitHub suggestion を自動適用
 */
export class PRReviewResponder {
  private readonly iterationCount = new Map<number, number>();

  constructor(
    private readonly octokit: OctokitLike,
    private readonly worktreeManager: WorktreeManager,
    private readonly owner: string,
    private readonly repo: string,
    private readonly logger: pino.Logger,
  ) {}

  /** PR のレビューコメントを確認し、未対応のコメントを処理する */
  async processReviewComments(
    prNumber: number,
    branch: string,
    _issueNumber: number,
  ): Promise<{ processed: number; skipped: number }> {
    const iterations = this.iterationCount.get(prNumber) ?? 0;
    if (iterations >= MAX_ITERATIONS) {
      this.logger.info({ prNumber, iterations }, "Max review response iterations reached");
      return { processed: 0, skipped: 0 };
    }

    // レビューコメント取得
    const { data: reviewComments } = await this.octokit.pulls.listReviewComments({
      owner: this.owner, repo: this.repo, pull_number: prNumber,
    });

    // 既に返信済みのコメントを除外
    const { data: issueComments } = await this.octokit.issues.listComments({
      owner: this.owner, repo: this.repo, issue_number: prNumber,
    });
    const repliedIds = new Set(
      issueComments
        .filter((c) => c.body.includes("🤖") && c.body.includes("対応済み"))
        .map((c) => {
          const match = /comment-(\d+)/.exec(c.body);
          return match ? Number(match[1]) : null;
        })
        .filter((id): id is number => id !== null),
    );

    // 未対応の人間コメントを分類
    const unprocessed = reviewComments.filter((c) => !isBot(c) && !repliedIds.has(c.id));
    const classified = unprocessed.map((c) => this.classifyComment(c));

    let processed = 0;
    let skipped = 0;

    for (const item of classified) {
      if (item.type === "ignore" || item.type === "approval") {
        skipped++;
        continue;
      }

      try {
        if (item.type === "fix") {
          await this.handleFixRequest(prNumber, branch, item);
        } else if (item.type === "question") {
          await this.handleQuestion(prNumber, item);
        } else if (item.type === "suggestion") {
          await this.handleSuggestion(prNumber, branch, item);
        }
        processed++;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : "unknown error";
        this.logger.warn({ prNumber, commentId: item.comment.id, error: msg }, "Failed to process review comment");
        skipped++;
      }
    }

    if (processed > 0) {
      this.iterationCount.set(prNumber, iterations + 1);
    }

    return { processed, skipped };
  }

  /** コメントを分類する */
  private classifyComment(comment: ReviewComment): ClassifiedComment {
    const body = comment.body.trim().toLowerCase();

    // GitHub suggestion ブロック
    if (comment.body.includes("```suggestion")) {
      return { type: "suggestion", comment, instruction: comment.body };
    }

    // 承認系
    if (body === "lgtm" || body === "承認" || body === "approved") {
      return { type: "approval", comment, instruction: "" };
    }

    // 質問系
    const questionPatterns = [/なぜ/, /どうして/, /why/, /\?$/, /理由/, /意図/];
    if (questionPatterns.some((p) => p.test(body))) {
      return { type: "question", comment, instruction: comment.body };
    }

    // 修正指示（デフォルト）
    return { type: "fix", comment, instruction: comment.body };
  }

  /** 修正リクエストを Implementer で処理 */
  private async handleFixRequest(
    prNumber: number,
    branch: string,
    item: ClassifiedComment,
  ): Promise<void> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const config = getAgentConfigV3("implementer");

    const prompt = [
      "PR レビューコメントへの対応を行ってください。",
      "",
      `## レビューコメント`,
      item.comment.path ? `ファイル: ${item.comment.path}` : "",
      item.comment.line ? `行: ${item.comment.line}` : "",
      "",
      item.instruction,
      "",
      "## 指示",
      "1. 指摘された問題を修正してください",
      "2. テストが通ることを確認してください",
      "3. 最小限の変更に留めてください",
    ].filter(Boolean).join("\n");

    const taskId = `pr-review-${prNumber}`;
    const cwd = this.worktreeManager.prepareExistingBranch(taskId, branch);

    for await (const message of query({
      prompt,
      options: {
        allowedTools: [...config.allowedTools],
        permissionMode: config.permissionMode,
        maxTurns: 20,
        maxBudgetUsd: 0.50,
        model: config.model,
        systemPrompt: config.systemPrompt,
        cwd,
      },
    }) as AsyncIterable<{ type: string }>) {
      if (message.type === "result") break;
    }

    // コミット＆プッシュ
    const commitMessage = `fix: address review comment on ${item.comment.path ?? "PR"} (#${prNumber})`;
    this.worktreeManager.commitAndPush(`pr-review-${prNumber}`, commitMessage);

    // 対応済みコメント
    await this.octokit.issues.createComment({
      owner: this.owner, repo: this.repo, issue_number: prNumber,
      body: `🤖 **AI Agent** — レビューコメント (comment-${item.comment.id}) に対応しました。修正をプッシュしました。`,
    });

    this.logger.info({ prNumber, commentId: item.comment.id }, "Fix applied for review comment");
  }

  /** 質問に回答する */
  private async handleQuestion(
    prNumber: number,
    item: ClassifiedComment,
  ): Promise<void> {
    // 簡易回答（将来的には design.md コンテキストを参照）
    await this.octokit.issues.createComment({
      owner: this.owner, repo: this.repo, issue_number: prNumber,
      body: [
        `🤖 **AI Agent** — 質問への回答 (comment-${item.comment.id})`,
        "",
        `> ${item.comment.body.split("\n")[0]}`,
        "",
        "設計書に基づいた回答を準備中です。詳細は design.md をご参照ください。",
      ].join("\n"),
    });

    this.logger.info({ prNumber, commentId: item.comment.id }, "Question acknowledged");
  }

  /** GitHub Suggestion を適用する */
  private async handleSuggestion(
    prNumber: number,
    branch: string,
    item: ClassifiedComment,
  ): Promise<void> {
    // suggestion ブロックの内容を抽出
    const sugMatch = /```suggestion\n([\s\S]*?)```/.exec(item.comment.body);
    if (!sugMatch || !item.comment.path) {
      this.logger.warn({ prNumber, commentId: item.comment.id }, "Could not extract suggestion content");
      return;
    }

    // TODO: ファイルの該当行を sugMatch[1] で置換
    // 現時点では Implementer に委譲
    await this.handleFixRequest(prNumber, branch, {
      ...item,
      instruction: `以下の GitHub Suggestion を適用してください:\n\nファイル: ${item.comment.path}\n行: ${item.comment.line ?? "不明"}\n\n${item.comment.body}`,
    });
  }
}
