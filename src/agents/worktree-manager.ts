import { join } from "node:path";

type ExecFn = (cmd: string) => Buffer;

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
      this.exec(`git -C ${this.projectDir} fetch origin main`);
    } catch {
      // fetch 失敗はネットワーク障害等 — 続行
    }

    // 2. 既存の worktree があれば削除（クリーンスタート）
    try {
      this.exec(`git -C ${this.projectDir} worktree remove ${worktreePath} --force 2>/dev/null || true`);
    } catch { /* ignore */ }

    // 3. 既存の同名ブランチがあれば削除
    try {
      this.exec(`git -C ${this.projectDir} branch -D ${branch} 2>/dev/null || true`);
    } catch { /* ignore */ }

    // 4. worktree を作成（origin/main ベース）
    try {
      this.exec(`git -C ${this.projectDir} worktree add ${worktreePath} -b ${branch} origin/main`);
    } catch {
      // origin/main がない場合は HEAD から作成
      try {
        this.exec(`git -C ${this.projectDir} worktree add ${worktreePath} -b ${branch} HEAD`);
      } catch {
        // 最終手段: detached HEAD で作成
        this.exec(`git -C ${this.projectDir} worktree add ${worktreePath} --detach`);
        try {
          this.exec(`git -C ${worktreePath} checkout -B ${branch}`);
        } catch { /* continue with detached */ }
      }
    }

    return worktreePath;
  }

  /**
   * 既存ブランチを worktree にチェックアウトする。
   * 設計→実装で同一ブランチを再利用する場合に使用。
   */
  prepareExistingBranch(taskId: string, branch: string): string {
    const worktreePath = this.getWorktreePath(taskId);

    // リモートの最新を取得
    try {
      this.exec(`git -C ${this.projectDir} fetch origin ${branch} 2>/dev/null || true`);
    } catch { /* ignore */ }

    // 既存 worktree があればそのままブランチ切り替え
    try {
      this.exec(`git -C ${worktreePath} checkout ${branch}`);
      this.exec(`git -C ${worktreePath} pull origin ${branch} 2>/dev/null || true`);
      return worktreePath;
    } catch { /* worktree が存在しない or チェックアウト失敗 */ }

    // worktree を新規作成してブランチをチェックアウト
    try {
      this.exec(`git -C ${this.projectDir} worktree remove ${worktreePath} --force 2>/dev/null || true`);
    } catch { /* ignore */ }

    try {
      this.exec(`git -C ${this.projectDir} worktree add ${worktreePath} ${branch}`);
    } catch {
      try {
        this.exec(`git -C ${this.projectDir} worktree add ${worktreePath} -b ${branch} origin/${branch}`);
      } catch {
        // フォールバック: 新規ブランチとして作成
        this.exec(`git -C ${this.projectDir} worktree add ${worktreePath} -b ${branch} origin/main`);
      }
    }

    return worktreePath;
  }

  /** worktree 上に未コミットの変更があるかチェック */
  hasDiff(taskId: string): boolean {
    const worktreePath = this.getWorktreePath(taskId);
    try {
      const result = this.exec(`git -C ${worktreePath} status --porcelain`);
      return result.toString().trim().length > 0;
    } catch {
      return false;
    }
  }

  /** worktree の変更を git add → commit → push する */
  commitAndPush(taskId: string, message: string): boolean {
    const worktreePath = this.getWorktreePath(taskId);

    try {
      if (!this.hasDiff(taskId)) {
        return false; // 変更なし
      }

      // 現在のブランチ名を取得
      const branchOutput = this.exec(`git -C ${worktreePath} rev-parse --abbrev-ref HEAD`).toString().trim();
      const branch = branchOutput || this.getBranchName(taskId);

      this.exec(`git -C ${worktreePath} add -A`);
      this.exec(`git -C ${worktreePath} commit -m "${message.replace(/"/g, '\\"')}"`);
      this.exec(`git -C ${worktreePath} push -u origin ${branch}`);
      return true;
    } catch {
      return false;
    }
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
      this.exec(`git -C ${this.projectDir} worktree remove ${worktreePath} --force 2>/dev/null || true`);
    } catch { /* best-effort */ }

    try {
      this.exec(`git -C ${this.projectDir} branch -D ${branch} 2>/dev/null || true`);
    } catch { /* best-effort */ }
  }

  /** 全 worktree を一括削除（メンテナンス用） */
  cleanupAll(): void {
    try {
      const output = this.exec(`git -C ${this.projectDir} worktree list --porcelain`).toString();
      const paths = output.split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.replace("worktree ", ""))
        .filter((path) => path !== this.projectDir && path.startsWith(this.worktreeDir));

      for (const path of paths) {
        try {
          this.exec(`git -C ${this.projectDir} worktree remove ${path} --force`);
        } catch { /* continue */ }
      }

      // agent/ ブランチを一括削除
      try {
        const branches = this.exec(`git -C ${this.projectDir} branch --list "agent/*"`).toString().trim();
        for (const branch of branches.split("\n").map((b) => b.trim()).filter(Boolean)) {
          try {
            this.exec(`git -C ${this.projectDir} branch -D ${branch}`);
          } catch { /* continue */ }
        }
      } catch { /* no agent branches */ }
    } catch {
      // git worktree list 自体が失敗した場合は何もしない
    }
  }
}
