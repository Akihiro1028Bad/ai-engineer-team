import type pino from "pino";

import type { PlanNode } from "../types/execution-plan.js";
import type { CriticReview } from "../types/validation.js";
import { CriticReviewSchema } from "../types/validation.js";
import type { AgentRunner, NodeRunResult } from "../execution/agent-runner.js";
import type { StatusEmitter } from "../execution/status-emitter.js";
import { assessRisk } from "./risk-classifier.js";

/** Critic Loop の最大イテレーション数 */
const MAX_ITERATIONS = 3;
/** 品質スコアの合格閾値 */
const QUALITY_THRESHOLD = 80;

export interface CriticLoopResult {
  /** 最終結果 */
  finalResult: NodeRunResult;
  /** Critic レビュー履歴 */
  reviews: CriticReview[];
  /** 実行イテレーション数 */
  iterations: number;
  /** 合格したか */
  passed: boolean;
}

/**
 * Generator-Critic Loop: 高リスク変更に対して Implementer → Critic のループを実行。
 * Critic スコアが 80 以上になるか、最大3回まで繰り返す。
 */
export class GeneratorCriticLoop {
  constructor(
    private readonly agentRunner: AgentRunner,
    private readonly statusEmitter: StatusEmitter,
    private readonly logger: pino.Logger,
  ) {}

  /** Critic Loop が必要かどうかを判定する */
  shouldRunCriticLoop(
    node: PlanNode,
    _result: NodeRunResult,
    changedFiles: string[],
  ): boolean {
    // ノード設定で明示的に要求
    if (node.requiresCriticLoop) return true;

    // リスク評価
    const risk = assessRisk({
      diffLines: 0, // TODO: diff 行数を取得
      changedFiles,
    });

    return risk.requiresCriticLoop;
  }

  /** Generator-Critic Loop を実行する */
  async run(
    taskId: string,
    planId: string,
    generatorNode: PlanNode,
    generatorResult: NodeRunResult,
    cwd: string,
  ): Promise<CriticLoopResult> {
    const reviews: CriticReview[] = [];
    let currentResult = generatorResult;
    let iteration = 0;

    while (iteration < MAX_ITERATIONS) {
      iteration++;

      this.statusEmitter.emitProgress(taskId, `Critic Loop イテレーション ${iteration}/${MAX_ITERATIONS}`);
      this.logger.info({ taskId, planId, iteration }, "Critic loop iteration started");

      // Critic ノードを構築
      const criticNode: PlanNode = {
        id: `${generatorNode.id}-critic-${iteration}`,
        agentRole: "critic",
        prompt: [
          `## Critic レビュー（イテレーション ${iteration}/${MAX_ITERATIONS}）`,
          "",
          "以下のコード変更をレビューしてください。",
          "",
          "### 評価基準",
          "1. 設計一貫性: 設計書の仕様に準拠しているか",
          "2. コード品質: 命名規則、エラーハンドリング、型安全性",
          "3. テストカバレッジ: 必要なテストが実装されているか",
          "4. セキュリティ: 脆弱性がないか",
          "",
          "### 出力形式",
          "qualityScore (0-100), verdict (pass/fail_with_suggestions/fail_critical), findings を返してください。",
          "",
          iteration > 1 ? `### 前回のフィードバック\n${reviews[reviews.length - 1]?.findings.map((f) => `- ${f.severity}: ${f.issue}`).join("\n") ?? ""}` : "",
        ].filter(Boolean).join("\n"),
        dependsOn: [],
        model: "sonnet",
        estimatedCostUsd: 0.30,
        requiresCriticLoop: false,
        maxRetries: 0,
      };

      // Critic 実行
      const criticResult = await this.agentRunner.run({
        taskId,
        planId,
        node: criticNode,
        cwd,
      });

      // Critic 出力を解析
      const review = this.parseCriticOutput(criticResult, iteration);
      reviews.push(review);

      this.logger.info(
        { taskId, iteration, qualityScore: review.qualityScore, verdict: review.verdict },
        "Critic review completed",
      );

      // 合格判定
      if (review.qualityScore >= QUALITY_THRESHOLD || review.verdict === "pass") {
        return { finalResult: currentResult, reviews, iterations: iteration, passed: true };
      }

      // 最終イテレーションなら終了
      if (iteration >= MAX_ITERATIONS) {
        this.logger.warn({ taskId, iterations: iteration }, "Critic loop max iterations reached");
        return { finalResult: currentResult, reviews, iterations: iteration, passed: false };
      }

      // Generator に Critic フィードバックを反映して再実行
      const feedbackPrompt = [
        generatorNode.prompt,
        "",
        "## Critic フィードバック（修正してください）",
        ...review.findings.map((f) =>
          `- [${f.severity}] ${f.file}: ${f.issue}\n  → ${f.suggestion}`,
        ),
      ].join("\n");

      const revisedNode: PlanNode = {
        ...generatorNode,
        id: `${generatorNode.id}-revision-${iteration}`,
        prompt: feedbackPrompt,
      };

      currentResult = await this.agentRunner.run({
        taskId,
        planId,
        node: revisedNode,
        cwd,
      });

      if (currentResult.status === "failed") {
        this.logger.warn({ taskId, iteration }, "Generator revision failed");
        return { finalResult: currentResult, reviews, iterations: iteration, passed: false };
      }
    }

    return { finalResult: currentResult, reviews, iterations: iteration, passed: false };
  }

  /** Critic の出力を CriticReview に変換する */
  private parseCriticOutput(result: NodeRunResult, iteration: number): CriticReview {
    if (result.structuredOutput) {
      const parsed = CriticReviewSchema.safeParse({
        ...(result.structuredOutput as Record<string, unknown>),
        iteration,
      });
      if (parsed.success) return parsed.data;
    }

    // フォールバック: 成功していれば高スコア、失敗なら低スコア
    return {
      qualityScore: result.status === "completed" ? 75 : 30,
      verdict: result.status === "completed" ? "fail_with_suggestions" : "fail_critical",
      findings: [],
      summary: result.error ?? "Critic 出力の解析に失敗",
      iteration,
    };
  }
}
