import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../../../src/queue/schema.js";
import { TaskQueue } from "../../../src/queue/task-queue.js";
import { CronScheduler } from "../../../src/sources/cron-scheduler.js";

describe("CronScheduler", () => {
  let queue: TaskQueue;
  let scheduler: CronScheduler;

  beforeEach(() => {
    const db = new Database(":memory:");
    initSchema(db);
    queue = new TaskQueue(db);
    scheduler = new CronScheduler(queue);
  });

  it("T-CRN-001: creates review task at 03:00", () => {
    const now = new Date("2026-03-22T03:00:00");
    scheduler.checkAndCreateTasks(now);
    const task = queue.getNext();
    expect(task).not.toBeNull();
    expect(task?.taskType).toBe("review");
  });

  it("T-CRN-002: creates document task on Monday 09:00", () => {
    // 2026-03-23 is Monday
    const now = new Date("2026-03-23T09:00:00");
    scheduler.checkAndCreateTasks(now);
    const tasks = queue.getByStatus("pending");
    const docTask = tasks.find((t) => t.taskType === "document");
    expect(docTask).toBeDefined();
  });

  it("T-CRN-003: creates nothing at 15:00", () => {
    const now = new Date("2026-03-22T15:00:00");
    scheduler.checkAndCreateTasks(now);
    expect(queue.getNext()).toBeNull();
  });

  it("T-CRN-004: task ID has correct format", () => {
    const now = new Date("2026-03-22T03:00:00");
    scheduler.checkAndCreateTasks(now);
    const task = queue.getNext();
    expect(task?.id).toMatch(/^cron-review-0322$/);
  });

  it("T-CRN-005: skips duplicate on same day", () => {
    const now = new Date("2026-03-22T03:00:00");
    scheduler.checkAndCreateTasks(now);
    scheduler.checkAndCreateTasks(now);
    expect(queue.getByStatus("pending")).toHaveLength(1);
  });
});
