import { ClassificationSchema } from "../types.js";
import type { Classification, SubTaskDef } from "../types.js";

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

const LABEL_MAP: Record<string, "fix" | "build" | "document" | "review"> = {
  bug: "fix",
  fix: "fix",
  feature: "build",
  enhancement: "build",
  documentation: "document",
  docs: "document",
};

const PIPELINE_LABELS = new Set(["feature", "enhancement"]);

function buildPipelineSubTasks(issue: Issue): SubTaskDef[] {
  return [
    {
      taskType: "review",
      title: `設計レビュー: ${issue.title}`,
      description: `Issue #${issue.number} の設計レビューを実施する\n\n${issue.body}`,
      dependsOnIndex: null,
    },
    {
      taskType: "build",
      title: `実装: ${issue.title}`,
      description: `Issue #${issue.number} の機能を実装する`,
      dependsOnIndex: 0,
    },
    {
      taskType: "document",
      title: `ドキュメント更新: ${issue.title}`,
      description: `Issue #${issue.number} の変更に合わせてドキュメントを更新する`,
      dependsOnIndex: 1,
    },
  ];
}

export class Classifier {
  constructor(
    private readonly octokit: OctokitLike,
    private readonly owner: string,
    private readonly repo: string,
  ) {}

  async classify(issue: Issue): Promise<Classification> {
    // Check for empty/short body first
    if (!issue.body || issue.body.trim().length < 5) {
      return this.handleUnclear(issue, "Issue の内容が不十分です。詳細を記載してください。");
    }

    // Label-based classification
    for (const label of issue.labels) {
      const lower = label.toLowerCase();

      // Pipeline for feature/enhancement
      if (PIPELINE_LABELS.has(lower)) {
        return {
          issueId: issue.number,
          complexity: "pipeline",
          subTasks: buildPipelineSubTasks(issue),
        };
      }

      // Single task for known labels
      const taskType = LABEL_MAP[lower];
      if (taskType) {
        return {
          issueId: issue.number,
          complexity: "single",
          taskType,
        };
      }
    }

    // No recognizable label → use Haiku to classify from body
    return this.classifyWithHaiku(issue);
  }

  private async classifyWithHaiku(issue: Issue): Promise<Classification> {
    try {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      let structuredOutput: unknown = null;

      for await (const message of query({
        prompt: `Classify this GitHub Issue:\nTitle: ${issue.title}\nBody: ${issue.body}\n\nReturn JSON with complexity ("single" or "pipeline") and taskType ("review", "fix", "build", or "document").`,
        options: {
          model: "haiku",
          maxTurns: 1,
          allowedTools: [],
          permissionMode: "dontAsk",
        },
      }) as AsyncIterable<{ type: string; structured_output?: unknown }>) {
        if (message.type === "result") {
          structuredOutput = message.structured_output;
        }
      }

      if (structuredOutput) {
        const parsed = ClassificationSchema.safeParse({
          issueId: issue.number,
          ...structuredOutput as Record<string, unknown>,
        });
        if (parsed.success) {
          return parsed.data;
        }
      }

      return this.handleUnclear(issue, "分類を自動判定できませんでした。タスク種別を教えてください。");
    } catch {
      return this.handleUnclear(issue, "分類処理中にエラーが発生しました。手動で分類してください。");
    }
  }

  private async handleUnclear(issue: Issue, question: string): Promise<Classification> {
    try {
      await this.octokit.issues.createComment({
        owner: this.owner,
        repo: this.repo,
        issue_number: issue.number,
        body: `🤖 **AI Agent Orchestrator**\n\n${question}\n\n以下のラベルを追加して再分類をトリガーしてください:\n- \`bug\` / \`fix\` → バグ修正\n- \`feature\` / \`enhancement\` → 新機能実装\n- \`documentation\` / \`docs\` → ドキュメント更新`,
      });
    } catch {
      // Comment posting failure is non-critical
    }

    return {
      issueId: issue.number,
      complexity: "unclear",
      question,
    };
  }
}
