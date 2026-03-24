import { readFileSync } from "node:fs";

import { z } from "zod";

import { RepoConfigSchema } from "../types.js";

const ReposConfigFileSchema = z.array(RepoConfigSchema);

export type ReposConfig = z.infer<typeof ReposConfigFileSchema>;

/**
 * repos.json からマルチリポジトリ設定を読み込む。
 * ファイルが存在しない場合は単一リポジトリモード（env 変数から構成）にフォールバック。
 */
export function loadReposConfig(
  reposJsonPath: string | undefined,
  fallback: { githubRepo: string; projectDir: string; worktreeDir: string },
): ReposConfig {
  if (reposJsonPath) {
    try {
      const content = readFileSync(reposJsonPath, "utf-8");
      const raw = JSON.parse(content) as unknown;
      const parsed = ReposConfigFileSchema.safeParse(raw);
      if (parsed.success) {
        return parsed.data.filter((r) => r.enabled);
      }
      throw new Error(`repos.json validation failed: ${parsed.error.message}`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // ファイルが存在しない → フォールバック
      } else {
        throw error;
      }
    }
  }

  // 単一リポジトリフォールバック
  const repoName = fallback.githubRepo.split("/")[1] ?? "default";
  return [{
    id: repoName,
    githubRepo: fallback.githubRepo,
    projectDir: fallback.projectDir,
    worktreeDir: fallback.worktreeDir,
    enabled: true,
    maxConcurrent: 1,
  }];
}
