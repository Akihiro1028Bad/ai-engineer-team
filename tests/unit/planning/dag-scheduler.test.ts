import { describe, it, expect } from "vitest";
import { DAGScheduler } from "../../../src/planning/dag-scheduler.js";
import type { ExecutionPlan, PlanNode } from "../../../src/types/execution-plan.js";

function makePlan(nodes: PlanNode[]): ExecutionPlan {
  return {
    taskId: "test-1",
    nodes,
    criticalPath: [],
    totalEstimatedCostUsd: nodes.reduce((s, n) => s + n.estimatedCostUsd, 0),
    riskLevel: "low",
    rationale: "test",
    createdAt: new Date().toISOString(),
  };
}

function makeNode(id: string, dependsOn: string[] = [], cost = 1.0): PlanNode {
  return {
    id,
    agentRole: "implementer",
    prompt: `task for ${id}`,
    dependsOn,
    model: "sonnet",
    estimatedCostUsd: cost,
    requiresCriticLoop: false,
    maxRetries: 1,
  };
}

describe("DAGScheduler", () => {
  const scheduler = new DAGScheduler();

  it("schedules single node as one batch", () => {
    const plan = makePlan([makeNode("n1")]);
    const result = scheduler.schedule(plan);

    expect(result.batches).toHaveLength(1);
    const batch0 = result.batches[0] ?? { nodes: [] };
    expect(batch0.nodes).toHaveLength(1);
    const node0 = batch0.nodes[0] ?? { id: "" };
    expect(node0.id).toBe("n1");
  });

  it("schedules linear chain into sequential batches", () => {
    const plan = makePlan([
      makeNode("n1"),
      makeNode("n2", ["n1"]),
      makeNode("n3", ["n2"]),
    ]);
    const result = scheduler.schedule(plan);

    expect(result.batches).toHaveLength(3);
    const b0 = result.batches[0] ?? { nodes: [] };
    const b1 = result.batches[1] ?? { nodes: [] };
    const b2 = result.batches[2] ?? { nodes: [] };
    expect((b0.nodes[0] ?? { id: "" }).id).toBe("n1");
    expect((b1.nodes[0] ?? { id: "" }).id).toBe("n2");
    expect((b2.nodes[0] ?? { id: "" }).id).toBe("n3");
  });

  it("schedules independent nodes into same batch (parallel)", () => {
    const plan = makePlan([
      makeNode("n1"),
      makeNode("n2"),
      makeNode("n3"),
    ]);
    const result = scheduler.schedule(plan);

    expect(result.batches).toHaveLength(1);
    const batch0 = result.batches[0] ?? { nodes: [] };
    expect(batch0.nodes).toHaveLength(3);
  });

  it("handles diamond dependency pattern", () => {
    const plan = makePlan([
      makeNode("n1"),
      makeNode("n2", ["n1"]),
      makeNode("n3", ["n1"]),
      makeNode("n4", ["n2", "n3"]),
    ]);
    const result = scheduler.schedule(plan);

    expect(result.batches).toHaveLength(3);
    const b0 = result.batches[0] ?? { nodes: [] };
    const b1 = result.batches[1] ?? { nodes: [] };
    const b2 = result.batches[2] ?? { nodes: [] };
    expect((b0.nodes[0] ?? { id: "" }).id).toBe("n1");
    const batch1Ids = b1.nodes.map((n) => n.id).sort();
    expect(batch1Ids).toEqual(["n2", "n3"]);
    expect((b2.nodes[0] ?? { id: "" }).id).toBe("n4");
  });

  it("detects cycles and throws", () => {
    const plan = makePlan([
      makeNode("n1", ["n2"]),
      makeNode("n2", ["n1"]),
    ]);

    expect(() => scheduler.schedule(plan)).toThrow(/サイクル/);
  });

  it("detects 3-node cycle", () => {
    const plan = makePlan([
      makeNode("n1", ["n3"]),
      makeNode("n2", ["n1"]),
      makeNode("n3", ["n2"]),
    ]);

    expect(() => scheduler.schedule(plan)).toThrow(/サイクル/);
  });

  it("computes critical path", () => {
    const plan = makePlan([
      makeNode("n1", [], 0.5),
      makeNode("n2", ["n1"], 1.0),
      makeNode("n3", ["n1"], 0.3),
    ]);
    const result = scheduler.schedule(plan);

    expect(result.criticalPath).toContain("n1");
    expect(result.criticalPath).toContain("n2");
  });

  it("returns correct total estimated cost", () => {
    const plan = makePlan([
      makeNode("n1", [], 0.5),
      makeNode("n2", ["n1"], 1.0),
      makeNode("n3", [], 0.3),
    ]);
    const result = scheduler.schedule(plan);

    expect(result.totalEstimatedCostUsd).toBeCloseTo(1.8, 2);
  });

  it("handles fan-out fan-in pattern", () => {
    const plan = makePlan([
      makeNode("n1"),
      makeNode("n2", ["n1"]),
      makeNode("n3", ["n1"]),
      makeNode("n4", ["n1"]),
      makeNode("n5", ["n2", "n3", "n4"]),
    ]);
    const result = scheduler.schedule(plan);

    expect(result.batches).toHaveLength(3);
    const b1 = result.batches[1] ?? { nodes: [] };
    expect(b1.nodes).toHaveLength(3);
  });
});
