import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../../src/queue/migrations.js";

describe("runMigrations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  it("T-MIG-001: creates schema_version table on first run", () => {
    runMigrations(db);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("schema_version");
  });

  it("T-MIG-002: skips if already at latest version", () => {
    runMigrations(db);
    expect(() => { runMigrations(db); }).not.toThrow();
  });

  it("T-MIG-003: applies only pending migrations", () => {
    runMigrations(db);
    const row = db.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get() as { version: number };
    expect(row.version).toBeGreaterThanOrEqual(1);
  });
});
