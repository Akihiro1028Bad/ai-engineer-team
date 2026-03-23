import { z } from "zod";

import type { Classification, SubTaskDef, TaskType } from "../types.js";

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
  confidence: z.number().min(0).max(1).optional(),
  scopes: z.array(
    z.object({
      title: z.string(),
      description: z.string(),
    }),
  ),
});

/** Haiku による分類結果スキーマ */
const ClassificationOutputSchema = z.object({
  taskType: z.enum(["fix", "build", "document"]),
  complexity: z.enum(["single", "pipeline", "unclear"]),
  confidence: z.number().min(0).max(1),
  question: z.string().optional(),
  summary: z.string(),
  suggestedLabels: z.array(z.string()).optional(),
  estimatedSize: z.enum(["S", "M", "L", "XL"]).optional(),
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
  pipelines: {
    scopeId: string;
    classification: Classification;
  }[];
  /** Haiku の分類信頼度 (0-1) */
  confidence: number;
  /** 自動トリアージ用メタデータ */
  triage?: {
    suggestedLabels: string[];
    estimatedSize: string;
    taskType: TaskType;
  };
}

/** Haiku ベースの分類信頼度閾値（これ未満で Sonnet にエスカレーション） */
const CONFIDENCE_THRESHOLD = 0.7;

export class ClassifierV3 {
  constructor(
    private readonly _octokit: OctokitLike,
    private readonly _owner: string,
    private readonly _repo: string,
  ) {}

  async classify(issue: Issue): Promise<ClassificationResult> {
    // Haiku で分類（低コスト: ~$0.01）
    const classificationOutput = await this.classifyWithHaiku(issue);

    let implType = classificationOutput?.taskType
      ?? detectTaskType(issue.labels);
    const confidence = classificationOutput?.confidence ?? 0.5;

    // 信頼度が低い場合は Sonnet にフォールバック
    let effectiveConfidence = confidence;
    if (confidence < CONFIDENCE_THRESHOLD) {
      const sonnetResult = await this.reclassifyWithSonnet(issue, confidence);
      effectiveConfidence = sonnetResult.confidence;
      if (sonnetResult.taskType) {
        implType = sonnetResult.taskType;
      }
    }

    // unclear の場合は質問を返す
    if (classificationOutput?.complexity === "unclear" && classificationOutput.question) {
      return {
        pipelines: [{
          scopeId: "main",
          classification: {
            issueId: issue.number,
            complexity: "unclear",
            question: classificationOutput.question,
          },
        }],
        confidence: effectiveConfidence,
        triage: classificationOutput.suggestedLabels
          ? {
              suggestedLabels: classificationOutput.suggestedLabels,
              estimatedSize: classificationOutput.estimatedSize ?? "M",
              taskType: implType,
            }
          : undefined,
      };
    }

    // スコープ分析
    const scopes = await this.analyzeScope(issue);

    const triage = classificationOutput
      ? {
          suggestedLabels: classificationOutput.suggestedLabels ?? [],
          estimatedSize: classificationOutput.estimatedSize ?? "M",
          taskType: implType,
        }
      : undefined;

    if (scopes.length <= 1) {
      return {
        pipelines: [{
          scopeId: "main",
          classification: {
            issueId: issue.number,
            complexity: "pipeline",
            subTasks: buildSinglePipeline(issue, implType),
          },
        }],
        confidence: effectiveConfidence,
        triage,
      };
    }

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
      confidence: effectiveConfidence,
      triage,
    };
  }

  /** Haiku で Issue を分類（$0.01） */
  private async classifyWithHaiku(
    issue: Issue,
  ): Promise<z.infer<typeof ClassificationOutputSchema> | null> {
    try {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      const jsonSchema = {
        type: "object" as const,
        properties: {
          taskType: { type: "string" as const, enum: ["fix", "build", "document"] },
          complexity: { type: "string" as const, enum: ["single", "pipeline", "unclear"] },
          confidence: { type: "number" as const },
          question: { type: "string" as const },
          summary: { type: "string" as const },
          suggestedLabels: { type: "array" as const, items: { type: "string" as const } },
          estimatedSize: { type: "string" as const, enum: ["S", "M", "L", "XL"] },
        },
        required: ["taskType", "complexity", "confidence", "summary"],
      };

      let structuredOutput: unknown = null;
      let resultText: string | undefined;

      for await (const message of query({
        prompt: [
          "以下の GitHub Issue を分析し、分類してください。",
          "",
          `タイトル: ${issue.title}`,
          `ラベル: ${issue.labels.join(", ") || "なし"}`,
          `本文: ${issue.body}`,
          "",
          "判定基準:",
          "- taskType: fix（バグ修正）, build（新機能）, document（ドキュメント）",
          "- complexity: single（1-2ファイル変更）, pipeline（設計→実装パイプライン必要）, unclear（情報不足で質問が必要）",
          "- confidence: 0.0-1.0 の分類信頼度",
          "- unclear の場合: question に具体的な質問を記述",
          "- suggestedLabels: 推奨ラベル（bug, feature, docs, priority/high 等）",
          "- estimatedSize: S（1-2ファイル）, M（3-5ファイル）, L（6-10ファイル）, XL（11+ファイル）",
        ].join("\n"),
        options: {
          model: "haiku",
          maxTurns: 1,
          maxBudgetUsd: 0.05,
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

      if (!structuredOutput && resultText) {
        const jsonStr = extractFirstJson(resultText);
        if (jsonStr) {
          try {
            structuredOutput = JSON.parse(jsonStr) as unknown;
          } catch { /* ignore parse error */ }
        }
      }

      if (!structuredOutput) return null;

      const parsed = ClassificationOutputSchema.safeParse(structuredOutput);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** Sonnet で再分類（Haiku 信頼度 < 0.7 の場合のフォールバック、$0.10） */
  private async reclassifyWithSonnet(
    issue: Issue,
    originalConfidence: number,
  ): Promise<{ taskType: TaskType | null; confidence: number }> {
    try {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      let structuredOutput: unknown = null;
      let resultText: string | undefined;

      for await (const message of query({
        prompt: [
          "以下の GitHub Issue の分類を再確認してください。前回の分類の信頼度が低かったため、より詳細に分析します。",
          "",
          `タイトル: ${issue.title}`,
          `ラベル: ${issue.labels.join(", ") || "なし"}`,
          `本文: ${issue.body}`,
          "",
          "taskType（fix/build/document）と confidence（0.0-1.0）を返してください。",
        ].join("\n"),
        options: {
          model: "sonnet",
          maxTurns: 1,
          maxBudgetUsd: 0.10,
          allowedTools: [],
          permissionMode: "dontAsk",
          outputFormat: {
            type: "json_schema",
            schema: {
              type: "object" as const,
              properties: {
                taskType: { type: "string" as const, enum: ["fix", "build", "document"] },
                confidence: { type: "number" as const },
              },
              required: ["taskType", "confidence"],
            },
          },
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
          try { structuredOutput = JSON.parse(jsonStr) as unknown; } catch { /* ignore */ }
        }
      }

      if (typeof structuredOutput === "object" && structuredOutput !== null) {
        const obj = structuredOutput as { taskType?: string; confidence?: number };
        const conf = obj.confidence;
        const tt = obj.taskType;
        if (typeof conf === "number" && conf > originalConfidence) {
          const validTypes = ["fix", "build", "document"] as const;
          const taskType = typeof tt === "string" && (validTypes as readonly string[]).includes(tt)
            ? (tt as TaskType)
            : null;
          return { taskType, confidence: conf };
        }
      }
    } catch { /* Sonnet fallback failed, use original */ }

    return { taskType: null, confidence: originalConfidence };
  }

  /** Haiku でスコープ分析（リトライ付き） */
  private async analyzeScope(
    issue: Issue,
  ): Promise<{ title: string; description: string }[]> {
    const MAX_RETRIES = 3;
    const BACKOFF_MS = [1000, 3000, 9000];

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const result = await this.tryScopeAnalysis(issue);
      if (result.length > 0) return result;

      if (attempt < MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
      }
    }

    return this.keywordFallbackScope(issue);
  }

  /** キーワードベースのスコープ分割フォールバック */
  private keywordFallbackScope(issue: Issue): { title: string; description: string }[] {
    const text = `${issue.title} ${issue.body}`.toLowerCase();

    const SCREEN_KEYWORDS = [
      "テーブル", "フォーム", "ダイアログ", "モーダル", "ナビゲーション",
      "ダッシュボード", "一覧", "詳細", "設定", "ログイン",
      "table", "form", "dialog", "modal", "navigation", "dashboard", "list", "detail",
    ];
    const found = SCREEN_KEYWORDS.filter((kw) => text.includes(kw));

    if (found.length >= 3) {
      return found.map((kw) => ({
        title: `${kw} の修正`,
        description: `${issue.title} のうち、${kw} に関連する部分を修正する`,
      }));
    }

    return [];
  }

  /** 単一のスコープ分析試行（Haiku 使用） */
  private async tryScopeAnalysis(
    issue: Issue,
  ): Promise<{ title: string; description: string }[]> {
    try {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      const jsonSchema = {
        type: "object" as const,
        properties: {
          isLarge: { type: "boolean" as const },
          confidence: { type: "number" as const },
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
          model: "haiku",
          maxTurns: 1,
          maxBudgetUsd: 0.05,
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

      if (!structuredOutput && resultText) {
        const jsonStr = extractFirstJson(resultText);
        if (jsonStr) {
          try {
            structuredOutput = JSON.parse(jsonStr) as unknown;
          } catch { /* ignore parse error */ }
        }
      }

      if (!structuredOutput) return [];

      const parsed = ScopeAnalysisSchema.safeParse(structuredOutput);
      if (!parsed.success) return [];
      if (!parsed.data.isLarge) return [];

      return parsed.data.scopes;
    } catch {
      return [];
    }
  }
}
