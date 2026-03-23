import type Database from "better-sqlite3";
import type pino from "pino";

export interface ToolGap {
  id: string;
  description: string;
  detectedBy: "failure_pattern" | "agent_report" | "planner" | "pattern_memory";
  category: string;
  occurrences: number;
  suggestedToolName: string;
  createdAt: string;
}

/**
 * ToolForge Gap Detector: ツール不足を自動検出する。
 *
 * トリガー条件:
 * 1. 同カテゴリのタスクが3回以上失敗
 * 2. エージェントが toolGapReport を出力
 * 3. Planner がツール不足を判断
 * 4. Pattern Memory が繰り返しボイラープレートを検出
 */
export class GapDetector {
  constructor(
    private readonly db: Database.Database,
    private readonly logger: pino.Logger,
  ) {}

  /** 失敗パターンからツールギャップを検出する */
  detectFromFailures(): ToolGap[] {
    const gaps: ToolGap[] = [];

    try {
      // 同カテゴリ3回以上失敗のパターンを検出
      const failurePatterns = this.db.prepare(`
        SELECT
          failure_category,
          agent_role,
          COUNT(*) as count
        FROM eval_records
        WHERE success = 0 AND failure_category IS NOT NULL
        GROUP BY failure_category, agent_role
        HAVING count >= 3
        ORDER BY count DESC
      `).all() as { failure_category: string; agent_role: string; count: number }[];

      for (const pattern of failurePatterns) {
        const id = `gap-${pattern.agent_role}-${pattern.failure_category}`;
        gaps.push({
          id,
          description: `${pattern.agent_role} が "${pattern.failure_category}" で ${pattern.count} 回失敗`,
          detectedBy: "failure_pattern",
          category: pattern.failure_category,
          occurrences: pattern.count,
          suggestedToolName: this.suggestToolName(pattern.failure_category, pattern.agent_role),
          createdAt: new Date().toISOString(),
        });
      }
    } catch {
      // eval_records テーブルが存在しない場合は無視
    }

    if (gaps.length > 0) {
      this.logger.info({ gapCount: gaps.length }, "Tool gaps detected from failures");
    }

    return gaps;
  }

  /** エージェント出力からツールギャップレポートを解析する */
  detectFromAgentReport(output: string): ToolGap | null {
    // エージェントが出力する toolGapReport 形式を検出
    const gapMatch = /toolGapReport:\s*\{([^}]+)\}/.exec(output);
    if (!gapMatch) return null;

    try {
      const reportContent = gapMatch[1] ?? "";
      const descMatch = /description:\s*"([^"]+)"/.exec(reportContent);
      const catMatch = /category:\s*"([^"]+)"/.exec(reportContent);

      if (descMatch) {
        return {
          id: `gap-agent-${Date.now()}`,
          description: descMatch[1] ?? "",
          detectedBy: "agent_report",
          category: catMatch?.[1] ?? "unknown",
          occurrences: 1,
          suggestedToolName: this.suggestToolName(catMatch?.[1] ?? "unknown", ""),
          createdAt: new Date().toISOString(),
        };
      }
    } catch { /* parse error */ }

    return null;
  }

  /** カテゴリからツール名を推測する */
  private suggestToolName(category: string, agentRole: string): string {
    const suggestions: Record<string, string> = {
      timeout: "parallel-executor",
      budget_exceeded: "cost-optimizer",
      validation_failed: "schema-validator",
      ci_failed: "ci-fixer",
      crash: "error-recovery",
    };

    return suggestions[category] ?? `${agentRole}-helper-${category}`.replace(/[^a-z0-9-]/g, "-");
  }
}
