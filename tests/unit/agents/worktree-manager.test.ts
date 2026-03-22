import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorktreeManager } from "../../../src/agents/worktree-manager.js";

describe("WorktreeManager", () => {
  let execMock: ReturnType<typeof vi.fn>;
  let manager: WorktreeManager;

  beforeEach(() => {
    execMock = vi.fn();
    manager = new WorktreeManager("/home/user/worktrees", "/home/user/project", execMock);
  });

  it("T-WTM-001: creates worktree and branch", () => {
    execMock.mockReturnValue(Buffer.from(""));
    const path = manager.prepare("reviewer", "gh-42-0");
    expect(path).toBe("/home/user/worktrees/reviewer");
    expect(execMock).toHaveBeenCalled();
    const cmd = execMock.mock.calls.map((c: unknown[]) => String(c[0])).join(" ");
    expect(cmd).toContain("agent/reviewer/gh-42-0");
  });

  it("T-WTM-002: uses correct branch naming", () => {
    execMock.mockReturnValue(Buffer.from(""));
    manager.prepare("fixer", "gh-42-1");
    const cmds = execMock.mock.calls.map((c: unknown[]) => String(c[0]));
    const branchCmd = cmds.find((c) => c.includes("agent/fixer/gh-42-1"));
    expect(branchCmd).toBeDefined();
  });

  it("T-WTM-003: cleanup removes branch", () => {
    execMock.mockReturnValue(Buffer.from(""));
    manager.cleanup("reviewer", "gh-42-0");
    const cmds = execMock.mock.calls.map((c: unknown[]) => String(c[0]));
    const deleteCmd = cmds.find((c) => c.includes("branch") && c.includes("-D"));
    expect(deleteCmd).toContain("agent/reviewer/gh-42-0");
  });

  it("T-WTM-004: handles exec errors gracefully", () => {
    execMock.mockImplementation(() => {
      throw new Error("git error");
    });
    // Should not throw — logs error instead
    expect(() => manager.cleanup("reviewer", "gh-42-0")).not.toThrow();
  });

  it("T-WTM-005: returns correct worktree path for each role", () => {
    execMock.mockReturnValue(Buffer.from(""));
    expect(manager.prepare("builder", "t1")).toBe("/home/user/worktrees/builder");
    expect(manager.prepare("scribe", "t2")).toBe("/home/user/worktrees/scribe");
  });
});
