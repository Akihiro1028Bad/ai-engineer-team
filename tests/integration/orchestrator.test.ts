import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../../src/queue/schema.js";
import { TaskQueue } from "../../src/queue/task-queue.js";
import { CronScheduler } from "../../src/sources/cron-scheduler.js";
import { CircuitBreaker } from "../../src/safety/circuit-breaker.js";
import { RateController } from "../../src/safety/rate-controller.js";
import { BudgetGuard } from "../../src/safety/budget-guard.js";
import { SlackNotifier } from "../../src/notifications/slack-notifier.js";
import { Dispatcher } from "../../src/agents/dispatcher.js";
import { WorktreeManager } from "../../src/agents/worktree-manager.js";
import { Orchestrator } from "../../src/orchestrator.js";
import { createLogger } from "../../src/logging/logger.js";
import { Writable } from "node:stream";

// Mock Agent SDK
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(async function* () {
    await Promise.resolve();
    yield {
      type: "result",
      subtype: "success",
      result: "Review complete",
      total_cost_usd: 0.1,
      num_turns: 3,
      duration_ms: 5000,
      structured_output: { findings: [], summary: "No issues" },
    };
  }),
}));

function createTestDeps() {
  const db = new Database(":memory:");
  initSchema(db);
  const queue = new TaskQueue(db);
  const nullStream = new Writable({ write(_c, _e, cb) { cb(); } });
  const logger = createLogger({ stream: nullStream, level: "silent" });

  return {
    queue,
    dispatcher: new Dispatcher(
      new WorktreeManager("/tmp/worktrees", "/tmp/project", vi.fn().mockReturnValue(Buffer.from(""))),
      "/tmp/handoffs",
    ),
    cronScheduler: new CronScheduler(queue),
    circuitBreaker: new CircuitBreaker(5, 3_600_000),
    rateController: new RateController(false, 0, 150, 0.1),
    budgetGuard: new BudgetGuard(undefined),
    slackNotifier: new SlackNotifier(undefined),
    logger,
    pollIntervalMs: 10,
    maxConcurrent: 1,
  };
}

describe("Orchestrator integration", () => {
  it("T-ORC-001: empty queue runs one tick without dispatch", async () => {
    const deps = createTestDeps();
    const orch = new Orchestrator(deps);
    await orch.tick();
    // No errors, no dispatch
  });

  it("T-ORC-002: dispatches review task and marks completed", async () => {
    const deps = createTestDeps();
    deps.queue.push({
      id: "test-001",
      taskType: "review",
      title: "Test review",
      description: "Review src/",
      source: "manual",
      priority: 5,
      dependsOn: null,
      parentTaskId: null,
      repo: null,
    });

    const orch = new Orchestrator(deps);
    await orch.tick();

    // Wait for async fire-and-forget dispatch to settle
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const task = deps.queue.getById("test-001");
      if (task?.status === "completed") break;
    }

    const task = deps.queue.getById("test-001");
    expect(task?.status).toBe("completed");
    expect(task?.costUsd).toBe(0.1);
    expect(task?.turnsUsed).toBe(3);
  });

  it("T-ORC-004: skips dispatch when circuit breaker is OPEN", async () => {
    const deps = createTestDeps();
    // Open circuit breaker
    for (let i = 0; i < 5; i++) deps.circuitBreaker.recordFailure();

    deps.queue.push({
      id: "blocked",
      taskType: "review",
      title: "Blocked",
      description: "Should not run",
      source: "manual",
      priority: 5,
      dependsOn: null,
      parentTaskId: null,
      repo: null,
    });

    const orch = new Orchestrator(deps);
    await orch.tick();

    const task = deps.queue.getById("blocked");
    expect(task?.status).toBe("pending"); // Not dispatched
  });

  it("T-ORC-006: skips dispatch when budget exceeded", async () => {
    const deps = createTestDeps();
    deps.budgetGuard = new BudgetGuard(10.0);
    deps.budgetGuard.recordCost(11.0);

    deps.queue.push({
      id: "over-budget",
      taskType: "review",
      title: "Over budget",
      description: "Should not run",
      source: "manual",
      priority: 5,
      dependsOn: null,
      parentTaskId: null,
      repo: null,
    });

    const orch = new Orchestrator(deps);
    await orch.tick();

    const task = deps.queue.getById("over-budget");
    expect(task?.status).toBe("pending");
  });

  it("T-ORC-007: crash recovery on start", async () => {
    const deps = createTestDeps();
    deps.queue.push({
      id: "crashed",
      taskType: "review",
      title: "Crashed task",
      description: "Was in progress",
      source: "manual",
      priority: 5,
      dependsOn: null,
      parentTaskId: null,
      repo: null,
    });
    deps.queue.updateStatus("crashed", "in_progress");

    // Start orchestrator (which calls recoverFromCrash)
    const orch = new Orchestrator(deps);
    const startPromise = orch.start();
    orch.stop();
    await startPromise;

    const task = deps.queue.getById("crashed");
    expect(task?.status).not.toBe("in_progress");
    expect(task?.retryCount).toBe(1);
  });

  it("T-ORC-010: graceful shutdown", async () => {
    const deps = createTestDeps();
    const orch = new Orchestrator(deps);
    const promise = orch.start();
    expect(orch.isRunning()).toBe(true);
    orch.stop();
    await promise;
    expect(orch.isRunning()).toBe(false);
  });
});
