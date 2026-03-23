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

  /** Opus で Issue のスコープを分析し、分割すべきか判定する（リトライ付き） */
  private async analyzeScope(
    issue: Issue,
  ): Promise<{ title: string; description: string }[]> {
    const MAX_RETRIES = 3;
    const BACKOFF_MS = [1000, 3000, 9000];

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const result = await this.tryScopeAnalysis(issue);
      if (result.length > 0) return result;

      if (attempt < MAX_RETRIES - 1) {
        console.warn(`[Classifier] Scope analysis attempt ${attempt + 1} failed, retrying in ${BACKOFF_MS[attempt]}ms...`);
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
      }
    }

    // 全リトライ失敗 → フォールバックヒューリスティクス
    console.warn("[Classifier] All Opus retries failed, trying keyword-based fallback");
    return this.keywordFallbackScope(issue);
  }

  /** キーワードベースのスコープ分割（Opus 失敗時のフォールバック） */
  private keywordFallbackScope(issue: Issue): { title: string; description: string }[] {
    const text = `${issue.title} ${issue.body}`.toLowerCase();

    // 複数画面/コンポーネントのキーワードを検出
    const SCREEN_KEYWORDS = [
      "テーブル", "フォーム", "ダイアログ", "モーダル", "ナビゲーション",
      "ダッシュボード", "一覧", "詳細", "設定", "ログイン",
      "table", "form", "dialog", "modal", "navigation", "dashboard", "list", "detail",
    ];
    const found = SCREEN_KEYWORDS.filter((kw) => text.includes(kw));

    if (found.length >= 3) {
      console.info(`[Classifier] Keyword fallback: found ${found.length} components → splitting`);
      return found.map((kw) => ({
        title: `${kw} の修正`,
        description: `${issue.title} のうち、${kw} に関連する部分を修正する`,
      }));
    }

    console.info("[Classifier] Keyword fallback: not enough components for splitting");
    return [];
  }

  /** 単一の Opus スコープ分析試行 */
  private async tryScopeAnalysis(
    issue: Issue,
  ): Promise<{ title: string; description: string }[]> {
    try {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      // JSON Schema を直接定義（Zod v3 では toJSONSchema が未サポート）
      const jsonSchema = {
        type: "object" as const,
        properties: {
          isLarge: { type: "boolean" as const },
          scopes: {
            type: "array" as const,
            items: {
              type: "object" as const,
              properties: {
                title: { type: "string" as const },
                description: { type: "string" as const },
              },
              required: ["title", "description"],
            },
          },
        },
        required: ["isLarge", "scopes"],
      };

      let structuredOutput: unknown = null;
      let resultText: string | undefined;

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
          "- 各スコープは独立して実装可能な単位にする",
        ].join("\n"),
        options: {
          model: "opus",
          maxTurns: 1,
          maxBudgetUsd: 0.50,
          allowedTools: [],
          permissionMode: "dontAsk",
          outputFormat: { type: "json_schema", schema: jsonSchema },
        },
      }) as AsyncIterable<{ type: string; structured_output?: unknown; result?: string }>) {
        if (message.type === "result") {
          structuredOutput = message.structured_output;
          resultText = message.result;
        }
      }

      // 構造化出力がなければテキストから JSON 抽出を試みる
      if (!structuredOutput && resultText) {
        const jsonMatch = /\{[\s\S]*\}/.exec(resultText);
        if (jsonMatch) {
          try {
            structuredOutput = JSON.parse(jsonMatch[0]) as unknown;
          } catch {
            console.error("[Classifier] Failed to parse JSON from result text");
          }
        }
      }

      if (!structuredOutput) {
        console.warn("[Classifier] No structured output from Opus scope analysis");
        return [];
      }

      const parsed = ScopeAnalysisSchema.safeParse(structuredOutput);
      if (!parsed.success) {
        console.warn("[Classifier] Scope analysis schema validation failed:", parsed.error.message);
        return [];
      }

      if (!parsed.data.isLarge) {
        console.info("[Classifier] Issue classified as small scope");
        return [];
      }

      console.info(`[Classifier] Issue split into ${parsed.data.scopes.length} scopes`);
      return parsed.data.scopes;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      console.error("[Classifier] Opus scope analysis failed:", msg);
      return [];
    }
  }
}
