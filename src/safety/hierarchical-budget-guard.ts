import type pino from "pino";

/** 予算プール定義 */
interface BudgetPool {
  name: string;
  /** 全体予算に対する割合 (0-1) */
  ratio: number;
  spent: number;
}

/** デフォルト予算配分（設計書 Section 8.2） */
const DEFAULT_POOLS: { name: string; ratio: number }[] = [
  { name: "intake", ratio: 0.05 },
  { name: "planning", ratio: 0.20 },
  { name: "execution", ratio: 0.55 },
  { name: "quality", ratio: 0.15 },
  { name: "reserve", ratio: 0.05 },
];

/** エージェントロール → プール名のマッピング */
const ROLE_TO_POOL: Record<string, string> = {
  classifier: "intake",
  analyzer: "planning",
  planner: "planning",
  designer: "execution",
  implementer: "execution",
  critic: "quality",
  scribe: "execution",
  reviewer: "execution",
  fixer: "execution",
  builder: "execution",
  tool_synthesizer: "reserve",
  optimizer: "reserve",
};

/**
 * Hierarchical Budget Guard: 5層プール別予算管理。
 * Quality Budget は Execution Budget より先に枯渇してはならない。
 */
export class HierarchicalBudgetGuard {
  private readonly pools: Map<string, BudgetPool>;
  private readonly dailyLimitUsd: number;
  private dayStart: number;

  constructor(
    dailyLimitUsd: number,
    private readonly logger: pino.Logger,
  ) {
    this.dailyLimitUsd = dailyLimitUsd;
    this.dayStart = this.startOfDay();
    this.pools = new Map(
      DEFAULT_POOLS.map((p) => [p.name, { ...p, spent: 0 }]),
    );
  }

  /** 特定のエージェントロールが実行可能か（プール予算内か） */
  canExecute(agentRole: string): boolean {
    const poolName = ROLE_TO_POOL[agentRole] ?? "execution";
    const pool = this.pools.get(poolName);
    if (!pool) return true;

    const limit = this.dailyLimitUsd * pool.ratio;
    if (pool.spent >= limit) {
      this.logger.warn({ pool: poolName, spent: pool.spent, limit }, "Pool budget exhausted");
      return false;
    }

    // Quality Budget 保護: Execution が Quality の残量を侵食しない
    if (poolName === "execution") {
      const qualityPool = this.pools.get("quality");
      if (qualityPool) {
        const qualityLimit = this.dailyLimitUsd * qualityPool.ratio;
        const qualityRemaining = qualityLimit - qualityPool.spent;
        if (qualityRemaining < qualityLimit * 0.2) {
          // Quality が 20% 未満 → Execution を制限
          this.logger.warn("Quality pool low — throttling execution");
          return false;
        }
      }
    }

    return true;
  }

  /** コストを記録する */
  recordCost(agentRole: string, usd: number): void {
    const poolName = ROLE_TO_POOL[agentRole] ?? "execution";
    const pool = this.pools.get(poolName);
    if (pool) {
      pool.spent += usd;
    }
  }

  /** 全プールの使用状況 */
  getStatus(): { name: string; spent: number; limit: number; remaining: number; ratio: number }[] {
    return [...this.pools.values()].map((p) => {
      const limit = this.dailyLimitUsd * p.ratio;
      return {
        name: p.name,
        spent: p.spent,
        limit,
        remaining: limit - p.spent,
        ratio: p.ratio,
      };
    });
  }

  /** 全体の使用合計 */
  getTotalSpent(): number {
    let total = 0;
    for (const pool of this.pools.values()) {
      total += pool.spent;
    }
    return total;
  }

  /** 日次リセット */
  checkDailyReset(): void {
    const today = this.startOfDay();
    if (today > this.dayStart) {
      for (const pool of this.pools.values()) {
        pool.spent = 0;
      }
      this.dayStart = today;
      this.logger.info("Hierarchical budget pools reset");
    }
  }

  private startOfDay(): number {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
}
