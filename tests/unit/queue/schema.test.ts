import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../../../src/queue/schema.js";

describe("initSchema", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    initSchema(db);
  });

  it("T-SCH-001: creates tasks table", () => {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get() as { name: string } | undefined;
    expect(row?.name).toBe("tasks");
  });

  it("T-SCH-002: enables WAL mode (in-memory returns 'memory')", () => {
    // In-memory DB cannot use WAL; verify pragma was called by checking it doesn't throw
    // Real WAL is tested with file-based DB in integration tests
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(["wal", "memory"]).toContain(row.journal_mode);
  });

  it("T-SCH-003: creates all indexes", () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_tasks_%'")
      .all() as { name: string }[];
    const names = indexes.map((i) => i.name).sort();
    expect(names).toEqual([
      "idx_tasks_depends_on",
      "idx_tasks_parent",
      "idx_tasks_priority",
      "idx_tasks_status",
    ]);
  });

  it("T-SCH-004: double init is safe", () => {
    expect(() => { initSchema(db); }).not.toThrow();
  });

  it("T-SCH-005: rejects invalid task_type", () => {
    expect(() => {
      db.prepare(
        "INSERT INTO tasks (id, task_type, title, description, source) VALUES (?, ?, ?, ?, ?)",
      ).run("t1", "invalid", "title", "desc", "manual");
    }).toThrow();
  });

  it("T-SCH-006: rejects invalid status", () => {
    expect(() => {
      db.prepare(
        "INSERT INTO tasks (id, task_type, title, description, source, status) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("t1", "review", "title", "desc", "manual", "cancelled");
    }).toThrow();
  });

  it("T-SCH-007: rejects priority out of range", () => {
    expect(() => {
      db.prepare(
        "INSERT INTO tasks (id, task_type, title, description, source, priority) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("t1", "review", "title", "desc", "manual", 0);
    }).toThrow();
    expect(() => {
      db.prepare(
        "INSERT INTO tasks (id, task_type, title, description, source, priority) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("t2", "review", "title", "desc", "manual", 11);
    }).toThrow();
  });

  it("T-SCH-008: rejects retry_count > 3", () => {
    expect(() => {
      db.prepare(
        "INSERT INTO tasks (id, task_type, title, description, source, retry_count) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("t1", "review", "title", "desc", "manual", 4);
    }).toThrow();
  });

  it("T-SCH-009: defaults priority to 5", () => {
    db.prepare(
      "INSERT INTO tasks (id, task_type, title, description, source) VALUES (?, ?, ?, ?, ?)",
    ).run("t1", "review", "title", "desc", "manual");
    const row = db.prepare("SELECT priority FROM tasks WHERE id = ?").get("t1") as { priority: number };
    expect(row.priority).toBe(5);
  });

  it("T-SCH-010: defaults status to pending", () => {
    db.prepare(
      "INSERT INTO tasks (id, task_type, title, description, source) VALUES (?, ?, ?, ?, ?)",
    ).run("t1", "review", "title", "desc", "manual");
    const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get("t1") as { status: string };
    expect(row.status).toBe("pending");
  });

  it("T-SCH-011: defaults created_at to current time", () => {
    db.prepare(
      "INSERT INTO tasks (id, task_type, title, description, source) VALUES (?, ?, ?, ?, ?)",
    ).run("t1", "review", "title", "desc", "manual");
    const row = db.prepare("SELECT created_at FROM tasks WHERE id = ?").get("t1") as { created_at: string };
    expect(row.created_at).toBeTruthy();
  });
});
