import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readdirSync, utimesSync, mkdirSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rotateOldLogs } from "../../../src/logging/log-rotation.js";

describe("rotateOldLogs", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "log-rotation-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createFileWithAge(name: string, daysOld: number): void {
    const filePath = join(tmpDir, name);
    writeFileSync(filePath, "test log line\n");
    const pastDate = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
    utimesSync(filePath, pastDate, pastDate);
  }

  it("T-LR-001: retains logs within 30 days", () => {
    createFileWithAge("2026-03-20.jsonl", 29);
    rotateOldLogs(tmpDir, 30);
    expect(existsSync(join(tmpDir, "2026-03-20.jsonl"))).toBe(true);
  });

  it("T-LR-002: deletes logs older than 30 days", () => {
    createFileWithAge("2026-02-15.jsonl", 31);
    rotateOldLogs(tmpDir, 30);
    expect(existsSync(join(tmpDir, "2026-02-15.jsonl"))).toBe(false);
  });

  it("T-LR-003: handles empty directory", () => {
    expect(() => rotateOldLogs(tmpDir, 30)).not.toThrow();
  });

  it("T-LR-004: ignores non-jsonl files", () => {
    createFileWithAge("notes.txt", 31);
    rotateOldLogs(tmpDir, 30);
    expect(existsSync(join(tmpDir, "notes.txt"))).toBe(true);
  });

  it("T-LR-005: creates directory if it does not exist", () => {
    const missingDir = join(tmpDir, "sub", "logs");
    expect(() => rotateOldLogs(missingDir, 30)).not.toThrow();
    expect(existsSync(missingDir)).toBe(true);
  });
});
