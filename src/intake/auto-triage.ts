import type pino from "pino";

interface OctokitLike {
  issues: {
    addLabels: (params: {
      owner: string;
      repo: string;
      issue_number: number;
      labels: string[];
    }) => Promise<unknown>;
  };
}

export interface TriageResult {
  issueNumber: number;
  appliedLabels: string[];
  estimatedSize: string;
  priority: number;
}

/** サイズ → 優先度のベースマッピング */
const SIZE_TO_PRIORITY: Record<string, number> = {
  S: 3,
  M: 5,
  L: 7,
  XL: 9,
};

/** ラベル → 優先度ブースト */
const LABEL_PRIORITY_BOOST: Record<string, number> = {
  bug: 2,
  critical: 3,
  "priority/high": 3,
  "priority/urgent": 4,
  security: 4,
  regression: 3,
};

export class AutoTriage {
  constructor(
    private readonly octokit: OctokitLike,
    private readonly owner: string,
    private readonly repo: string,
    private readonly logger: pino.Logger,
  ) {}

  /** Issue を自動トリアージし、ラベルを付与する */
  async triage(
    issueNumber: number,
    existingLabels: string[],
    suggestedLabels: string[],
    estimatedSize: string,
    taskType: string,
  ): Promise<TriageResult> {
    const labelsToAdd: string[] = [];

    // サイズラベル（既存にない場合のみ）
    const sizeLabel = `size/${estimatedSize}`;
    if (!existingLabels.some((l) => l.startsWith("size/"))) {
      labelsToAdd.push(sizeLabel);
    }

    // タスクタイプラベル
    const typeLabel = taskType === "build" ? "feature"
      : taskType === "document" ? "docs"
      : "bug";
    if (!existingLabels.includes(typeLabel)) {
      labelsToAdd.push(typeLabel);
    }

    // AI 提案ラベル（既存にないものだけ）
    for (const label of suggestedLabels) {
      if (!existingLabels.includes(label) && !labelsToAdd.includes(label)) {
        labelsToAdd.push(label);
      }
    }

    // ai-managed ラベル
    if (!existingLabels.includes("ai-managed")) {
      labelsToAdd.push("ai-managed");
    }

    // GitHub にラベル付与
    if (labelsToAdd.length > 0) {
      try {
        await this.octokit.issues.addLabels({
          owner: this.owner, repo: this.repo,
          issue_number: issueNumber, labels: labelsToAdd,
        });
        this.logger.info({ issueNumber, labels: labelsToAdd }, "Labels applied");
      } catch {
        this.logger.warn({ issueNumber }, "Failed to apply labels");
      }
    }

    // 優先度計算
    const basePriority = SIZE_TO_PRIORITY[estimatedSize] ?? 5;
    const allLabels = [...existingLabels, ...labelsToAdd];
    let boost = 0;
    for (const label of allLabels) {
      const labelBoost = LABEL_PRIORITY_BOOST[label.toLowerCase()];
      if (labelBoost !== undefined) {
        boost = Math.max(boost, labelBoost);
      }
    }
    const priority = Math.min(10, basePriority + boost);

    return {
      issueNumber,
      appliedLabels: labelsToAdd,
      estimatedSize,
      priority,
    };
  }
}
