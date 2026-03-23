import type Database from "better-sqlite3";
import type pino from "pino";

import type { EvalRecord } from "../types/eval.js";

/**
 * Eval Store: 全実行結果を記録する。
 * Pattern Memory と Adaptive Model Routing のデータソース。
 */
export class EvalStore {
  constructor(
    private readonly db: Database.Database,
    private readonly logger: pino.Logger,
  ) {}

  /** 実行結果を記録する */
  record(eval_: Omit<EvalRecord, "id" | "createdAt">): void {
    const id = `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      this.db.prepare(`
        INSERT INTO eval_records (id, task_id, plan_id, node_id, repo, agent_role, model, cost_usd, duration_ms, turns_used, success, quality_score, diff_lines, file_count, failure_category, issue_labels, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        id,
        eval_.taskId,
        eval_.planId ?? null,
        eval_.nodeId ?? null,
        eval_.repo ?? null,
        eval_.agentRole,
        eval_.model,
        eval_.costUsd,
        eval_.durationMs,
        eval_.turnsUsed,
        eval_.success ? 1 : 0,
        eval_.qualityScore ?? null,
        eval_.diffLines ?? null,
        eval_.fileCount ?? null,
        eval_.failureCategory ?? null,
        JSON.stringify(eval_.issueLabels),
      );
    } catch (error: unknown) {
      this.logger.error({ error }, "Failed to record eval");
    }
  }

  /** エージェント×モデル別のサマリ統計を取得する */
  getAgentModelStats(repo?: string): {
    agentRole: string;
    model: string;
    total: number;
    successes: number;
    successRate: number;
    avgCostUsd: number;
    avgDurationMs: number;
    avgQualityScore: number | null;
  }[] {
    const where = repo ? "WHERE repo = ?" : "";
    const params = repo ? [repo] : [];

    const rows = this.db.prepare(`
      SELECT
        agent_role,
        model,
        COUNT(*) as total,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
        ROUND(AVG(cost_usd), 4) as avg_cost_usd,
        ROUND(AVG(duration_ms), 0) as avg_duration_ms,
        ROUND(AVG(quality_score), 1) as avg_quality_score
      FROM eval_records
      ${where}
      GROUP BY agent_role, model
      ORDER BY agent_role, model
    `).all(...params) as {
      agent_role: string;
      model: string;
      total: number;
      successes: number;
      avg_cost_usd: number;
      avg_duration_ms: number;
      avg_quality_score: number | null;
    }[];

    return rows.map((r) => ({
      agentRole: r.agent_role,
      model: r.model,
      total: r.total,
      successes: r.successes,
      successRate: r.total > 0 ? r.successes / r.total : 0,
      avgCostUsd: r.avg_cost_usd,
      avgDurationMs: r.avg_duration_ms,
      avgQualityScore: r.avg_quality_score,
    }));
  }

  /** 失敗カテゴリ別の統計 */
  getFailureStats(repo?: string): { category: string; count: number }[] {
    const where = repo ? "WHERE repo = ? AND success = 0" : "WHERE success = 0";
    const params = repo ? [repo] : [];

    return this.db.prepare(`
      SELECT failure_category as category, COUNT(*) as count
      FROM eval_records
      ${where}
      GROUP BY failure_category
      ORDER BY count DESC
    `).all(...params) as { category: string; count: number }[];
  }

  /** 直近 N 件の実行記録を取得する */
  getRecent(limit: number, repo?: string): EvalRecord[] {
    const where = repo ? "WHERE repo = ?" : "";
    const params = repo ? [repo, limit] : [limit];

    const rows = this.db.prepare(`
      SELECT * FROM eval_records
      ${where}
      ORDER BY created_at DESC
      LIMIT ?
    `).all(...params) as Record<string, unknown>[];

    return rows.map((r) => ({
      id: r["id"] as string,
      taskId: r["task_id"] as string,
      planId: r["plan_id"] as string | undefined,
      nodeId: r["node_id"] as string | undefined,
      repo: r["repo"] as string | undefined,
      agentRole: r["agent_role"] as string,
      model: r["model"] as string,
      costUsd: r["cost_usd"] as number,
      durationMs: r["duration_ms"] as number,
      turnsUsed: r["turns_used"] as number,
      success: (r["success"] as number) === 1,
      qualityScore: r["quality_score"] as number | undefined,
      diffLines: r["diff_lines"] as number | undefined,
      fileCount: r["file_count"] as number | undefined,
      failureCategory: r["failure_category"] as string | undefined,
      issueLabels: JSON.parse((r["issue_labels"] as string) || "[]") as string[],
      createdAt: r["created_at"] as string,
    })) as EvalRecord[];
  }
}
