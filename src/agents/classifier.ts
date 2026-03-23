import { z } from "zod";
import type { Classification, SubTaskDef, TaskType } from "../types.js";

interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

interface OctokitLike {
  issues: {
    createComment: (params: {
      owner: string;
      repo: string;
      issue_number: number;
      body: string;
    }) => Promise<unknown>;
  };
}

/** Haiku によるスコープ分析の結果スキーマ */
const ScopeAnalysisSchema = z.object({
  isLarge: z.boolean(),
  scopes: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
    }),
  ),
});

/** ラベルから実装タスクの種別を決定する */
function detectTaskType(labels: string[]): TaskType {
  for (const label of labels) {
    const lower = label.toLowerCase();
    if (lower === "feature" || lower === "enhancement") return "build";
    if (lower === "documentation" || lower === "docs") return "document";
  }
  return "fix";
}

/** 1つのスコープ用パイプライン [review, fix/build] を構築 */
function buildPipelineForScope(
  issueNumber: number,
  scopeTitle: string,
  scopeDescription: string,
  implType: TaskType,
  scopeId: string,
): SubTaskDef[] {
  return [
    {
      taskType: "review",
      title: `[設計] ${scopeTitle}`,
      description: [
        `GitHub Issue #${issueNumber}: ${scopeTitle}`,
        "",
        scopeDescription,
        "",
        `Issue番号: ${issueNumber}`,
        `specs/issue-${issueNumber}/${scopeId}/design.md を作成してください。`,
        "",
        "このスコープのみに集中してください。他のスコープは別のエージェントが担当します。",
      ].join("\n"),
      dependsOnIndex: null,
    },
    {
      taskType: implType,
      title: `[実装] ${scopeTitle}`,
      description: [
        `GitHub Issue #${issueNumber}: ${scopeTitle}`,
        "",
        `承認された設計書 specs/issue-${issueNumber}/${scopeId}/design.md に従って実装してください。`,
        "",
        "このスコープのみに集中してください。他のスコープは別のエージェントが担当します。",
      ].join("\n"),
      dependsOnIndex: 0,
    },
  ];
}

/** 小規模 Issue 用の単一パイプライン */
function buildSinglePipeline(issue: Issue, implType: TaskType): SubTaskDef[] {
  return [
    {
      taskType: "review",
      title: `[設計] ${issue.title}`,
      description: [
        `GitHub Issue #${issue.number}: ${issue.title}`,
        "",
        issue.body,
        "",
        `Issue番号: ${issue.number}`,
        `specs/issue-${issue.number}/design.md を作成してください。`,
      ].join("\n"),
      dependsOnIndex: null,
    },
    {
      taskType: implType,
      title: `[実装] ${issue.title}`,
      description: [
        `GitHub Issue #${issue.number}: ${issue.title}`,
        "",
        `承認された設計書 specs/issue-${issue.number}/design.md に従って実装してください。`,
      ].join("\n"),
      dependsOnIndex: 0,
    },
  ];
}

export interface ClassificationResult {
  /** 単一パイプラインの場合は1つ、スコープ分割の場合は複数 */
  pipelines: {
    scopeId: string;
    classification: Classification;
  }[];
}

export class Classifier {
  constructor(
    private readonly _octokit: OctokitLike,
    private readonly _owner: string,
    private readonly _repo: string,
  ) {}

  async classify(issue: Issue): Promise<ClassificationResult> {
    const implType = detectTaskType(issue.labels);

    // Haiku でスコープ分析
    const scopes = await this.analyzeScope(issue);

    if (scopes.length <= 1) {
      // 小規模 or 分析失敗 → 単一パイプライン
      return {
        pipelines: [
          {
            scopeId: "main",
            classification: {
              issueId: issue.number,
              complexity: "pipeline",
              subTasks: buildSinglePipeline(issue, implType),
            },
          },
        ],
      };
    }

    // 大規模 → スコープごとに独立パイプライン
    return {
      pipelines: scopes.map((scope, i) => ({
        scopeId: `scope-${i + 1}`,
        classification: {
          issueId: issue.number,
          complexity: "pipeline",
          subTasks: buildPipelineForScope(
            issue.number,
            scope.title,
            scope.description,
            implType,
            `scope-${i + 1}`,
          ),
        },
      })),
    };
  }

  /** Haiku で Issue のスコープを分析し、分割すべきか判定する */
  private async analyzeScope(
    issue: Issue,
  ): Promise<{ title: string; description: string }[]> {
    try {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      let structuredOutput: unknown = null;

      for await (const message of query({
        prompt: [
          "以下の GitHub Issue を分析し、実装スコープを判定してください。",
          "",
          `タイトル: ${issue.title}`,
          `本文: ${issue.body}`,
          "",
          "判定基準:",
          "- 変更対象が1〜2ファイルの小さなタスク → isLarge: false, scopes: []",
          "- 変更対象が3ファイル以上、または複数画面/コンポーネントにまたがる → isLarge: true",
          "- 大規模な場合、画面/コンポーネント/機能ごとにスコープを分割する",
          "",
          "JSON形式で回答してください:",
          '{ "isLarge": boolean, "scopes": [{ "title": "スコープ名", "description": "このスコープで行う変更の説明" }] }',
          "",
          "isLarge が false の場合、scopes は空配列 [] にしてください。",
        ].join("\n"),
        options: {
          model: "opus",
          maxTurns: 1,
          maxBudgetUsd: 0.50,
          allowedTools: [],
          permissionMode: "dontAsk",
        },
      }) as AsyncIterable<{ type: string; structured_output?: unknown; result?: string }>) {
        if (message.type === "result") {
          structuredOutput = message.structured_output;
          // structured_output がない場合は result から JSON を抽出
          if (!structuredOutput && message.result) {
            const jsonMatch = /\{[\s\S]*\}/.exec(message.result);
            if (jsonMatch) {
              try {
                structuredOutput = JSON.parse(jsonMatch[0]) as unknown;
              } catch {
                // パース失敗
              }
            }
          }
        }
      }

      if (!structuredOutput) return [];

      const parsed = ScopeAnalysisSchema.safeParse(structuredOutput);
      if (!parsed.success || !parsed.data.isLarge) return [];

      return parsed.data.scopes;
    } catch {
      // Haiku 分析失敗 → 単一パイプラインにフォールバック
      return [];
    }
  }
}
