import type pino from "pino";

import { CircuitBreaker } from "./circuit-breaker.js";

/** エージェントロール別の閾値設定 */
const AGENT_THRESHOLDS: Record<string, { threshold: number; cooldownMs: number }> = {
  analyzer: { threshold: 5, cooldownMs: 1_800_000 },     // 30分
  designer: { threshold: 3, cooldownMs: 3_600_000 },     // 1時間
  implementer: { threshold: 3, cooldownMs: 3_600_000 },  // 1時間
  critic: { threshold: 5, cooldownMs: 1_800_000 },       // 30分
  scribe: { threshold: 5, cooldownMs: 1_800_000 },       // 30分
  // v2.1 互換
  reviewer: { threshold: 3, cooldownMs: 3_600_000 },
  fixer: { threshold: 3, cooldownMs: 3_600_000 },
  builder: { threshold: 3, cooldownMs: 3_600_000 },
};

const DEFAULT_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 1_800_000;

/**
 * Per-Agent Circuit Breaker: agentRole x taskType ごとに独立した Circuit Breaker を管理。
 * 1つのエージェントの障害が他のエージェントの実行を止めない。
 */
export class PerAgentCircuitBreaker {
  /** キー: "{agentRole}:{taskType}" */
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(
    private readonly logger: pino.Logger,
    private readonly onOpen?: (key: string) => void,
  ) {}

  /** 特定のエージェント+タスクタイプが実行可能か */
  canExecute(agentRole: string, taskType: string): boolean {
    const breaker = this.getOrCreate(agentRole, taskType);
    return breaker.canExecute();
  }

  /** 成功を記録 */
  recordSuccess(agentRole: string, taskType: string): void {
    const breaker = this.getOrCreate(agentRole, taskType);
    breaker.recordSuccess();
  }

  /** 失敗を記録 */
  recordFailure(agentRole: string, taskType: string): void {
    const key = `${agentRole}:${taskType}`;
    const breaker = this.getOrCreate(agentRole, taskType);
    const wasClosed = breaker.getState() === "CLOSED";
    breaker.recordFailure();

    if (wasClosed && breaker.getState() === "OPEN") {
      this.logger.warn({ key, state: "OPEN" }, "Per-agent circuit breaker opened");
      this.onOpen?.(key);
    }
  }

  /** 全 breaker の状態サマリ */
  getStatus(): { key: string; state: string; failures: number; remainingMs: number }[] {
    return [...this.breakers.entries()].map(([key, breaker]) => ({
      key,
      state: breaker.getState(),
      failures: breaker.getConsecutiveFailures(),
      remainingMs: breaker.getRemainingMs(),
    }));
  }

  /** OPEN 状態の breaker があるか */
  hasOpenBreaker(): boolean {
    return [...this.breakers.values()].some((b) => b.getState() === "OPEN");
  }

  /** 特定のキーの breaker を取得/作成 */
  private getOrCreate(agentRole: string, taskType: string): CircuitBreaker {
    const key = `${agentRole}:${taskType}`;
    let breaker = this.breakers.get(key);
    if (!breaker) {
      const config = AGENT_THRESHOLDS[agentRole] ?? {
        threshold: DEFAULT_THRESHOLD,
        cooldownMs: DEFAULT_COOLDOWN_MS,
      };
      breaker = new CircuitBreaker(config.threshold, config.cooldownMs);
      this.breakers.set(key, breaker);
    }
    return breaker;
  }
}
