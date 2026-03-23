import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import type pino from "pino";

export interface SkillMetadata {
  name: string;
  description: string;
  version: number;
  createdBy: "toolforge" | "human";
  safetyLevel: "read_only" | "write_local" | "write_external";
  usageCount: number;
  successRate: number;
  approvalStatus: "pending_review" | "approved" | "deprecated";
  tags: string[];
  createdAt: string;
}

/** スキルの自動廃止条件 */
const DEPRECATION_UNUSED_DAYS = 30;
const DEPRECATION_MIN_SUCCESS_RATE = 0.5;
const PROMOTION_MIN_SUCCESS_RATE = 0.8;
const PROMOTION_MIN_USAGE = 10;

/**
 * Skill Registry: 生成されたスキルの管理。
 * 使用回数、成功率を追跡し、ライフサイクル（承認→使用→改善→廃止）を管理する。
 */
export class SkillRegistry {
  private readonly skills = new Map<string, SkillMetadata>();

  constructor(
    private readonly skillsDir: string,
    private readonly logger: pino.Logger,
  ) {
    this.loadFromDisk();
  }

  /** ディスクからスキルメタデータを読み込む */
  private loadFromDisk(): void {
    const toolsDir = join(this.skillsDir, "tools");
    if (!existsSync(toolsDir)) return;

    try {
      const dirs = readdirSync(toolsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);

      for (const dir of dirs) {
        const metaPath = join(toolsDir, dir, "metadata.json");
        if (!existsSync(metaPath)) continue;

        try {
          const raw = JSON.parse(readFileSync(metaPath, "utf-8")) as SkillMetadata;
          this.skills.set(raw.name, raw);
        } catch { /* corrupt metadata */ }
      }

      this.logger.info({ skillCount: this.skills.size }, "Skills loaded from disk");
    } catch {
      this.logger.warn("Failed to load skills from disk");
    }
  }

  /** スキルを登録する */
  register(metadata: SkillMetadata): void {
    this.skills.set(metadata.name, metadata);
    this.logger.info({ skill: metadata.name, status: metadata.approvalStatus }, "Skill registered");
  }

  /** 使用回数を記録する */
  recordUsage(name: string, success: boolean): void {
    const skill = this.skills.get(name);
    if (!skill) return;

    skill.usageCount += 1;
    // 移動平均で成功率を更新
    const alpha = 1 / Math.min(skill.usageCount, 50); // 最大50件の移動平均
    skill.successRate = skill.successRate * (1 - alpha) + (success ? 1 : 0) * alpha;
  }

  /** 承認済みスキルの一覧を取得する */
  getApproved(): SkillMetadata[] {
    return [...this.skills.values()].filter((s) => s.approvalStatus === "approved");
  }

  /** 全スキルの一覧を取得する */
  getAll(): SkillMetadata[] {
    return [...this.skills.values()];
  }

  /** スキルを名前で取得する */
  get(name: string): SkillMetadata | undefined {
    return this.skills.get(name);
  }

  /** ライフサイクル管理: 自動プロモーション/デプリケーション */
  evolve(): { promoted: string[]; deprecated: string[] } {
    const promoted: string[] = [];
    const deprecated: string[] = [];

    for (const [name, skill] of this.skills) {
      // 自動プロモーション: 成功率 >= 80% かつ使用回数 >= 10
      if (
        skill.approvalStatus === "pending_review" &&
        skill.safetyLevel === "read_only" &&
        skill.successRate >= PROMOTION_MIN_SUCCESS_RATE &&
        skill.usageCount >= PROMOTION_MIN_USAGE
      ) {
        skill.approvalStatus = "approved";
        promoted.push(name);
      }

      // 自動廃止: 成功率 < 50%
      if (skill.successRate < DEPRECATION_MIN_SUCCESS_RATE && skill.usageCount >= 10) {
        skill.approvalStatus = "deprecated";
        deprecated.push(name);
      }

      // 未使用廃止: 30日以上使用なし（createdAt からの経過で判定）
      const createdTime = new Date(skill.createdAt).getTime();
      const daysSinceCreation = (Date.now() - createdTime) / (24 * 60 * 60 * 1000);
      if (daysSinceCreation >= DEPRECATION_UNUSED_DAYS && skill.usageCount === 0) {
        skill.approvalStatus = "deprecated";
        deprecated.push(name);
      }
    }

    if (promoted.length > 0 || deprecated.length > 0) {
      this.logger.info({ promoted, deprecated }, "Skill lifecycle evolution");
    }

    return { promoted, deprecated };
  }
}
