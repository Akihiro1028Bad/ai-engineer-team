import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeHandoff, readHandoff, buildPromptInsert } from "../../../src/bridges/context-bridge.js";
import type { Handoff } from "../../../src/types.js";

const sampleHandoff: Handoff = {
  taskId: "gh-42-0",
  agent: "Reviewer",
  timestamp: "2026-03-22T03:15:00+09:00",
  data: { findings: [{ severity: "critical", file: "src/auth.ts" }], summary: "1 issue found" },
};

describe("context-bridge", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "context-bridge-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("T-CB-001: writes handoff JSON file", () => {
    writeHandoff(sampleHandoff, tmpDir);
    const filePath = join(tmpDir, "gh-42-0_Reviewer.json");
    expect(existsSync(filePath)).toBe(true);
  });

  it("T-CB-002: reads handoff JSON and validates", () => {
    writeHandoff(sampleHandoff, tmpDir);
    const result = readHandoff("gh-42-0", "Reviewer", tmpDir);
    expect(result).not.toBeNull();
    expect(result?.taskId).toBe("gh-42-0");
    expect(result?.agent).toBe("Reviewer");
  });

  it("T-CB-003: returns null for missing file", () => {
    const result = readHandoff("nonexistent", "Agent", tmpDir);
    expect(result).toBeNull();
  });

  it("T-CB-004: returns null for invalid JSON", () => {
    const filePath = join(tmpDir, "bad-0_Bad.json");
    writeFileSync(filePath, "not valid json {{{");
    const result = readHandoff("bad-0", "Bad", tmpDir);
    expect(result).toBeNull();
  });

  it("T-CB-005: creates directory if not exists", () => {
    const nestedDir = join(tmpDir, "sub", "handoff");
    writeHandoff(sampleHandoff, nestedDir);
    expect(existsSync(nestedDir)).toBe(true);
  });

  it("T-CB-006: builds prompt insert text", () => {
    const text = buildPromptInsert(sampleHandoff);
    expect(text).toContain("gh-42-0");
    expect(text).toContain("Reviewer");
    expect(text).toContain("2026-03-22");
    expect(text).toContain("findings");
  });
});
