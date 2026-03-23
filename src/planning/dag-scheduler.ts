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

    // クリティカルパス計算（最長パス）
    const criticalPath = this.computeCriticalPath(nodes, adjacency);

    return {
      batches,
      criticalPath,
      totalEstimatedCostUsd: nodes.reduce((sum, n) => sum + n.estimatedCostUsd, 0),
    };
  }

  /** 最長パス（クリティカルパス）を計算 */
  private computeCriticalPath(
    nodes: PlanNode[],
    adjacency: Map<string, string[]>,
  ): string[] {
    const dist = new Map<string, number>();
    const prev = new Map<string, string | null>();

    for (const node of nodes) {
      dist.set(node.id, 0);
      prev.set(node.id, null);
    }

    // トポロジカル順に最長距離を計算
    // ノードの estimatedCostUsd を重みとして使用
    const nodeMap = new Map<string, PlanNode>();
    for (const node of nodes) {
      nodeMap.set(node.id, node);
    }

    // ソース（依存なし）から開始
    const sources = nodes.filter((n) => n.dependsOn.length === 0);
    for (const source of sources) {
      dist.set(source.id, source.estimatedCostUsd);
    }

    // BFS で最長距離を伝播
    const visited = new Set<string>();
    const queue = sources.map((n) => n.id);

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const currentDist = dist.get(nodeId) ?? 0;

      for (const neighbor of adjacency.get(nodeId) ?? []) {
        const neighborNode = nodeMap.get(neighbor);
        const newDist = currentDist + (neighborNode?.estimatedCostUsd ?? 0);
        if (newDist > (dist.get(neighbor) ?? 0)) {
          dist.set(neighbor, newDist);
          prev.set(neighbor, nodeId);
        }
        queue.push(neighbor);
      }
    }

    // 最長距離のノードからバックトラック
    let maxDist = 0;
    let endNode = "";
    for (const [nodeId, d] of dist) {
      if (d > maxDist) {
        maxDist = d;
        endNode = nodeId;
      }
    }

    const path: string[] = [];
    let current: string | null = endNode;
    while (current) {
      path.unshift(current);
      current = prev.get(current) ?? null;
    }

    return path;
  }
}
