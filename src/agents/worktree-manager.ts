import { join } from "node:path";
import type { AgentRole } from "../types.js";

type ExecFn = (cmd: string) => Buffer;

export class WorktreeManager {
  constructor(
    private readonly worktreeDir: string,
    private readonly projectDir: string,
    private readonly exec: ExecFn,
  ) {}

  prepare(role: AgentRole, taskId: string): string {
    const worktreePath = join(this.worktreeDir, role);
    const branch = `agent/${role}/${taskId}`;

    try {
      // Create branch and checkout in worktree
      this.exec(
        `git -C ${this.projectDir} worktree add -B ${branch} ${worktreePath} HEAD 2>/dev/null || git -C ${worktreePath} checkout -B ${branch}`,
      );
    } catch {
      // Worktree may already exist; try switching branch
      try {
        this.exec(`git -C ${worktreePath} checkout -B ${branch}`);
      } catch {
        // Log and continue
      }
    }

    return worktreePath;
  }

  /** worktree 上に未コミットの変更があるかチェック */
  hasDiff(role: AgentRole): boolean {
    const worktreePath = join(this.worktreeDir, role);
    try {
      const result = this.exec(`git -C ${worktreePath} status --porcelain`);
      return result.toString().trim().length > 0;
    } catch {
      return false;
    }
  }

  /** worktree の変更を git add → commit → push する */
  commitAndPush(role: AgentRole, taskId: string, message: string): boolean {
    const worktreePath = join(this.worktreeDir, role);
    const branch = `agent/${role}/${taskId}`;

    try {
      if (!this.hasDiff(role)) {
        return false; // 変更なし
      }

      this.exec(`git -C ${worktreePath} add -A`);
      this.exec(`git -C ${worktreePath} commit -m "${message.replace(/"/g, '\\"')}"`);
      this.exec(`git -C ${worktreePath} push -u origin ${branch}`);
      return true;
    } catch {
      return false;
    }
  }

  /** ブランチ名を返す */
  getBranchName(role: AgentRole, taskId: string): string {
    return `agent/${role}/${taskId}`;
  }

  cleanup(role: AgentRole, taskId: string): void {
    const branch = `agent/${role}/${taskId}`;
    const worktreePath = join(this.worktreeDir, role);

    try {
      this.exec(`git -C ${worktreePath} checkout main 2>/dev/null || true`);
      this.exec(`git -C ${this.projectDir} branch -D ${branch} 2>/dev/null || true`);
    } catch {
      // Cleanup is best-effort
    }
  }
}
