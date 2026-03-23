import { describe, it, expect, vi, beforeEach } from "vitest";
import { Classifier } from "../../../src/agents/classifier.js";

// Mock Agent SDK — Haiku scope analysis
const mockHaikuResult: unknown[] = [];
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(async function* () {
    for (const msg of mockHaikuResult) {
      yield msg;
    }
  }),
}));

const mockOctokit = {
  issues: { createComment: async () => ({}) },
};

interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 42,
    title: overrides.title ?? "Bug in auth module",
    body: overrides.body ?? "The email validation fails",
    labels: overrides.labels ?? ["bug"],
  };
}

describe("Classifier", () => {
  let classifier: Classifier;

  beforeEach(() => {
    mockHaikuResult.length = 0;
    classifier = new Classifier(mockOctokit, "org", "repo");
  });

  it("small issue → single pipeline [review, fix]", async () => {
    // Haiku returns isLarge: false
    mockHaikuResult.push({
      type: "result",
      result: '{ "isLarge": false, "scopes": [] }',
    });

    const result = await classifier.classify(makeIssue());
    expect(result.pipelines).toHaveLength(1);
    expect(result.pipelines[0]!.scopeId).toBe("main");
    const sub = result.pipelines[0]!.classification;
    if (sub.complexity === "pipeline") {
      expect(sub.subTasks).toHaveLength(2);
      expect(sub.subTasks[0]!.taskType).toBe("review");
      expect(sub.subTasks[1]!.taskType).toBe("fix");
    }
  });

  it("large issue → multiple pipelines per scope", async () => {
    mockHaikuResult.push({
      type: "result",
      result: JSON.stringify({
        isLarge: true,
        scopes: [
          { title: "イベントテーブルのカード化", description: "イベント一覧をカード表示に" },
          { title: "参加者テーブルのカード化", description: "参加者一覧をカード表示に" },
          { title: "フォームの1カラム化", description: "フォームを縦並びに" },
        ],
      }),
    });

    const result = await classifier.classify(makeIssue({ number: 22, title: "スマホ表示の改善" }));
    expect(result.pipelines).toHaveLength(3);
    expect(result.pipelines[0]!.scopeId).toBe("scope-1");
    expect(result.pipelines[1]!.scopeId).toBe("scope-2");
    expect(result.pipelines[2]!.scopeId).toBe("scope-3");

    // 各スコープが独立した [review, fix] パイプライン
    for (const p of result.pipelines) {
      if (p.classification.complexity === "pipeline") {
        expect(p.classification.subTasks).toHaveLength(2);
        expect(p.classification.subTasks[0]!.taskType).toBe("review");
        expect(p.classification.subTasks[1]!.taskType).toBe("fix");
      }
    }
  });

  it("feature label → build instead of fix", async () => {
    mockHaikuResult.push({
      type: "result",
      result: '{ "isLarge": false, "scopes": [] }',
    });

    const result = await classifier.classify(makeIssue({ labels: ["feature"] }));
    if (result.pipelines[0]!.classification.complexity === "pipeline") {
      expect(result.pipelines[0]!.classification.subTasks[1]!.taskType).toBe("build");
    }
  });

  it("Haiku failure → fallback to single pipeline", async () => {
    // No mock result → query throws or returns nothing
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    // @ts-expect-error mock override
    vi.mocked(query).mockImplementationOnce(async function* () {
      throw new Error("API error");
    });

    const result = await classifier.classify(makeIssue());
    expect(result.pipelines).toHaveLength(1);
  });

  it("scoped design.md path includes scopeId", async () => {
    mockHaikuResult.push({
      type: "result",
      result: JSON.stringify({
        isLarge: true,
        scopes: [
          { title: "テーブル改善", description: "テーブルをカード化" },
          { title: "フォーム改善", description: "フォームを1カラムに" },
        ],
      }),
    });

    const result = await classifier.classify(makeIssue({ number: 22 }));
    const cls0 = result.pipelines[0]!.classification;
    const cls1 = result.pipelines[1]!.classification;
    if (cls0.complexity === "pipeline" && cls1.complexity === "pipeline") {
      expect(cls0.subTasks[0]!.description).toContain("scope-1/design.md");
      expect(cls1.subTasks[0]!.description).toContain("scope-2/design.md");
    }
  });
});
