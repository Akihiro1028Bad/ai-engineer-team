import { describe, it, expect } from "vitest";
import { CostEstimator } from "../../../src/planning/cost-estimator.js";
import type { ExecutionPlan, PlanNode } from "../../../src/types/execution-plan.js";

function makeNode(id: string, role: string, model: string, dependsOn: string[] = [], cost = 0): PlanNode {
  return {
    id,
    agentRole: role as PlanNode["agentRole"],
    prompt: "test",
    dependsOn,
    model: model as PlanNode["model"],
    estimatedCostUsd: cost,
    requiresCriticLoop: false,
    maxRetries: 1,
  };
}

function makePlan(nodes: PlanNode[]): ExecutionPlan {
  return {
    taskId: "test-1",
    nodes,
    criticalPath: [],
    totalEstimatedCostUsd: 0,
    riskLevel: "low",
    rationale: "test",
    createdAt: new Date().toISOString(),
  };
}

describe("CostEstimator", () => {
  const estimator = new CostEstimator();

  it("estimates cost from node values", () => {
    const plan = makePlan([
      makeNode("n1", "designer", "sonnet", [], 0.50),
      makeNode("n2", "implementer", "sonnet", ["n1"], 1.50),
    ]);
    const result = estimator.estimate(plan);

    expect(result.totalCostUsd).toBeCloseTo(2.0, 2);
    expect(result.perNode).toHaveLength(2);
    expect(result.source).toBe("heuristic");
  });

  it("uses default costs when node cost is 0", () => {
    const plan = makePlan([
      makeNode("n1", "analyzer", "haiku", [], 0),
    ]);
    const result = estimator.estimate(plan);

    // haiku default is 0.05
    expect(result.perNode[0]!.estimatedCostUsd).toBeCloseTo(0.05, 2);
  });

  it("estimates duration for sequential nodes", () => {
    const plan = makePlan([
      makeNode("n1", "designer", "sonnet", [], 0.5),
      makeNode("n2", "implementer", "sonnet", ["n1"], 1.0),
    ]);
    const result = estimator.estimate(plan);

    // Sequential: designer (420s) + implementer (1200s) = 1620s
    expect(result.totalDurationMs).toBeGreaterThan(0);
    expect(result.totalDurationMs).toBe(
      result.perNode[0]!.estimatedDurationMs + result.perNode[1]!.estimatedDurationMs,
    );
  });

  it("estimates parallel duration correctly", () => {
    const plan = makePlan([
      makeNode("n1", "designer", "sonnet", [], 0.5),
      makeNode("n2", "designer", "sonnet", [], 0.5),
      makeNode("n3", "implementer", "sonnet", ["n1", "n2"], 1.0),
    ]);
    const result = estimator.estimate(plan);

    // Parallel n1/n2 → n3: max(n1, n2) + n3
    const n1Duration = result.perNode[0]!.estimatedDurationMs;
    const n3Duration = result.perNode[2]!.estimatedDurationMs;
    expect(result.totalDurationMs).toBe(n1Duration + n3Duration);
  });

  it("formats summary correctly", () => {
    const plan = makePlan([
      makeNode("n1", "designer", "sonnet", [], 0.50),
    ]);
    const estimate = estimator.estimate(plan);
    const summary = estimator.formatSummary(estimate);

    expect(summary).toContain("推定コスト:");
    expect(summary).toContain("推定所要時間:");
    expect(summary).toContain("ノード数: 1");
  });
});
