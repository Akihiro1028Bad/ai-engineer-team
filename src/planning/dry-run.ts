import type pino from "pino";

import type { ExecutionPlan } from "../types/execution-plan.js";
import type { CostTimeEstimate } from "./cost-estimator.js";

interface OctokitLike {
  issues: {
    createComment: (params: {
      owner: string;
      repo: string;
      issue_number: number;
      body: string;
    }) => Promise<unknown>;
  };
}

/**
 * Dry Run モード: ExecutionPlan をプレビュー表示し、
 * 実行前に Issue コメントに計画サマリを投稿する。
 */
export class DryRunPreview {
  constructor(
    private readonly octokit: OctokitLike,
    private readonly owner: string,
    private readonly repo: string,
    private readonly logger: pino.Logger,
  ) {}

  /** Issue に計画プレビューをコメントとして投稿する */
  async postPreview(
    issueNumber: number,
    plan: ExecutionPlan,
    estimate: CostTimeEstimate,
  ): Promise<void> {
    const body = this.buildPreviewComment(plan, estimate);

    try {
      await this.octokit.issues.createComment({
        owner: this.owner, repo: this.repo,
        issue_number: issueNumber, body,
      });
      this.logger.info({ issueNumber }, "Dry run preview posted");
    } catch {
      this.logger.warn({ issueNumber }, "Failed to post dry run preview");
    }
  }

  /** プレビューコメントを構築する */
  private buildPreviewComment(
    plan: ExecutionPlan,
    estimate: CostTimeEstimate,
  ): string {
    const minutes = Math.ceil(estimate.totalDurationMs / 60_000);

    const nodeLines = plan.nodes.map((node) => {
      const deps = node.dependsOn.length > 0 ? ` (依存: ${node.dependsOn.join(", ")})` : "";
      const critic = node.requiresCriticLoop ? " 🔍" : "";
      return `| ${node.id} | ${node.agentRole} | ${node.model} | $${node.estimatedCostUsd.toFixed(2)} | ${deps}${critic} |`;
    });

    // DAG のビジュアル表現（テキスト）
    const dagVisual = this.buildDAGVisual(plan);

    return [
      "🤖 **AI Agent Orchestrator** — 実行計画プレビュー（Dry Run）",
      "",
      `**リスクレベル:** ${this.riskEmoji(plan.riskLevel)} ${plan.riskLevel}`,
      `**推定コスト:** $${estimate.totalCostUsd.toFixed(2)}`,
      `**推定所要時間:** ${minutes}分`,
      `**ノード数:** ${plan.nodes.length}`,
      "",
      "### 実行計画（DAG）",
      "```",
      dagVisual,
      "```",
      "",
      "### ノード詳細",
      "| ID | エージェント | モデル | コスト | 備考 |",
      "|----|----|----|----|------|",
      ...nodeLines,
      "",
      `**根拠:** ${plan.rationale}`,
      "",
      "---",
      "この計画を実行するには「承認」とコメントしてください。",
      "計画を却下するには「却下」とコメントしてください。",
    ].join("\n");
  }

  /** DAG のテキストビジュアル表現 */
  private buildDAGVisual(plan: ExecutionPlan): string {
    const lines: string[] = [];
    const nodeMap = new Map(plan.nodes.map((n) => [n.id, n]));

    // 依存関係のないノード（ルート）から開始
    const roots = plan.nodes.filter((n) => n.dependsOn.length === 0);

    // 簡易ビジュアル: レベルごとにノードを表示
    const levels = new Map<string, number>();
    function getLevel(nodeId: string): number {
      const cached = levels.get(nodeId);
      if (cached !== undefined) return cached;
      const node = nodeMap.get(nodeId);
      if (!node || node.dependsOn.length === 0) {
        levels.set(nodeId, 0);
        return 0;
      }
      const maxDepLevel = Math.max(...node.dependsOn.map((d) => getLevel(d)));
      const level = maxDepLevel + 1;
      levels.set(nodeId, level);
      return level;
    }

    for (const node of plan.nodes) {
      getLevel(node.id);
    }

    const maxLevel = Math.max(...[...levels.values()], 0);
    for (let level = 0; level <= maxLevel; level++) {
      const nodesAtLevel = plan.nodes.filter((n) => levels.get(n.id) === level);
      const nodeLabels = nodesAtLevel.map((n) => `[${n.id}: ${n.agentRole}]`);

      if (level > 0) {
        lines.push("    │");
        lines.push("    ▼");
      }

      if (nodeLabels.length === 1) {
        lines.push(`  ${nodeLabels[0]}`);
      } else {
        // 並列ノード
        const indent = "  ";
        lines.push(`${indent}┌${"─".repeat(20)}┐`);
        for (const label of nodeLabels) {
          lines.push(`${indent}│ ${label.padEnd(18)} │`);
        }
        lines.push(`${indent}└${"─".repeat(20)}┘`);
      }
    }

    return lines.length > 0 ? lines.join("\n") : roots.map((r) => `[${r.id}: ${r.agentRole}]`).join(" → ");
  }

  private riskEmoji(risk: string): string {
    switch (risk) {
      case "low": return "🟢";
      case "medium": return "🟡";
      case "high": return "🔴";
      default: return "⚪";
    }
  }
}
