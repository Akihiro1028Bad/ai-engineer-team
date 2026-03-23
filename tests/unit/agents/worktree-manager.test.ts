import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorktreeManager } from "../../../src/agents/worktree-manager.js";

describe("WorktreeManager (Per-Task)", () => {
  let execMock: ReturnType<typeof vi.fn>;
  let manager: WorktreeManager;

  beforeEach(() => {
    execMock = vi.fn();
    manager = new WorktreeManager("/home/user/worktrees", "/home/user/project", execMock);
  });

  it("creates worktree with taskId-based path and branch", () => {
    execMock.mockReturnValue(Buffer.from(""));
    const path = manager.prepare("gh-42-0");
    expect(path).toBe("/home/user/worktrees/gh-42-0");
    const cmds = execMock.mock.calls.map((c: unknown[]) => String(c[0]));
    const branchCmd = cmds.find((c) => c.includes("agent/gh-42-0"));
    expect(branchCmd).toBeDefined();
  });

  it("uses agent/{taskId} branch naming", () => {
    expect(manager.getBranchName("gh-42-0")).toBe("agent/gh-42-0");
    expect(manager.getBranchName("gh-100-scope-1-0")).toBe("agent/gh-100-scope-1-0");
  });

  it("returns correct worktree path", () => {
    expect(manager.getWorktreePath("gh-42-0")).toBe("/home/user/worktrees/gh-42-0");
    expect(manager.getWorktreePath("manual-1")).toBe("/home/user/worktrees/manual-1");
  });

  it("cleanup removes worktree and branch", () => {
    execMock.mockReturnValue(Buffer.from(""));
    manager.cleanup("gh-42-0");
    const cmds = execMock.mock.calls.map((c: unknown[]) => String(c[0]));
    const removeCmd = cmds.find((c) => c.includes("worktree remove"));
    const deleteCmd = cmds.find((c) => c.includes("branch -D"));
    expect(removeCmd).toContain("gh-42-0");
    expect(deleteCmd).toContain("agent/gh-42-0");
  });

  it("handles exec errors gracefully", () => {
    execMock.mockImplementation(() => {
      throw new Error("git error");
    });
    expect(() => manager.cleanup("gh-42-0")).not.toThrow();
  });

  it("each task gets its own directory", () => {
    execMock.mockReturnValue(Buffer.from(""));
    const path1 = manager.prepare("gh-42-0");
    const path2 = manager.prepare("gh-43-0");
    expect(path1).toBe("/home/user/worktrees/gh-42-0");
    expect(path2).toBe("/home/user/worktrees/gh-43-0");
    expect(path1).not.toBe(path2);
  });

  it("commitAndPush uses taskId-based path", () => {
    execMock.mockReturnValue(Buffer.from("M file.ts")); // hasDiff returns true
    manager.commitAndPush("gh-42-0", "fix: something");
    const cmds = execMock.mock.calls.map((c: unknown[]) => String(c[0]));
    const addCmd = cmds.find((c) => c.includes("add -A"));
    expect(addCmd).toContain("worktrees/gh-42-0");
  });

  it("hasDiff checks correct worktree path", () => {
    execMock.mockReturnValue(Buffer.from(""));
    const result = manager.hasDiff("gh-42-0");
    expect(result).toBe(false);

    execMock.mockReturnValue(Buffer.from("M src/file.ts"));
    const result2 = manager.hasDiff("gh-42-0");
    expect(result2).toBe(true);
  });
});
