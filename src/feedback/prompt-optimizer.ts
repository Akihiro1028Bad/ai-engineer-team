import type pino from "pino";

import type { EvalStore } from "./eval-store.js";
import type { PRFeedbackLearner } from "./pr-feedback-learner.js";

interface PromptOptimizationResult {
  agentRole: string;
  currentPromptHash: string;
  suggestions: string[];
  basedOn: {
    totalExecutions: number;
    failureRate: number;
    topFeedbackPatterns: string[];
  };
}

/**
 * 適応型プロンプト最適化。
 * 月次バッチで Eval Store + Feedback Learnings を分析し、
 * プロンプト改善提案を生成する。
 *
 * 将来的には A/B テスト機構を追加し、改善効果を測定する。
 */
export class PromptOptimizer {
  constructor(
    private readonly evalStore: EvalStore,
    private readonly feedbackLearner: PRFeedbackLearner,
    private readonly logger: pino.Logger,
  ) {}

  /** 全エージェントロールのプロンプト最適化提案を生成する */
  analyze(repo?: string): PromptOptimizationResult[] {
    const results: PromptOptimizationResult[] = [];
    const stats = this.evalStore.getAgentModelStats(repo);

    // エージェントロールごとにグループ化
    const roleGroups = new Map<string, typeof stats>();
    for (const stat of stats) {
      const existing = roleGroups.get(stat.agentRole) ?? [];
      existing.push(stat);
      roleGroups.set(stat.agentRole, existing);
    }

    for (const [agentRole, roleStats] of roleGroups) {
      const totalExecutions = roleStats.reduce((sum, s) => sum + s.total, 0);
      const totalFailures = roleStats.reduce((sum, s) => sum + (s.total - s.successes), 0);
      const failureRate = totalExecutions > 0 ? totalFailures / totalExecutions : 0;

      // フィードバックパターン
      const topFeedback = this.feedbackLearner.getTopPatterns(agentRole, 5, repo);

      // 提案生成
      const suggestions = this.generateSuggestions(agentRole, failureRate, topFeedback);

      if (suggestions.length > 0) {
        results.push({
          agentRole,
          currentPromptHash: `${agentRole}-${totalExecutions}`,
          suggestions,
          basedOn: {
            totalExecutions,
            failureRate,
            topFeedbackPatterns: topFeedback,
          },
        });
      }
    }

    this.logger.info(
      { roleCount: results.length, totalSuggestions: results.reduce((sum, r) => sum + r.suggestions.length, 0) },
      "Prompt optimization analysis completed",
    );

    return results;
  }

  /** エージェントロール別の改善提案を生成する */
  private generateSuggestions(
    agentRole: string,
    failureRate: number,
    topFeedback: string[],
  ): string[] {
    const suggestions: string[] = [];

    // 失敗率が高い場合
    if (failureRate > 0.3) {
      suggestions.push(
        `${agentRole} の失敗率が ${(failureRate * 100).toFixed(0)}% です。プロンプトにエラーハンドリングの指示を強化してください。`,
      );
    }

    // フィードバックパターンに基づく提案
    for (const feedback of topFeedback) {
      const countMatch = /\[(\d+)回\]/.exec(feedback);
      const count = countMatch ? Number(countMatch[1]) : 0;

      if (count >= 3) {
        suggestions.push(
          `頻出フィードバック (${count}回): "${feedback.replace(/\[\d+回\]\s*/, "")}" — プロンプトに対応ルールを追加してください。`,
        );
      }
    }

    // ロール別の固有提案
    if (agentRole === "implementer" && failureRate > 0.2) {
      suggestions.push("implementer: テスト実行の確認ステップをプロンプトの最後に追加してください。");
    }
    if (agentRole === "designer" && topFeedback.some((f) => f.includes("テスト"))) {
      suggestions.push("designer: テストケースの具体性（入力値・期待結果）を強調するプロンプト修正を検討してください。");
    }

    return suggestions;
  }

  /** 最適化結果の人間可読サマリ */
  formatReport(results: PromptOptimizationResult[]): string {
    if (results.length === 0) return "プロンプト最適化提案: なし";

    const sections = results.map((r) => [
      `## ${r.agentRole}`,
      `実行回数: ${r.basedOn.totalExecutions}, 失敗率: ${(r.basedOn.failureRate * 100).toFixed(0)}%`,
      "",
      "### 提案",
      ...r.suggestions.map((s, i) => `${i + 1}. ${s}`),
      "",
      r.basedOn.topFeedbackPatterns.length > 0
        ? `### 頻出フィードバック\n${r.basedOn.topFeedbackPatterns.join("\n")}`
        : "",
    ].filter(Boolean).join("\n"));

    return ["# プロンプト最適化レポート", "", ...sections].join("\n\n");
  }
}
