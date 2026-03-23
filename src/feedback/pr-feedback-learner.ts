import type Database from "better-sqlite3";
import type pino from "pino";

/** フィードバック分類の型 */
type FeedbackType = "style" | "logic" | "design" | "naming" | "testing" | "other";

interface FeedbackInput {
  repo?: string;
  prNumber: number;
  feedbackContent: string;
  agentRole: string;
  resolution: "applied" | "rejected" | "partial";
}

/**
 * PR フィードバック学習。
 * PR レビューコメントのパターンを記録し、プロンプト改善の材料にする。
 */
export class PRFeedbackLearner {
  constructor(
    private readonly db: Database.Database,
    private readonly logger: pino.Logger,
  ) {}

  /** フィードバックを記録する */
  record(input: FeedbackInput): void {
    const id = `fb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const feedbackType = this.classifyFeedback(input.feedbackContent);

    try {
      this.db.prepare(`
        INSERT INTO feedback_learnings (id, repo, pr_number, feedback_type, feedback_content, agent_role, resolution, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        id,
        input.repo ?? null,
        input.prNumber,
        feedbackType,
        input.feedbackContent,
        input.agentRole,
        input.resolution,
      );

      this.logger.info({ prNumber: input.prNumber, feedbackType, agentRole: input.agentRole }, "Feedback recorded");
    } catch (error: unknown) {
      this.logger.error({ error }, "Failed to record feedback");
    }
  }

  /** フィードバックタイプ別の統計を取得する */
  getStats(repo?: string): { feedbackType: string; count: number; agentRole: string }[] {
    const where = repo ? "WHERE repo = ?" : "";
    const params = repo ? [repo] : [];

    return this.db.prepare(`
      SELECT feedback_type, agent_role, COUNT(*) as count
      FROM feedback_learnings
      ${where}
      GROUP BY feedback_type, agent_role
      ORDER BY count DESC
    `).all(...params) as { feedbackType: string; count: number; agentRole: string }[];
  }

  /** 最も多いフィードバックパターンをプロンプト改善の材料として返す */
  getTopPatterns(agentRole: string, limit: number = 5, repo?: string): string[] {
    const where = repo
      ? "WHERE agent_role = ? AND repo = ?"
      : "WHERE agent_role = ?";
    const params = repo ? [agentRole, repo, limit] : [agentRole, limit];

    const rows = this.db.prepare(`
      SELECT feedback_content, COUNT(*) as count
      FROM feedback_learnings
      ${where}
      GROUP BY feedback_content
      ORDER BY count DESC
      LIMIT ?
    `).all(...params) as { feedback_content: string; count: number }[];

    return rows.map((r) => `[${r.count}回] ${r.feedback_content}`);
  }

  /** フィードバック内容を自動分類する */
  private classifyFeedback(content: string): FeedbackType {
    const lower = content.toLowerCase();

    // スタイル系
    if (/命名|名前|naming|variable name|camelCase|snake_case/i.test(lower)) return "naming";
    if (/フォーマット|インデント|スペース|format|indent|whitespace|lint/i.test(lower)) return "style";

    // テスト系
    if (/テスト|test|coverage|カバレッジ|assertion/i.test(lower)) return "testing";

    // 設計系
    if (/設計|アーキテクチャ|design|architecture|分離|責務|responsibility/i.test(lower)) return "design";

    // ロジック系
    if (/バグ|エラー|null|undefined|例外|exception|ロジック|logic|boundary|edge case/i.test(lower)) return "logic";

    return "other";
  }
}
