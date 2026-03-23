import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../../src/queue/schema.js";
import { TaskQueue } from "../../src/queue/task-queue.js";

describe("Daily digest (US4)", () => {
  let queue: TaskQueue;

  beforeEach(() => {
    const db = new Database(":memory:");
    initSchema(db);
    queue = new TaskQueue(db);
  });

  it("T060: getDailyDigest returns correct metrics including pending approvals", () => {
    // Completed tasks
    queue.push({ id: "a", taskType: "review", title: "A", description: "D", source: "s1", priority: 5, dependsOn: null, parentTaskId: null });
    queue.push({ id: "b", taskType: "fix", title: "B", description: "D", source: "s2", priority: 5, dependsOn: null, parentTaskId: null });
    queue.updateStatus("a", "in_progress");
    queue.updateStatus("a", "completed", { costUsd: 0.3, turnsUsed: 5 });
    queue.updateStatus("b", "in_progress");
    queue.updateStatus("b", "completed", { costUsd: 0.5, turnsUsed: 10 });

    // Failed task
    queue.push({ id: "c", taskType: "build", title: "C", description: "D", source: "s3", priority: 5, dependsOn: null, parentTaskId: null });
    queue.updateStatus("c", "in_progress");
    queue.updateStatus("c", "failed");

    // Awaiting approval task
    queue.push({ id: "d", taskType: "review", title: "D", description: "D", source: "s4", priority: 5, dependsOn: null, parentTaskId: null });
    queue.updateStatus("d", "in_progress");
    queue.updateStatus("d", "awaiting_approval", { approvalPrUrl: "https://pr/1" });

    const digest = queue.getDailyDigest();
    expect(digest.completed).toBe(2);
    expect(digest.failed).toBe(1);
    expect(digest.totalCostUsd).toBeCloseTo(0.8);
    expect(digest.pendingApprovals).toBe(1);
  });
});
