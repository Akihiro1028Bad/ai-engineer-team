import type pino from "pino";

import type { PatternMemoryStore } from "./pattern-memory.js";

type ModelChoice = "haiku" | "sonnet" | "opus";

interface ModelRouterConfig {
  /** 探索率 (0-1)。デフォルト 0.1 = 10% */
  explorationRate: number;
  /** コールドスタート閾値: この件数以上のサンプルがないとデフォルトを使用 */
  minSamples: number;
  /** 最低成功率: これ以下のモデルは選択しない */
  minSuccessRate: number;
  /** 探索時のコスト上限倍率: exploit の N 倍まで */
  maxExplorationCostMultiplier: number;
}

const DEFAULT_CONFIG: ModelRouterConfig = {
  explorationRate: 0.1,
  minSamples: 20,
  minSuccessRate: 0.8,
  maxExplorationCostMultiplier: 2.0,
};

/**
 * Epsilon-Greedy 適応型モデルルーティング。
 * - 90% Exploit: 最高パフォーマンス（成功率/コスト比）のモデルを選択
 * - 10% Explore: ランダムに別のモデルを試す（コスト上限付き）
 */
export class ModelRouter {
  private readonly config: ModelRouterConfig;

  constructor(
    private readonly patternMemory: PatternMemoryStore,
    private readonly logger: pino.Logger,
    config?: Partial<ModelRouterConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * タスクに最適なモデルを選択する。
   * @returns 選択されたモデルと理由
   */
  selectModel(
    agentRole: string,
    taskType: string,
    defaultModel: ModelChoice,
    repo?: string,
  ): { model: ModelChoice; reason: string } {
    const patterns = this.patternMemory.getPatterns(agentRole, taskType, repo);

    // コールドスタート: サンプル不足ならデフォルト
    const qualified = patterns.filter((p) => p.sampleCount >= this.config.minSamples);
    if (qualified.length === 0) {
      return {
        model: defaultModel,
        reason: `サンプル不足（< ${this.config.minSamples}件）。デフォルトモデルを使用`,
      };
    }

    // 成功率 >= minSuccessRate のモデルのみ候補
    const candidates = qualified.filter((p) => p.successRate >= this.config.minSuccessRate);
    if (candidates.length === 0) {
      return {
        model: defaultModel,
        reason: `成功率 ${this.config.minSuccessRate * 100}% 以上のモデルなし。デフォルトを使用`,
      };
    }

    // Exploit: 成功率/コスト比が最高のモデル
    const scored = candidates.map((p) => ({
      model: p.model as ModelChoice,
      score: p.avgCostUsd > 0 ? p.successRate / p.avgCostUsd : p.successRate,
      successRate: p.successRate,
      avgCost: p.avgCostUsd,
    }));
    scored.sort((a, b) => b.score - a.score);

    const exploit = scored[0];
    if (!exploit) {
      return { model: defaultModel, reason: "候補モデルなし。デフォルトを使用" };
    }

    // Epsilon-Greedy: explorationRate の確率で探索
    if (Math.random() < this.config.explorationRate) {
      // exploit と異なるモデルを選ぶ
      const others = scored.filter(
        (s) => s.model !== exploit.model && s.avgCost <= exploit.avgCost * this.config.maxExplorationCostMultiplier,
      );

      if (others.length > 0) {
        const randomIndex = Math.floor(Math.random() * others.length);
        const explore = others[randomIndex];
        if (!explore) {
          return { model: exploit.model, reason: "fallback: explore candidate not found" };
        }
        this.logger.debug(
          { agentRole, taskType, model: explore.model, reason: "exploration" },
          "Model selected (explore)",
        );
        return {
          model: explore.model,
          reason: `探索モード: ${explore.model}（成功率 ${(explore.successRate * 100).toFixed(0)}%, コスト $${explore.avgCost.toFixed(2)}）`,
        };
      }
    }

    this.logger.debug(
      { agentRole, taskType, model: exploit.model, score: exploit.score },
      "Model selected (exploit)",
    );
    return {
      model: exploit.model,
      reason: `最適モデル: ${exploit.model}（成功率 ${(exploit.successRate * 100).toFixed(0)}%, コスト $${exploit.avgCost.toFixed(2)}）`,
    };
  }
}
