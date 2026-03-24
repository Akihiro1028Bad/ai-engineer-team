import type { ExecutionPlan, PlanNode } from "../types/execution-plan.js";

/** DAG ノードの実行バッチ（同一バッチ内は並列実行可能） */
export interface ExecutionBatch {
  /** バッチ内のノード（全て独立に実行可能） */
  nodes: PlanNode[];
  /** このバッチの実行順序（0始まり） */
  order: number;
}

export interface ScheduleResult {
  batches: ExecutionBatch[];
  /** クリティカルパスのノード ID 列 */
  criticalPath: string[];
  /** 推定合計コスト */
  totalEstimatedCostUsd: number;
}

/**
 * DAG Scheduler: ExecutionPlan のノードをトポロジカルソートし、
 * 並列実行可能なバッチに分割する。Kahn's アルゴリズムでサイクル検出。
 */
export class DAGScheduler {
  /**
   * ExecutionPlan をスケジューリングする。
   * @throws Error サイクルが検出された場合
   */
  schedule(plan: ExecutionPlan): ScheduleResult {
    const nodes = plan.nodes;
    const nodeMap = new Map<string, PlanNode>();
    for (const node of nodes) {
      nodeMap.set(node.id, node);
    }

    // 入次数（in-degree）を計算
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const node of nodes) {
      if (!inDegree.has(node.id)) inDegree.set(node.id, 0);
      if (!adjacency.has(node.id)) adjacency.set(node.id, []);

      for (const dep of node.dependsOn) {
        inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
        const adj = adjacency.get(dep) ?? [];
        adj.push(node.id);
        adjacency.set(dep, adj);
      }
    }

    // Kahn's アルゴリズムでトポロジカルソート
    const batches: ExecutionBatch[] = [];
    let processed = 0;
    let order = 0;

    // 初期キュー: 入次数 0 のノード
    let currentBatch: string[] = [];
    for (const [nodeId, degree] of inDegree) {
      if (degree === 0) currentBatch.push(nodeId);
    }

    while (currentBatch.length > 0) {
      const batchNodes: PlanNode[] = [];
      const nextBatch: string[] = [];

      for (const nodeId of currentBatch) {
        const node = nodeMap.get(nodeId);
        if (!node) continue;
        batchNodes.push(node);
        processed++;

        // 隣接ノードの入次数を減らす
        for (const neighbor of adjacency.get(nodeId) ?? []) {
          const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
          inDegree.set(neighbor, newDegree);
          if (newDegree === 0) {
            nextBatch.push(neighbor);
          }
        }
      }

      if (batchNodes.length > 0) {
        batches.push({ nodes: batchNodes, order });
        order++;
      }

      currentBatch = nextBatch;
    }

    // サイクル検出
    if (processed !== nodes.length) {
      const unprocessed = nodes
        .filter((n) => !batches.some((b) => b.nodes.some((bn) => bn.id === n.id)))
        .map((n) => n.id);
      throw new Error(
        `DAG にサイクルが検出されました。未処理ノード: ${unprocessed.join(", ")}`,
      );
    }

    // クリティカルパス計算（最長パス）— バッチをトポロジカル順序として使用
    const criticalPath = this.computeCriticalPath(nodes, batches);

    return {
      batches,
      criticalPath,
      totalEstimatedCostUsd: nodes.reduce((sum, n) => sum + n.estimatedCostUsd, 0),
    };
  }

  /** 最長パス（クリティカルパス）を計算（DAG 緩和法） */
  private computeCriticalPath(
    nodes: PlanNode[],
    batches: ExecutionBatch[],
  ): string[] {
    const dist = new Map<string, number>();
    const prev = new Map<string, string | null>();

    // Initialize distances
    for (const node of nodes) {
      dist.set(node.id, 0);
      prev.set(node.id, null);
    }

    // Process in topological order (batches are already in topo order)
    // For each node, relax edges to all successors
    for (const batch of batches) {
      for (const node of batch.nodes) {
        const nodeDist = dist.get(node.id) ?? 0;
        const nodeWeight = node.estimatedDurationMs ?? 600_000; // default 10 min in ms
        // Find successor nodes (nodes that depend on this one)
        for (const successor of nodes) {
          if (successor.dependsOn.includes(node.id)) {
            const newDist = nodeDist + nodeWeight;
            if (newDist > (dist.get(successor.id) ?? 0)) {
              dist.set(successor.id, newDist);
              prev.set(successor.id, node.id);
            }
          }
        }
      }
    }

    // Find the node with maximum distance (end of critical path)
    let maxNode = nodes[0]?.id ?? "";
    let maxDist = 0;
    for (const [nodeId, d] of dist) {
      if (d > maxDist) {
        maxDist = d;
        maxNode = nodeId;
      }
    }

    // Trace back the critical path
    const path: string[] = [];
    let current: string | null | undefined = maxNode;
    while (current) {
      path.unshift(current);
      current = prev.get(current) ?? null;
    }

    return path;
  }
}
