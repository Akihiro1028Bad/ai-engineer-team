import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../../../src/queue/schema.js";
import { TaskQueue } from "../../../src/queue/task-queue.js";
import { parseAndPush } from "../../../src/sources/manual-cli.js";

describe("parseAndPush (manual-cli)", () => {
  let queue: TaskQueue;

  beforeEach(() => {
    const db = new Database(":memory:");
    initSchema(db);
    queue = new TaskQueue(db);
  });

  it("T-CLI-001: succeeds with required args", () => {
    const result = parseAndPush(
      ["--type", "review", "--title", "Test", "--description", "Desc"],
      queue,
    );
    expect(result.success).toBe(true);
    expect(queue.getNext()).not.toBeNull();
  });

  it("T-CLI-002: fails when --type is missing", () => {
    const result = parseAndPush(["--title", "Test", "--description", "Desc"], queue);
    expect(result.success).toBe(false);
  });

  it("T-CLI-003: fails for invalid type", () => {
    const result = parseAndPush(
      ["--type", "deploy", "--title", "Test", "--description", "Desc"],
      queue,
    );
    expect(result.success).toBe(false);
  });

  it("T-CLI-004: accepts --priority", () => {
    const result = parseAndPush(
      ["--type", "review", "--title", "T", "--description", "D", "--priority", "1"],
      queue,
    );
    expect(result.success).toBe(true);
    const task = queue.getNext();
    expect(task?.priority).toBe(1);
  });

  it("T-CLI-005: generates manual-{N} ID", () => {
    parseAndPush(["--type", "review", "--title", "T", "--description", "D"], queue);
    const task = queue.getNext();
    expect(task?.id).toMatch(/^manual-\d+$/);
  });

  it("T-CLI-006: accepts --depends-on", () => {
    // Create dependency first
    parseAndPush(["--type", "review", "--title", "Parent", "--description", "D"], queue);
    const parent = queue.getNext()!;
    parseAndPush(
      ["--type", "fix", "--title", "Child", "--description", "D", "--depends-on", parent.id],
      queue,
    );
  });
});
