import type pino from "pino";

interface OctokitLike {
  paginate: <T>(method: unknown, params: Record<string, unknown>) => Promise<T[]>;
  issues: {
    listForRepo: (params: {
      owner: string;
      repo: string;
      state: string;
      per_page?: number;
    }) => Promise<{ data: { number: number; title: string; body: string | null; labels: { name: string }[] }[] }>;
    createComment: (params: {
      owner: string;
      repo: string;
      issue_number: number;
      body: string;
    }) => Promise<unknown>;
  };
}

export interface RelatedIssue {
  number: number;
  title: string;
  similarity: number;
  relationship: "duplicate" | "related" | "depends_on";
}

/** 単語をトークン化（日本語は文字単位、英語はスペース区切り） */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  // 英語トークン
  const englishTokens = lower.match(/[a-z]+/g) ?? [];
  // 日本語トークン（2-gram）
  const jaChars = lower.replace(/[a-z0-9\s]+/g, "");
  const jaTokens: string[] = [];
  for (let i = 0; i < jaChars.length - 1; i++) {
    jaTokens.push(jaChars.slice(i, i + 2));
  }
  return [...englishTokens, ...jaTokens];
}

/** Jaccard 類似度 */
function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const SIMILARITY_THRESHOLD = 0.3;
const MAX_RELATED = 5;

export class RelatedIssueDetector {
  constructor(
    private readonly octokit: OctokitLike,
    private readonly owner: string,
    private readonly repo: string,
    private readonly logger: pino.Logger,
  ) {}

  /** 類似 Issue を検出する */
  async findRelated(
    issueNumber: number,
    title: string,
    body: string,
  ): Promise<RelatedIssue[]> {
    try {
      const issues = await this.octokit.paginate<{ number: number; title: string; body: string | null; labels: { name: string }[] }>(this.octokit.issues.listForRepo, {
        owner: this.owner, repo: this.repo, state: "all", per_page: 100,
      });

      const targetTokens = tokenize(`${title} ${body}`);
      const results: RelatedIssue[] = [];

      for (const issue of issues) {
        if (issue.number === issueNumber) continue;
        if ("pull_request" in issue) continue;

        const issueTokens = tokenize(`${issue.title} ${issue.body ?? ""}`);
        const similarity = jaccardSimilarity(targetTokens, issueTokens);

        if (similarity >= SIMILARITY_THRESHOLD) {
          const relationship: RelatedIssue["relationship"] = similarity >= 0.7 ? "duplicate"
            : "related";

          results.push({
            number: issue.number,
            title: issue.title,
            similarity,
            relationship,
          });
        }
      }

      return results
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, MAX_RELATED);
    } catch {
      this.logger.warn({ issueNumber }, "Failed to find related issues");
      return [];
    }
  }

  /** 関連 Issue をコメントで通知する */
  async postRelatedComment(
    issueNumber: number,
    related: RelatedIssue[],
  ): Promise<void> {
    if (related.length === 0) return;

    const lines = related.map((r) => {
      const tag = r.relationship === "duplicate" ? "🔴 重複の可能性"
        : r.relationship === "related" ? "🟡 関連"
        : "🔵 依存関係";
      return `- ${tag}: #${r.number} — ${r.title} (類似度: ${(r.similarity * 100).toFixed(0)}%)`;
    });

    const body = [
      "🤖 **AI Agent Orchestrator** — 関連 Issue 検出",
      "",
      ...lines,
    ].join("\n");

    try {
      await this.octokit.issues.createComment({
        owner: this.owner, repo: this.repo,
        issue_number: issueNumber, body,
      });
      this.logger.info({ issueNumber, relatedCount: related.length }, "Related issues comment posted");
    } catch {
      this.logger.warn({ issueNumber }, "Failed to post related issues comment");
    }
  }
}
