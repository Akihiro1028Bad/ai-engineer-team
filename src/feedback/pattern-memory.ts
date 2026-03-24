import type Database from "better-sqlite3";
import type pino from "pino";

import type { PatternMemory } from "../types/eval.js";

/**
 * Pattern Memory: Eval Store を分析してパターンを学習・蓄積する。
 * Model Router と Planner の意思決定に使用される。
 */
export class PatternMemoryStore {
  constructor(
    private readonly db: Database.Database,
    private readonly logger: pino.Logger,
  ) {}

  /** Eval Store からパターンを更新する（定期バッチ実行） */
  updatePatterns(repo?: string): void {
    const where = repo ? "WHERE e.repo = ?" : "";
    const params = repo ? [repo] : [];

    try {
      // agent_role × model × task_type の組み合わせごとに集計
      const stats = this.db.prepare(`
        SELECT
          e.agent_role,
          e.model,
          t.task_type,
          e.repo,
          COUNT(*) as sample_count,
          ROUND(AVG(CASE WHEN e.success = 1 THEN 1.0 ELSE 0.0 END), 3) as success_rate,
          ROUND(AVG(e.cost_usd), 4) as avg_cost_usd,
          ROUND(AVG(e.duration_ms), 0) as avg_duration_ms,
          ROUND(AVG(e.quality_score), 1) as avg_quality_score
        FROM eval_records e
        LEFT JOIN tasks t ON e.task_id = t.id
        ${where}
        GROUP BY e.agent_role, e.model, t.task_type, e.repo
      `).all(...params) as {
        agent_role: string;
        model: string;
        task_type: string | null;
        repo: string | null;
        sample_count: number;
        success_rate: number;
        avg_cost_usd: number;
        avg_duration_ms: number;
        avg_quality_score: number | null;
      }[];

      const upsert = this.db.prepare(`
        INSERT INTO pattern_memory (id, repo, agent_role, model, task_type, success_rate, avg_cost_usd, avg_duration_ms, avg_quality_score, sample_count, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(id) DO UPDATE SET
          success_rate = excluded.success_rate,
          avg_cost_usd = excluded.avg_cost_usd,
          avg_duration_ms = excluded.avg_duration_ms,
          avg_quality_score = excluded.avg_quality_score,
          sample_count = excluded.sample_count,
          updated_at = datetime('now')
      `);

      const transaction = this.db.transaction(() => {
        for (const stat of stats) {
          const taskType = stat.task_type ?? "unknown";
          const id = `${stat.repo ?? "global"}:${stat.agent_role}:${stat.model}:${taskType}`;
          upsert.run(
            id,
            stat.repo,
            stat.agent_role,
            stat.model,
            taskType,
            stat.success_rate,
            stat.avg_cost_usd,
            stat.avg_duration_ms,
            stat.avg_quality_score,
            stat.sample_count,
          );
        }
      });
      transaction();

      this.logger.info({ patternCount: stats.length, repo }, "Pattern memory updated");
    } catch (error: unknown) {
      this.logger.error({ error }, "Failed to update pattern memory");
    }
  }

  /** 特定の agent_role × task_type のパターンを取得する */
  getPatterns(agentRole: string, taskType: string, repo?: string): PatternMemory[] {
    const rows = this.db.prepare(`
      SELECT * FROM pattern_memory
      WHERE agent_role = ? AND task_type = ? AND (repo = ? OR repo IS NULL)
      ORDER BY sample_count DESC
    `).all(agentRole, taskType, repo ?? null) as Record<string, unknown>[];

    return rows.map((r) => ({
      id: r["id"] as string,
      repo: r["repo"] as string | undefined,
      agentRole: r["agent_role"] as string,
      model: r["model"] as string,
      taskType: r["task_type"] as string,
      successRate: r["success_rate"] as number,
      avgCostUsd: r["avg_cost_usd"] as number,
      avgDurationMs: r["avg_duration_ms"] as number,
      avgQualityScore: r["avg_quality_score"] as number | undefined,
      sampleCount: r["sample_count"] as number,
      updatedAt: r["updated_at"] as string,
    })) as PatternMemory[];
  }

  /** Planner に注入するパターンコンテキストを生成する */
  buildPlannerContext(taskType: string, repo?: string): string {
    const allPatterns = this.db.prepare(`
      SELECT * FROM pattern_memory
      WHERE task_type = ? AND (repo = ? OR repo IS NULL)
      AND sample_count >= 5
      ORDER BY success_rate DESC
    `).all(taskType, repo ?? null) as Record<string, unknown>[];

    if (allPatterns.length === 0) return "";

    const lines = allPatterns.map((p) => {
      const role = p["agent_role"] as string;
      const model = p["model"] as string;
      const rate = ((p["success_rate"] as number) * 100).toFixed(0);
      const cost = (p["avg_cost_usd"] as number).toFixed(2);
      const samples = p["sample_count"] as number;
      return `- ${role}:${model} — 成功率 ${rate}%, 平均コスト $${cost} (${samples}件)`;
    });

    return ["### モデル別パフォーマンス", ...lines].join("\n");
  }
}
