import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../../../src/queue/schema.js";
import { TaskQueue } from "../../../src/queue/task-queue.js";
import type { CreateTaskInput } from "../../../src/types.js";

function makeInput(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    id: overrides.id ?? "test-001",
    taskType: overrides.taskType ?? "review",
    title: overrides.title ?? "Test task",
    description: overrides.description ?? "Test description",
    source: overrides.source ?? "manual",
    priority: overrides.priority ?? 5,
    dependsOn: overrides.dependsOn ?? null,
    parentTaskId: overrides.parentTaskId ?? null,
    repo: overrides.repo ?? null,
  };
}

describe("TaskQueue", () => {
  let db: Database.Database;
  let queue: TaskQueue;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
    queue = new TaskQueue(db);
  });

  // === 追加 ===
  describe("push", () => {
    it("T-TQ-001: adds a single task", () => {
      queue.push(makeInput());
      const task = queue.getById("test-001");
      expect(task).toBeDefined();
      expect(task?.status).toBe("pending");
    });

    it("T-TQ-002: adds task with dependency", () => {
      queue.push(makeInput({ id: "parent" }));
      queue.push(makeInput({ id: "child", dependsOn: "parent" }));
      const child = queue.getById("child");
      expect(child?.dependsOn).toBe("parent");
    });

    it("T-TQ-003: rejects duplicate ID", () => {
      queue.push(makeInput());
      expect(() => { queue.push(makeInput()); }).toThrow();
    });

    it("T-TQ-004: adds pipeline subtasks in batch", () => {
      const tasks = [
        makeInput({ id: "gh-50-0", taskType: "review" }),
        makeInput({ id: "gh-50-1", taskType: "fix", dependsOn: "gh-50-0" }),
        makeInput({ id: "gh-50-2", taskType: "document", dependsOn: "gh-50-1" }),
      ];
      queue.pushPipeline(tasks);
      expect(queue.getById("gh-50-0")).toBeDefined();
      expect(queue.getById("gh-50-1")?.dependsOn).toBe("gh-50-0");
      expect(queue.getById("gh-50-2")?.dependsOn).toBe("gh-50-1");
    });
  });

  // === 次タスク取得 ===
  describe("getNext", () => {
    it("T-TQ-005: returns null when queue is empty", () => {
      expect(queue.getNext()).toBeNull();
    });

    it("T-TQ-006: returns the pending task", () => {
      queue.push(makeInput());
      const next = queue.getNext();
      expect(next?.id).toBe("test-001");
    });

    it("T-TQ-007: returns higher priority first", () => {
      queue.push(makeInput({ id: "low", priority: 3 }));
      queue.push(makeInput({ id: "high", priority: 1 }));
      expect(queue.getNext()?.id).toBe("high");
    });

    it("T-TQ-008: same priority returns older first", () => {
      queue.push(makeInput({ id: "first", priority: 5 }));
      queue.push(makeInput({ id: "second", priority: 5 }));
      expect(queue.getNext()?.id).toBe("first");
    });

    it("T-TQ-009: skips task with uncompleted dependency", () => {
      queue.push(makeInput({ id: "a" }));
      queue.push(makeInput({ id: "b", dependsOn: "a" }));
      queue.updateStatus("a", "in_progress");
      expect(queue.getNext()?.id).toBeUndefined();
    });

    it("T-TQ-010: returns task when dependency is completed", () => {
      queue.push(makeInput({ id: "a" }));
      queue.push(makeInput({ id: "b", dependsOn: "a" }));
      queue.updateStatus("a", "in_progress");
      queue.updateStatus("a", "completed");
      expect(queue.getNext()?.id).toBe("b");
    });

    it("T-TQ-011: skips task when dependency is failed", () => {
      queue.push(makeInput({ id: "a" }));
      queue.push(makeInput({ id: "b", dependsOn: "a" }));
      queue.updateStatus("a", "in_progress");
      queue.updateStatus("a", "failed");
      expect(queue.getNext()).toBeNull();
    });

    it("T-TQ-012: skips task when dependency is awaiting_approval", () => {
      queue.push(makeInput({ id: "a" }));
      queue.push(makeInput({ id: "b", dependsOn: "a" }));
      queue.updateStatus("a", "in_progress");
      queue.updateStatus("a", "awaiting_approval", { approvalPrUrl: "https://github.com/pr/1" });
      expect(queue.getNext()).toBeNull();
    });
  });

  // === ステータス更新 ===
  describe("updateStatus", () => {
    it("T-TQ-013: pending → in_progress sets startedAt", () => {
      queue.push(makeInput());
      queue.updateStatus("test-001", "in_progress");
      const task = queue.getById("test-001");
      expect(task?.status).toBe("in_progress");
      expect(task?.startedAt).toBeTruthy();
    });

    it("T-TQ-014: in_progress → completed with result data", () => {
      queue.push(makeInput());
      queue.updateStatus("test-001", "in_progress");
      queue.updateStatus("test-001", "completed", {
        result: '{"summary":"done"}',
        costUsd: 0.38,
        turnsUsed: 12,
      });
      const task = queue.getById("test-001");
      expect(task?.status).toBe("completed");
      expect(task?.result).toBe('{"summary":"done"}');
      expect(task?.costUsd).toBe(0.38);
      expect(task?.turnsUsed).toBe(12);
      expect(task?.completedAt).toBeTruthy();
    });

    it("T-TQ-015: in_progress → awaiting_approval with PR URL", () => {
      queue.push(makeInput());
      queue.updateStatus("test-001", "in_progress");
      queue.updateStatus("test-001", "awaiting_approval", {
        approvalPrUrl: "https://github.com/pr/123",
      });
      const task = queue.getById("test-001");
      expect(task?.status).toBe("awaiting_approval");
      expect(task?.approvalPrUrl).toBe("https://github.com/pr/123");
    });

    it("T-TQ-016: in_progress → pending (retry, count < 3)", () => {
      queue.push(makeInput());
      queue.updateStatus("test-001", "in_progress");
      queue.retryTask("test-001");
      const task = queue.getById("test-001");
      expect(task?.status).toBe("pending");
      expect(task?.retryCount).toBe(1);
      expect(task?.startedAt).toBeNull();
    });

    it("T-TQ-017: in_progress → failed (retry count >= 3)", () => {
      queue.push(makeInput());
      queue.updateStatus("test-001", "in_progress");
      // Simulate 3 retries
      for (let i = 0; i < 3; i++) {
        queue.retryTask("test-001");
        queue.updateStatus("test-001", "in_progress");
      }
      // 4th failure should set failed
      queue.retryTask("test-001");
      const task = queue.getById("test-001");
      expect(task?.status).toBe("failed");
    });

    it("T-TQ-018: approve → unblocks successor tasks", () => {
      queue.push(makeInput({ id: "review", taskType: "review" }));
      queue.push(makeInput({ id: "fix", taskType: "fix", dependsOn: "review" }));
      queue.updateStatus("review", "in_progress");
      queue.updateStatus("review", "awaiting_approval", { approvalPrUrl: "https://pr/1" });
      queue.approveTask("review");
      const review = queue.getById("review");
      expect(review?.status).toBe("in_progress");
      // After approval, the orchestrator will resume the task and eventually complete it.
      // The successor should not yet be unblocked since review is in_progress, not completed.
      // Manually complete to verify successor is unblocked.
      queue.updateStatus("review", "completed");
      expect(queue.getNext()?.id).toBe("fix");
    });

    it("T-TQ-019: reject → cancels successor tasks", () => {
      queue.push(makeInput({ id: "parent", source: "parent" }));
      queue.push(makeInput({ id: "review", parentTaskId: "parent", source: "s1" }));
      queue.push(makeInput({ id: "fix", dependsOn: "review", parentTaskId: "parent", source: "s2" }));
      queue.updateStatus("review", "in_progress");
      queue.updateStatus("review", "awaiting_approval", { approvalPrUrl: "https://pr/1" });
      queue.rejectTask("review");
      expect(queue.getById("review")?.status).toBe("failed");
      expect(queue.getById("fix")?.status).toBe("failed");
    });
  });

  // === クラッシュ復旧 ===
  describe("recoverFromCrash", () => {
    it("T-TQ-020: resets in_progress to pending", () => {
      queue.push(makeInput({ id: "a" }));
      queue.push(makeInput({ id: "b" }));
      queue.updateStatus("a", "in_progress");
      queue.updateStatus("b", "in_progress");
      queue.recoverFromCrash();
      expect(queue.getById("a")?.status).toBe("pending");
      expect(queue.getById("b")?.status).toBe("pending");
      expect(queue.getById("a")?.retryCount).toBe(1);
    });

    it("T-TQ-021: marks as failed if retry exceeds 3", () => {
      queue.push(makeInput());
      queue.updateStatus("test-001", "in_progress");
      // Set retry_count to 3 manually
      db.prepare("UPDATE tasks SET retry_count = 3 WHERE id = ?").run("test-001");
      queue.recoverFromCrash();
      expect(queue.getById("test-001")?.status).toBe("failed");
    });

    it("T-TQ-022: does not touch awaiting_approval tasks", () => {
      queue.push(makeInput());
      queue.updateStatus("test-001", "in_progress");
      queue.updateStatus("test-001", "awaiting_approval", { approvalPrUrl: "https://pr/1" });
      queue.recoverFromCrash();
      expect(queue.getById("test-001")?.status).toBe("awaiting_approval");
    });

    it("T-TQ-023: does not touch completed/failed tasks", () => {
      queue.push(makeInput({ id: "done" }));
      queue.push(makeInput({ id: "fail" }));
      queue.updateStatus("done", "in_progress");
      queue.updateStatus("done", "completed");
      queue.updateStatus("fail", "in_progress");
      queue.updateStatus("fail", "failed");
      queue.recoverFromCrash();
      expect(queue.getById("done")?.status).toBe("completed");
      expect(queue.getById("fail")?.status).toBe("failed");
    });
  });

  // === クエリ・集計 ===
  describe("queries", () => {
    it("T-TQ-024: isDuplicate detects existing source", () => {
      queue.push(makeInput({ source: "github_issue:42" }));
      expect(queue.isDuplicate("github_issue:42")).toBe(true);
      expect(queue.isDuplicate("github_issue:99")).toBe(false);
    });

    it("T-TQ-025: getByStatus filters correctly", () => {
      queue.push(makeInput({ id: "a" }));
      queue.push(makeInput({ id: "b" }));
      queue.updateStatus("a", "in_progress");
      expect(queue.getByStatus("pending")).toHaveLength(1);
      expect(queue.getByStatus("in_progress")).toHaveLength(1);
    });

    it("T-TQ-026: getAwaitingApproval returns tasks with PR URLs", () => {
      queue.push(makeInput());
      queue.updateStatus("test-001", "in_progress");
      queue.updateStatus("test-001", "awaiting_approval", { approvalPrUrl: "https://pr/1" });
      const tasks = queue.getAwaitingApproval();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.approvalPrUrl).toBe("https://pr/1");
    });

    it("T-TQ-027: getDailyDigest returns correct counts", () => {
      queue.push(makeInput({ id: "a" }));
      queue.push(makeInput({ id: "b" }));
      queue.push(makeInput({ id: "c" }));
      queue.updateStatus("a", "in_progress");
      queue.updateStatus("a", "completed", { costUsd: 0.5, turnsUsed: 10 });
      queue.updateStatus("b", "in_progress");
      queue.updateStatus("b", "completed", { costUsd: 0.3, turnsUsed: 8 });
      queue.updateStatus("c", "in_progress");
      queue.updateStatus("c", "failed");
      const digest = queue.getDailyDigest();
      expect(digest.completed).toBe(2);
      expect(digest.failed).toBe(1);
      expect(digest.totalCostUsd).toBeCloseTo(0.8);
    });

    it("T-TQ-028: cancelPipelineSuccessors cancels all", () => {
      queue.push(makeInput({ id: "parent", source: "parent" }));
      queue.push(makeInput({ id: "a", parentTaskId: "parent", source: "s1" }));
      queue.push(makeInput({ id: "b", dependsOn: "a", parentTaskId: "parent", source: "s2" }));
      queue.push(makeInput({ id: "c", dependsOn: "b", parentTaskId: "parent", source: "s3" }));
      queue.cancelPipelineSuccessors("parent", "a");
      expect(queue.getById("b")?.status).toBe("failed");
      expect(queue.getById("c")?.status).toBe("failed");
    });

    it("T-TQ-029: transaction atomicity on batch push error", () => {
      const tasks = [
        makeInput({ id: "ok1" }),
        makeInput({ id: "ok2" }),
      ];
      queue.pushPipeline(tasks);
      expect(queue.getById("ok1")).toBeDefined();
      expect(queue.getById("ok2")).toBeDefined();

      // Try pushing with duplicate - should fail atomically
      const badTasks = [
        makeInput({ id: "new1" }),
        makeInput({ id: "ok1" }), // duplicate
      ];
      expect(() => { queue.pushPipeline(badTasks); }).toThrow();
      // new1 should NOT exist due to rollback
      expect(queue.getById("new1")).toBeUndefined();
    });
  });
});
