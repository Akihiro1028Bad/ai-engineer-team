import type { ExecutionPlan } from "../types/execution-plan.js";

/** モデル別のデフォルトコスト（Pattern Memory データがない場合のヒューリスティック） */
const DEFAULT_MODEL_COST: Record<string, number> = {
  haiku: 0.05,
  sonnet: 1.00,
  opus: 0.80,
};

/** エージェントロール別のデフォルト所要時間（ms） */
const DEFAULT_ROLE_DURATION: Record<string, number> = {
  analyzer: 120_000,    // 2分
  designer: 420_000,    // 7分
  implementer: 1_200_000, // 20分
  critic: 300_000,      // 5分
  scribe: 180_000,      // 3分
};

export interface CostTimeEstimate {
  totalCostUsd: number;
  totalDurationMs: number;
  perNode: {
    nodeId: string;
    estimatedCostUsd: number;
    estimatedDurationMs: number;
  }[];
  /** ヒューリスティック or データ駆動 */
  source: "heuristic" | "pattern_memory";
}

/**
 * コスト/時間事前見積。
 * Phase 7（Feedback Loop）で Pattern Memory からデータ駆動の見積に切り替わる。
 * 現時点ではヒューリスティックベース。
 */
export class CostEstimator {
  /** ExecutionPlan のコスト/時間を見積もる */
  estimate(plan: ExecutionPlan): CostTimeEstimate {
    const perNode = plan.nodes.map((node) => ({
      nodeId: node.id,
      estimatedCostUsd: node.estimatedCostUsd > 0
        ? node.estimatedCostUsd
        : DEFAULT_MODEL_COST[node.model] ?? 0.50,
      estimatedDurationMs: node.estimatedDurationMs ?? DEFAULT_ROLE_DURATION[node.agentRole] ?? 300_000,
    }));

    // 合計コスト（全ノードの和）
    const totalCostUsd = perNode.reduce((sum, n) => sum + n.estimatedCostUsd, 0);

    // 合計時間（クリティカルパスの和、並列実行を考慮）
    // 簡易版: 依存チェーンの最長パスを計算
    const totalDurationMs = this.estimateCriticalPathDuration(plan, perNode);

    return {
      totalCostUsd,
      totalDurationMs,
      perNode,
      source: "heuristic",
    };
  }

  /** 人間が読める形式のサマリ */
  formatSummary(estimate: CostTimeEstimate): string {
    const cost = `$${estimate.totalCostUsd.toFixed(2)}`;
    const minutes = Math.ceil(estimate.totalDurationMs / 60_000);
    const lines = [
      `推定コスト: ${cost}`,
      `推定所要時間: ${minutes}分`,
      `ノード数: ${estimate.perNode.length}`,
      "",
      "| ノード | コスト | 時間 |",
      "|--------|--------|------|",
      ...estimate.perNode.map((n) =>
        `| ${n.nodeId} | $${n.estimatedCostUsd.toFixed(2)} | ${Math.ceil(n.estimatedDurationMs / 60_000)}分 |`,
      ),
    ];
    return lines.join("\n");
  }

  /** クリティカルパスの所要時間を見積もる */
  private estimateCriticalPathDuration(
    plan: ExecutionPlan,
    perNode: { nodeId: string; estimatedDurationMs: number }[],
  ): number {
    const durationMap = new Map<string, number>();
    for (const n of perNode) {
      durationMap.set(n.nodeId, n.estimatedDurationMs);
    }

    // 各ノードの最早完了時刻を計算
    const earliest = new Map<string, number>();
    const nodeMap = new Map(plan.nodes.map((n) => [n.id, n]));

    function getEarliest(nodeId: string): number {
      const cached = earliest.get(nodeId);
      if (cached !== undefined) return cached;

      const node = nodeMap.get(nodeId);
      if (!node) return 0;

      const depMax = node.dependsOn.length > 0
        ? Math.max(...node.dependsOn.map((d) => getEarliest(d)))
        : 0;

      const result = depMax + (durationMap.get(nodeId) ?? 0);
      earliest.set(nodeId, result);
      return result;
    }

    let maxDuration = 0;
    for (const node of plan.nodes) {
      maxDuration = Math.max(maxDuration, getEarliest(node.id));
    }

    return maxDuration;
  }
}
