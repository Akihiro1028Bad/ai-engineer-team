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

/** ラベルから実装タスクの種別を決定する */
function detectTaskType(labels: string[]): TaskType {
  for (const label of labels) {
    const lower = label.toLowerCase();
    if (lower === "feature" || lower === "enhancement") return "build";
    if (lower === "documentation" || lower === "docs") return "document";
  }
  // デフォルトは fix（bug ラベルや不明なラベル）
  return "fix";
}

/** 全 Issue を 2 ステップパイプライン [review, fix/build/document] に分解する */
function buildPipelineSubTasks(issue: Issue, implType: TaskType): SubTaskDef[] {
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

export class Classifier {
  constructor(
    private readonly _octokit: OctokitLike,
    private readonly _owner: string,
    private readonly _repo: string,
  ) {}

  async classify(issue: Issue): Promise<Classification> {
    const implType = detectTaskType(issue.labels);

    return {
      issueId: issue.number,
      complexity: "pipeline",
      subTasks: buildPipelineSubTasks(issue, implType),
    };
  }
}
