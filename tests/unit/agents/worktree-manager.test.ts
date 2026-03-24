import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorktreeManager } from "../../../src/agents/worktree-manager.js";

describe("WorktreeManager (Per-Task)", () => {
  let execMock: ReturnType<typeof vi.fn>;
  let manager: WorktreeManager;

  /** Helper: join exec calls into readable strings for assertion */
  function getExecCalls(): string[] {
    return execMock.mock.calls.map((c: unknown[]) => {
      const cmd = String(c[0]);
      const args = Array.isArray(c[1]) ? (c[1] as string[]).join(" ") : "";
      return `${cmd} ${args}`.trim();
    });
  }

  beforeEach(() => {
    execMock = vi.fn().mockReturnValue(Buffer.from(""));
    manager = new WorktreeManager("/home/user/worktrees", "/home/user/project", execMock);
  });

  it("creates worktree with taskId-based path and branch", () => {
    const path = manager.prepare("gh-42-0");
    expect(path).toBe("/home/user/worktrees/gh-42-0");
    const cmds = getExecCalls();
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
    manager.cleanup("gh-42-0");
    const cmds = getExecCalls();
    const removeCmd = cmds.find((c) => c.includes("worktree remove"));
    const deleteCmd = cmds.find((c) => c.includes("branch -D"));
    expect(removeCmd).toContain("gh-42-0");
    expect(deleteCmd).toContain("agent/gh-42-0");
  });

  it("handles exec errors gracefully", () => {
    execMock.mockImplementation(() => {
      throw new Error("git error");
    });
    expect(() => { manager.cleanup("gh-42-0"); }).not.toThrow();
  });

  it("each task gets its own directory", () => {
    const path1 = manager.prepare("gh-42-0");
    const path2 = manager.prepare("gh-43-0");
    expect(path1).toBe("/home/user/worktrees/gh-42-0");
    expect(path2).toBe("/home/user/worktrees/gh-43-0");
    expect(path1).not.toBe(path2);
  });

  it("commitAndPush uses taskId-based path", () => {
    execMock.mockReturnValue(Buffer.from("M file.ts"));
    manager.commitAndPush("gh-42-0", "fix: something");
    const cmds = getExecCalls();
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
