import { describe, it, expect, vi, beforeEach } from "vitest";
import { Dispatcher } from "../../../src/agents/dispatcher.js";
import type { Task, AgentConfig } from "../../../src/types.js";

// Mock Agent SDK
const mockQueryResults: unknown[] = [];
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(async function* () {
    for (const msg of mockQueryResults) {
      yield msg;
    }
  }),
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "test-001",
    taskType: "review",
    title: "Test",
    description: "Test desc",
    source: "manual",
    priority: 5,
    status: "in_progress",
    result: null,
    costUsd: 0,
    turnsUsed: 0,
    retryCount: 0,
    dependsOn: null,
    parentTaskId: null,
    contextFile: null,
    approvalPrUrl: null,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    ...overrides,
  };
}

const reviewerConfig: AgentConfig = {
  role: "reviewer",
  allowedTools: ["Read", "Glob", "Grep"],
  permissionMode: "dontAsk",
  maxTurns: 15,
  maxBudgetUsd: 0.5,
  timeoutMs: 600_000,
  model: "sonnet",
  systemPrompt: "",
};

describe("Dispatcher", () => {
  let dispatcher: Dispatcher;

  beforeEach(() => {
    mockQueryResults.length = 0;
    dispatcher = new Dispatcher("/home/user/worktrees", "/home/user/handoffs");
  });

  it("T-DSP-001: success result returns completed with metrics", async () => {
    mockQueryResults.push({
      type: "result",
      subtype: "success",
      result: "Review complete",
      total_cost_usd: 0.23,
      num_turns: 8,
      duration_ms: 15000,
      structured_output: { findings: [], summary: "No issues" },
    });

    const result = await dispatcher.dispatch(makeTask(), reviewerConfig);
    expect(result.status).toBe("completed");
    expect(result.costUsd).toBe(0.23);
    expect(result.turnsUsed).toBe(8);
  });

  it("T-DSP-002: structured output is returned", async () => {
    const output = { findings: [{ severity: "warn" }], summary: "1 issue" };
    mockQueryResults.push({
      type: "result",
      subtype: "success",
      result: "done",
      total_cost_usd: 0.1,
      num_turns: 5,
      duration_ms: 5000,
      structured_output: output,
    });

    const result = await dispatcher.dispatch(makeTask(), reviewerConfig);
    expect(result.structuredOutput).toEqual(output);
  });

  it("T-DSP-004: error_max_turns returns retry", async () => {
    mockQueryResults.push({
      type: "result",
      subtype: "error_max_turns",
      total_cost_usd: 0.5,
      num_turns: 15,
      duration_ms: 600000,
      errors: ["Max turns reached"],
    });

    const result = await dispatcher.dispatch(makeTask(), reviewerConfig);
    expect(result.status).toBe("retry");
    expect(result.error).toContain("error_max_turns");
  });

  it("T-DSP-005: error_max_budget_usd returns retry", async () => {
    mockQueryResults.push({
      type: "result",
      subtype: "error_max_budget_usd",
      total_cost_usd: 0.5,
      num_turns: 10,
      duration_ms: 300000,
      errors: ["Budget exceeded"],
    });

    const result = await dispatcher.dispatch(makeTask(), reviewerConfig);
    expect(result.status).toBe("retry");
  });

  it("T-DSP-006: error_during_execution returns retry", async () => {
    mockQueryResults.push({
      type: "result",
      subtype: "error_during_execution",
      total_cost_usd: 0.1,
      num_turns: 3,
      duration_ms: 10000,
      errors: ["Some error"],
    });

    const result = await dispatcher.dispatch(makeTask(), reviewerConfig);
    expect(result.status).toBe("retry");
  });

  it("T-DSP-008: handles thrown exception", async () => {
    mockQueryResults.length = 0;
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    // @ts-expect-error mock override for testing
    vi.mocked(query).mockImplementationOnce(async function* () {
      throw new Error("Connection failed");
    });

    const result = await dispatcher.dispatch(makeTask(), reviewerConfig);
    expect(result.status).toBe("retry");
    expect(result.error).toContain("Connection failed");
  });

  it("T-DSP-010: passes allowedTools correctly", async () => {
    mockQueryResults.push({
      type: "result",
      subtype: "success",
      result: "done",
      total_cost_usd: 0.1,
      num_turns: 1,
      duration_ms: 1000,
    });

    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    await dispatcher.dispatch(makeTask(), reviewerConfig);
    const calls = vi.mocked(query).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const opts = calls[calls.length - 1]![0] as { options?: { allowedTools?: string[] } };
    expect(opts.options?.allowedTools).toEqual(["Read", "Glob", "Grep"]);
  });

  it("T-DSP-011: passes cwd as worktree path", async () => {
    mockQueryResults.push({
      type: "result",
      subtype: "success",
      result: "done",
      total_cost_usd: 0.1,
      num_turns: 1,
      duration_ms: 1000,
    });

    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    await dispatcher.dispatch(makeTask(), reviewerConfig);
    const calls = vi.mocked(query).mock.calls;
    const opts = calls[calls.length - 1]![0] as { options?: { cwd?: string } };
    expect(opts.options?.cwd).toBe("/home/user/worktrees/reviewer");
  });

  it("T-DSP-013: single task returns completed (not awaiting_approval)", async () => {
    mockQueryResults.push({
      type: "result",
      subtype: "success",
      result: "done",
      total_cost_usd: 0.1,
      num_turns: 5,
      duration_ms: 5000,
    });

    const task = makeTask({ parentTaskId: null });
    const result = await dispatcher.dispatch(task, reviewerConfig);
    expect(result.status).toBe("completed");
  });
});
