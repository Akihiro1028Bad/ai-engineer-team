import { execSync } from "node:child_process";

import type pino from "pino";

export interface ConflictResolutionResult {
  resolved: boolean;
  method: "rebase" | "manual_required" | "no_conflict";
  message: string;
}

/**
 * マージコンフリクト自動解決。
 * push 失敗時に rebase を試行し、解決不可なら手動要請。
 */
export class MergeConflictResolver {
  constructor(private readonly logger: pino.Logger) {}

  /** push 失敗後にコンフリクト解決を試みる */
  resolve(cwd: string, branch: string): ConflictResolutionResult {
    try {
      // まず最新を fetch
      execSync("git fetch origin", { cwd, stdio: "pipe" });

      // rebase を試行
      try {
        execSync(`git rebase origin/${branch}`, { cwd, stdio: "pipe" });

        // rebase 成功 → テスト実行で検証
        const testPassed = this.runQuickTest(cwd);
        if (!testPassed) {
          // rebase は成功したがテストが壊れた → abort
          try { execSync("git rebase --abort", { cwd, stdio: "pipe" }); } catch { /* ignore */ }
          return {
            resolved: false,
            method: "manual_required",
            message: "Rebase は成功しましたがテストが失敗しました。手動での解決が必要です。",
          };
        }

        // push
        execSync(`git push origin ${branch}`, { cwd, stdio: "pipe" });

        this.logger.info({ branch }, "Merge conflict resolved via rebase");
        return {
          resolved: true,
          method: "rebase",
          message: "Rebase + テスト検証で自動解決しました。",
        };
      } catch {
        // rebase 失敗 → abort して手動要請
        try { execSync("git rebase --abort", { cwd, stdio: "pipe" }); } catch { /* ignore */ }

        this.logger.warn({ branch }, "Rebase failed, manual resolution required");
        return {
          resolved: false,
          method: "manual_required",
          message: "自動 rebase に失敗しました。手動でのコンフリクト解決が必要です。",
        };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.logger.error({ branch, error: message }, "Conflict resolution failed");
      return {
        resolved: false,
        method: "manual_required",
        message: `コンフリクト解決中にエラー: ${message}`,
      };
    }
  }

  /** 簡易テスト実行（型チェックのみ） */
  private runQuickTest(cwd: string): boolean {
    try {
      execSync("npx tsc --noEmit", { cwd, stdio: "pipe", timeout: 30_000 });
      return true;
    } catch {
      return false;
    }
  }
}
