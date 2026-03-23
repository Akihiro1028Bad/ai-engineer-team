import type pino from "pino";

import type { AnalysisReport } from "../types/execution-plan.js";
import { AnalysisReportSchema } from "../types/execution-plan.js";

interface AnalyzerInput {
  issueNumber: number;
  title: string;
  body: string;
  labels: string[];
  cwd: string;
}

/**
 * Analyzer Agent: Haiku でコードベースを調査し、影響範囲・リスク・複雑度を分析する。
 * コスト: ~$0.05/実行
 */
export class AnalyzerAgent {
  constructor(private readonly logger: pino.Logger) {}

  async analyze(input: AnalyzerInput): Promise<AnalysisReport> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    const jsonSchema = {
      type: "object" as const,
      properties: {
        affectedFiles: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              path: { type: "string" as const },
              changeType: { type: "string" as const, enum: ["create", "modify", "delete"] },
              complexity: { type: "string" as const, enum: ["low", "medium", "high"] },
            },
            required: ["path", "changeType", "complexity"],
          },
        },
        dependencies: { type: "array" as const, items: { type: "string" as const } },
        risks: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              description: { type: "string" as const },
              severity: { type: "string" as const, enum: ["low", "medium", "high"] },
              mitigation: { type: "string" as const },
            },
            required: ["description", "severity"],
          },
        },
        testCoverage: {
          type: "object" as const,
          properties: {
            hasTests: { type: "boolean" as const },
            relevantTestFiles: { type: "array" as const, items: { type: "string" as const } },
          },
          required: ["hasTests"],
        },
        estimatedComplexity: { type: "string" as const, enum: ["trivial", "small", "medium", "large"] },
        summary: { type: "string" as const },
      },
      required: ["affectedFiles", "estimatedComplexity", "summary"],
    };

    let structuredOutput: unknown = null;
    let resultText: string | undefined;

    try {
      for await (const message of query({
        prompt: [
          "以下の GitHub Issue を元にコードベースを調査し、影響範囲を分析してください。",
          "",
          `Issue #${input.issueNumber}: ${input.title}`,
          `ラベル: ${input.labels.join(", ") || "なし"}`,
          "",
          input.body,
          "",
          "## 調査手順",
          "1. Glob でプロジェクト構造を把握する",
          "2. Grep で関連ファイルを特定する",
          "3. Read で関連コードを確認する",
          "4. 影響範囲・リスク・テストカバレッジを分析する",
          "",
          "## 出力",
          "- affectedFiles: 変更対象ファイル一覧",
          "- dependencies: 影響するモジュール",
          "- risks: リスク一覧",
          "- testCoverage: テストの有無と関連テストファイル",
          "- estimatedComplexity: trivial / small / medium / large",
          "- summary: 分析結果の要約",
        ].join("\n"),
        options: {
          model: "haiku",
          maxTurns: 10,
          maxBudgetUsd: 0.10,
          allowedTools: ["Read", "Glob", "Grep"],
          permissionMode: "dontAsk",
          cwd: input.cwd,
          outputFormat: { type: "json_schema", schema: jsonSchema },
        },
      }) as AsyncIterable<{ type: string; structured_output?: unknown; result?: string }>) {
        if (message.type === "result") {
          structuredOutput = message.structured_output;
          resultText = message.result;
        }
      }

      // フォールバック: テキストから JSON 抽出
      if (!structuredOutput && resultText) {
        const jsonMatch = /\{[\s\S]*\}/.exec(resultText);
        if (jsonMatch) {
          try {
            structuredOutput = JSON.parse(jsonMatch[0]) as unknown;
          } catch { /* ignore */ }
        }
      }

      if (structuredOutput) {
        const parsed = AnalysisReportSchema.safeParse(structuredOutput);
        if (parsed.success) {
          this.logger.info(
            { issueNumber: input.issueNumber, fileCount: parsed.data.affectedFiles.length },
            "Analysis complete",
          );
          return parsed.data;
        }
        this.logger.warn({ issueNumber: input.issueNumber }, "Analysis output validation failed");
      }
    } catch (error: unknown) {
      this.logger.error({ issueNumber: input.issueNumber, error }, "Analyzer agent failed");
    }

    // フォールバック: 最小限のレポート
    return {
      affectedFiles: [],
      dependencies: [],
      risks: [],
      estimatedComplexity: "medium",
      summary: "分析に失敗しました。手動での調査が必要です。",
    };
  }
}
