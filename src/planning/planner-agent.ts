import type pino from "pino";

import type { AnalysisReport, ExecutionPlan } from "../types/execution-plan.js";
import { ExecutionPlanSchema } from "../types/execution-plan.js";

/** Extract the first balanced-brace JSON object from text */
function extractFirstJson(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
    if (depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

interface PlannerInput {
  taskId: string;
  issueNumber: number;
  title: string;
  body: string;
  labels: string[];
  analysisReport: AnalysisReport;
  /** Pattern Memory から取得した過去のパターン情報 */
  patternContext?: string;
  cwd: string;
}

/**
 * Planner Agent: Opus で AnalysisReport + Issue → ExecutionPlan (DAG) を生成する。
 * コスト: ~$0.80-1.00/実行、5ターン制限
 */
export class PlannerAgent {
  constructor(private readonly logger: pino.Logger) {}

  async plan(input: PlannerInput): Promise<ExecutionPlan> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    const jsonSchema = {
      type: "object" as const,
      properties: {
        taskId: { type: "string" as const },
        issueNumber: { type: "number" as const },
        nodes: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              id: { type: "string" as const },
              agentRole: { type: "string" as const, enum: ["analyzer", "designer", "implementer", "critic", "scribe"] },
              prompt: { type: "string" as const },
              dependsOn: { type: "array" as const, items: { type: "string" as const } },
              model: { type: "string" as const, enum: ["haiku", "sonnet", "opus"] },
              estimatedCostUsd: { type: "number" as const },
              estimatedDurationMs: { type: "number" as const },
              requiresCriticLoop: { type: "boolean" as const },
              maxRetries: { type: "number" as const },
            },
            required: ["id", "agentRole", "prompt", "dependsOn", "model", "estimatedCostUsd"],
          },
        },
        criticalPath: { type: "array" as const, items: { type: "string" as const } },
        totalEstimatedCostUsd: { type: "number" as const },
        totalEstimatedDurationMs: { type: "number" as const },
        riskLevel: { type: "string" as const, enum: ["low", "medium", "high"] },
        rationale: { type: "string" as const },
      },
      required: ["taskId", "nodes", "totalEstimatedCostUsd", "riskLevel", "rationale"],
    };

    let structuredOutput: unknown = null;
    let resultText: string | undefined;

    const patternSection = input.patternContext
      ? `\n## 過去の実行パターン（参考情報）\n${input.patternContext}\n`
      : "";

    try {
      for await (const message of query({
        prompt: [
          "以下の Issue と分析結果を元に、実行計画（DAG）を生成してください。",
          "",
          `## Issue #${input.issueNumber}: ${input.title}`,
          input.body,
          "",
          "## 分析結果",
          `影響ファイル数: ${input.analysisReport.affectedFiles.length}`,
          `推定複雑度: ${input.analysisReport.estimatedComplexity}`,
          `リスク: ${input.analysisReport.risks.map((r) => `${r.severity}: ${r.description}`).join("; ") || "なし"}`,
          `要約: ${input.analysisReport.summary}`,
          patternSection,
          "## DAG 生成ルール",
          "1. 各ノードには id, agentRole, prompt, dependsOn, model, estimatedCostUsd を設定",
          "2. agentRole: analyzer(調査), designer(設計), implementer(実装), critic(レビュー), scribe(ドキュメント)",
          "3. model: haiku(分析/検証,$0.01-0.05), sonnet(設計/実装,$0.50-2.00), opus(計画のみ,$0.80-1.00)",
          "4. dependsOn: 依存先ノードの id 配列（空なら独立実行可能）",
          "5. requiresCriticLoop: true → 実装後に Critic レビューを行う（高リスク時）",
          "",
          "## パターン例",
          "- 小規模バグ修正: [designer] → [implementer] → [validate]",
          "- 中規模機能: [designer] → [implementer] → [critic] → [validate]",
          "- 大規模（並列可能）: [designer-api, designer-ui] → [impl-api, impl-ui] → [integration] → [critic]",
          "",
          `taskId は "${input.taskId}" を使用してください。`,
        ].join("\n"),
        options: {
          model: "opus",
          maxTurns: 5,
          maxBudgetUsd: 1.00,
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

      if (!structuredOutput && resultText) {
        const jsonStr = extractFirstJson(resultText);
        if (jsonStr) {
          try {
            structuredOutput = JSON.parse(jsonStr) as unknown;
          } catch { /* ignore */ }
        }
      }

      if (structuredOutput) {
        // createdAt を補完
        const withTimestamp = {
          ...(structuredOutput as Record<string, unknown>),
          createdAt: new Date().toISOString(),
        };
        const parsed = ExecutionPlanSchema.safeParse(withTimestamp);
        if (parsed.success) {
          this.logger.info(
            { taskId: input.taskId, nodeCount: parsed.data.nodes.length, cost: parsed.data.totalEstimatedCostUsd },
            "Execution plan generated",
          );
          return parsed.data;
        }
        this.logger.warn(
          { taskId: input.taskId, errors: parsed.error.issues.map((i) => i.message) },
          "Plan validation failed",
        );
      }
    } catch (error: unknown) {
      this.logger.error({ taskId: input.taskId, error }, "Planner agent failed");
    }

    // フォールバック: 最小パイプライン (designer → implementer)
    return this.buildFallbackPlan(input);
  }

  /** フォールバック: 最小パイプライン */
  private buildFallbackPlan(input: PlannerInput): ExecutionPlan {
    this.logger.warn({ taskId: input.taskId }, "Using fallback plan");
    return {
      taskId: input.taskId,
      issueNumber: input.issueNumber,
      nodes: [
        {
          id: "node-1",
          agentRole: "designer",
          prompt: `Issue #${input.issueNumber}: ${input.title}\n\n${input.body}\n\nspecs/issue-${input.issueNumber}/design.md を作成してください。`,
          dependsOn: [],
          model: "sonnet",
          estimatedCostUsd: 0.50,
          requiresCriticLoop: false,
          maxRetries: 1,
        },
        {
          id: "node-2",
          agentRole: "implementer",
          prompt: `specs/issue-${input.issueNumber}/design.md に従って実装してください。`,
          dependsOn: ["node-1"],
          model: "sonnet",
          estimatedCostUsd: 1.50,
          requiresCriticLoop: false,
          maxRetries: 1,
        },
      ],
      criticalPath: ["node-1", "node-2"],
      totalEstimatedCostUsd: 2.00,
      riskLevel: "medium",
      rationale: "Planner 失敗のためフォールバック計画を使用",
      createdAt: new Date().toISOString(),
    };
  }
}
