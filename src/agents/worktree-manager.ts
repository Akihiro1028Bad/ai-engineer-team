import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";

type ExecFn = (cmd: string, args: string[]) => Buffer;

export interface CommitAndPushResult {
  status: "no_diff" | "pushed" | "commit_failed" | "push_failed";
  error?: string;
  branch?: string;
}

/**
 * Per-Task Worktree Manager
 *
 * タスクごとにオンデマンドで git worktree を作成し、完了後に自動削除する。
 * ディレクトリ: {worktreeDir}/{taskId}/
 * ブランチ: agent/{taskId}
 */
export class WorktreeManager {
  constructor(
    private readonly worktreeDir: string,
    private readonly projectDir: string,
    private readonly exec: ExecFn,
  ) {}

  /** タスク用の worktree を新規作成する */
  prepare(taskId: string): string {
    const worktreePath = this.getWorktreePath(taskId);
    const branch = this.getBranchName(taskId);

    // 1. リモートの最新 main を取得
    try {
      this.exec("git", ["-C", this.projectDir, "fetch", "origin", "main"]);
    } catch {
      // fetch 失敗はネットワーク障害等 — 続行
    }

    // 2. 既存の worktree があれば削除（クリーンスタート）
    try {
      this.exec("git", ["-C", this.projectDir, "worktree", "remove", worktreePath, "--force"]);
    } catch { /* ignore */ }

    // 2.5. stale worktree エントリを prune し、残留ディレクトリも削除
    try {
      this.exec("git", ["-C", this.projectDir, "worktree", "prune"]);
    } catch { /* ignore */ }
    if (existsSync(worktreePath)) {
      try {
        rmSync(worktreePath, { recursive: true, force: true });
      } catch { /* ignore */ }
    }

    // 3. 既存の同名ブランチがあれば削除
    try {
      this.exec("git", ["-C", this.projectDir, "branch", "-D", branch]);
    } catch { /* ignore */ }

    // 4. worktree を作成（origin/main ベース）
    try {
      this.exec("git", ["-C", this.projectDir, "worktree", "add", worktreePath, "-b", branch, "origin/main"]);
    } catch {
      // origin/main がない場合は HEAD から作成
      try {
        this.exec("git", ["-C", this.projectDir, "worktree", "add", worktreePath, "-b", branch, "HEAD"]);
      } catch {
        // 最終手段: detached HEAD で作成
        this.exec("git", ["-C", this.projectDir, "worktree", "add", worktreePath, "--detach"]);
        try {
          this.exec("git", ["-C", worktreePath, "checkout", "-B", branch]);
        } catch { /* continue with detached */ }
      }
    }

    return worktreePath;
  }

  /**
   * 既存ブランチをベースに新しい worktree を作成する（設計→実装の引き継ぎ用）。
   * Git の制約: 1ブランチは1 worktree にしかチェックアウトできない。
   * そのため taskId 固有のブランチ agent/{taskId} を baseBranch から派生させる。
   */
  prepareExistingBranch(taskId: string, baseBranch: string): string {
    const worktreePath = this.getWorktreePath(taskId);
    const newBranch = this.getBranchName(taskId);

    // リモートの最新を取得
    try {
      this.exec("git", ["-C", this.projectDir, "fetch", "origin", baseBranch]);
    } catch { /* ignore */ }

    // 既存 worktree があればそのまま使う
    if (existsSync(worktreePath)) {
      try {
        this.exec("git", ["-C", worktreePath, "rev-parse", "--git-dir"]);
        return worktreePath;
      } catch { /* stale directory */ }
    }

    // 掃除
    try {
      this.exec("git", ["-C", this.projectDir, "worktree", "remove", worktreePath, "--force"]);
    } catch { /* ignore */ }
    try {
      this.exec("git", ["-C", this.projectDir, "worktree", "prune"]);
    } catch { /* ignore */ }
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch { /* ignore */ }

    // 古いブランチがあれば削除
    try {
      this.exec("git", ["-C", this.projectDir, "branch", "-D", newBranch]);
    } catch { /* ignore */ }

    // baseBranch をベースに新しいブランチで worktree を作成
    let base = baseBranch;
    try {
      this.exec("git", ["-C", this.projectDir, "rev-parse", "--verify", baseBranch]);
    } catch {
      base = `origin/${baseBranch}`;
    }

    try {
      this.exec("git", ["-C", this.projectDir, "worktree", "add", worktreePath, "-b", newBranch, base]);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create worktree for ${newBranch} from ${baseBranch}: ${msg}`);
    }

    return worktreePath;
  }

  /** worktree 上に未コミットの変更があるかチェック */
  hasDiff(taskId: string): boolean {
    const worktreePath = this.getWorktreePath(taskId);
    try {
      const result = this.exec("git", ["-C", worktreePath, "status", "--porcelain"]);
      return result.toString().trim().length > 0;
    } catch {
      return false;
    }
  }

  /** worktree の変更を git add → commit → push する。targetBranch を指定するとリモートの別ブランチにpushする */
  commitAndPush(taskId: string, message: string, targetBranch?: string): CommitAndPushResult {
    const worktreePath = this.getWorktreePath(taskId);

    if (!this.hasDiff(taskId)) {
      return { status: "no_diff" };
    }

    // 現在のブランチ名を取得
    const branchOutput = this.exec("git", ["-C", worktreePath, "rev-parse", "--abbrev-ref", "HEAD"]).toString().trim();
    const branch = branchOutput || this.getBranchName(taskId);
    const pushBranch = targetBranch ?? branch;

    try {
      this.exec("git", ["-C", worktreePath, "add", "-A"]);
      this.exec("git", ["-C", worktreePath, "commit", "-m", message]);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return { status: "commit_failed", error: msg };
    }

    try {
      this.exec("git", ["-C", worktreePath, "push", "-u", "origin", `${branch}:${pushBranch}`]);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      return { status: "push_failed", error: msg, branch: pushBranch };
    }

    return { status: "pushed", branch: pushBranch };
  }

  /** ブランチ名を返す */
  getBranchName(taskId: string): string {
    return `agent/${taskId}`;
  }

  /** worktree のパスを返す */
  getWorktreePath(taskId: string): string {
    return join(this.worktreeDir, taskId);
  }

  /** タスク完了後のクリーンアップ（worktree 削除 + ブランチ削除） */
  cleanup(taskId: string): void {
    const worktreePath = this.getWorktreePath(taskId);
    const branch = this.getBranchName(taskId);

    try {
      this.exec("git", ["-C", this.projectDir, "worktree", "remove", worktreePath, "--force"]);
    } catch { /* best-effort */ }

    try {
      this.exec("git", ["-C", this.projectDir, "branch", "-D", branch]);
    } catch { /* best-effort */ }
  }

  /** 全 worktree を一括削除（メンテナンス用） */
  cleanupAll(): void {
    try {
      const output = this.exec("git", ["-C", this.projectDir, "worktree", "list", "--porcelain"]).toString();
      const paths = output.split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.replace("worktree ", ""))
        .filter((path) => path !== this.projectDir && path.startsWith(this.worktreeDir));

      for (const path of paths) {
        try {
          this.exec("git", ["-C", this.projectDir, "worktree", "remove", path, "--force"]);
        } catch { /* continue */ }
      }

      // agent/ ブランチを一括削除
      try {
        const branches = this.exec("git", ["-C", this.projectDir, "branch", "--list", "agent/*"]).toString().trim();
        for (const branch of branches.split("\n").map((b) => b.trim()).filter(Boolean)) {
          try {
            this.exec("git", ["-C", this.projectDir, "branch", "-D", branch]);
          } catch { /* continue */ }
        }
      } catch { /* no agent branches */ }
    } catch {
      // git worktree list 自体が失敗した場合は何もしない
    }
  }
}
