import type Database from "better-sqlite3";
import type pino from "pino";

import type { HandoffReport } from "../types/handoff-report.js";
import { HandoffReportSchema } from "../types/handoff-report.js";

/**
 * SQLite ベースの HandoffReport 保存。
 * ファイルベースの context-bridge を置換し、信頼性を向上。
 */
export class HandoffStore {
  constructor(
    private readonly db: Database.Database,
    private readonly logger: pino.Logger,
  ) {}

  /** HandoffReport を保存する */
  save(report: HandoffReport): void {
    const parsed = HandoffReportSchema.safeParse(report);
    if (!parsed.success) {
      this.logger.warn({ errors: parsed.error.issues }, "Invalid handoff report");
      return;
    }

    this.db.prepare(`
      INSERT OR REPLACE INTO handoff_reports (id, plan_id, from_node_id, to_node_id, from_agent, to_agent, summary, report_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      report.id,
      report.planId,
      report.fromNodeId,
      report.toNodeId,
      report.fromAgent,
      report.toAgent,
      report.summary,
      JSON.stringify(report),
      report.timestamp,
    );

    this.logger.debug({ reportId: report.id, planId: report.planId }, "Handoff report saved");
  }

  /** 特定の planId + toNodeId に向けた HandoffReport を取得する */
  getForNode(planId: string, toNodeId: string): HandoffReport[] {
    const rows = this.db.prepare(`
      SELECT report_json FROM handoff_reports
      WHERE plan_id = ? AND to_node_id = ?
      ORDER BY created_at ASC
    `).all(planId, toNodeId) as { report_json: string }[];

    const reports: HandoffReport[] = [];
    for (const row of rows) {
      try {
        const parsed = HandoffReportSchema.safeParse(JSON.parse(row.report_json));
        if (parsed.success) {
          reports.push(parsed.data);
        }
      } catch { /* ignore corrupt records */ }
    }
    return reports;
  }

  /** 特定の planId の全 HandoffReport を取得する */
  getAllForPlan(planId: string): HandoffReport[] {
    const rows = this.db.prepare(`
      SELECT report_json FROM handoff_reports
      WHERE plan_id = ?
      ORDER BY created_at ASC
    `).all(planId) as { report_json: string }[];

    const reports: HandoffReport[] = [];
    for (const row of rows) {
      try {
        const parsed = HandoffReportSchema.safeParse(JSON.parse(row.report_json));
        if (parsed.success) {
          reports.push(parsed.data);
        }
      } catch { /* ignore corrupt records */ }
    }
    return reports;
  }

  /** HandoffReport をプロンプト挿入用のテキストに変換する */
  buildContextInsert(reports: HandoffReport[]): string {
    if (reports.length === 0) return "";

    const sections = reports.map((r) => {
      const decisionText = r.decisions.length > 0
        ? r.decisions.map((d) =>
            `  - ${d.decision}: ${d.reasoning}${d.alternatives.length > 0 ? ` (代替案: ${d.alternatives.join(", ")})` : ""}`,
          ).join("\n")
        : "  なし";

      const warningText = r.warnings.length > 0
        ? r.warnings.map((w) => `  ⚠️ ${w}`).join("\n")
        : "";

      return [
        `## ${r.fromAgent} → ${r.toAgent} の引き継ぎ`,
        `**要約:** ${r.summary}`,
        "",
        "**決定事項:**",
        decisionText,
        warningText ? `\n**注意事項:**\n${warningText}` : "",
      ].join("\n");
    });

    return ["# 前段エージェントからの引き継ぎ情報", "", ...sections].join("\n\n");
  }
}
