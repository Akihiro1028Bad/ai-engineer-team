import { describe, it, expect, vi, beforeEach } from "vitest";
import { Classifier } from "../../../src/agents/classifier.js";

// Mock Agent SDK
const mockClassifyResult: unknown[] = [];
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(async function* () {
    for (const msg of mockClassifyResult) {
      yield msg;
    }
  }),
}));

// Mock Octokit
const mockCreateComment = vi.fn().mockResolvedValue({});
const mockOctokit = {
  issues: { createComment: mockCreateComment },
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
    body: overrides.body ?? "The email validation fails when + is present",
    labels: overrides.labels ?? ["ai-task", "bug"],
  };
}

describe("Classifier", () => {
  let classifier: Classifier;

  beforeEach(() => {
    mockClassifyResult.length = 0;
    mockCreateComment.mockClear();
    classifier = new Classifier(mockOctokit, "org", "repo");
  });

  it("T-CLS-001: bug label → fix (single)", async () => {
    const result = await classifier.classify(makeIssue({ labels: ["ai-task", "bug"] }));
    expect(result.complexity).toBe("single");
    if (result.complexity === "single") {
      expect(result.taskType).toBe("fix");
    }
  });

  it("T-CLS-002: feature label → pipeline (review→build→document)", async () => {
    const result = await classifier.classify(makeIssue({ labels: ["ai-task", "feature"] }));
    expect(result.complexity).toBe("pipeline");
    if (result.complexity === "pipeline") {
      expect(result.subTasks).toHaveLength(3);
      expect(result.subTasks[0]!.taskType).toBe("review");
      expect(result.subTasks[1]!.taskType).toBe("build");
      expect(result.subTasks[2]!.taskType).toBe("document");
    }
  });

  it("T-CLS-003: docs label → document (single)", async () => {
    const result = await classifier.classify(makeIssue({ labels: ["ai-task", "documentation"] }));
    expect(result.complexity).toBe("single");
    if (result.complexity === "single") {
      expect(result.taskType).toBe("document");
    }
  });

  it("T-CLS-004: no type label → Haiku classifies from body", async () => {
    mockClassifyResult.push({
      type: "result",
      subtype: "success",
      result: "",
      total_cost_usd: 0.01,
      num_turns: 1,
      duration_ms: 500,
      structured_output: { complexity: "single", taskType: "fix" },
    });

    const result = await classifier.classify(makeIssue({ labels: ["ai-task"] }));
    expect(result.complexity).toBe("single");
  });

  it("T-CLS-005: empty body → unclear", async () => {
    const result = await classifier.classify(makeIssue({ labels: ["ai-task"], body: "" }));
    expect(result.complexity).toBe("unclear");
  });

  it("T-CLS-006: very short body → unclear", async () => {
    const result = await classifier.classify(makeIssue({ labels: ["ai-task"], body: "fix" }));
    expect(result.complexity).toBe("unclear");
  });

  it("T-CLS-007: Haiku API error → unclear", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    // @ts-expect-error mock override
    vi.mocked(query).mockImplementationOnce(async function* () {
      throw new Error("API error");
    });

    const result = await classifier.classify(makeIssue({ labels: ["ai-task"] }));
    expect(result.complexity).toBe("unclear");
  });

  it("T-CLS-008: Haiku returns invalid JSON → unclear", async () => {
    mockClassifyResult.push({
      type: "result",
      subtype: "success",
      result: "",
      total_cost_usd: 0.01,
      num_turns: 1,
      duration_ms: 500,
      structured_output: { invalid: "data" },
    });

    const result = await classifier.classify(makeIssue({ labels: ["ai-task"] }));
    expect(result.complexity).toBe("unclear");
  });

  it("T-CLS-009: pipeline subtask dependencies are correct", async () => {
    const result = await classifier.classify(makeIssue({ labels: ["ai-task", "feature"] }));
    if (result.complexity === "pipeline") {
      expect(result.subTasks[0]!.dependsOnIndex).toBeNull();
      expect(result.subTasks[1]!.dependsOnIndex).toBe(0);
      expect(result.subTasks[2]!.dependsOnIndex).toBe(1);
    }
  });

  it("T-CLS-010: Haiku query uses model haiku", async () => {
    mockClassifyResult.push({
      type: "result",
      subtype: "success",
      result: "",
      total_cost_usd: 0.01,
      num_turns: 1,
      duration_ms: 500,
      structured_output: { complexity: "single", taskType: "review" },
    });

    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    await classifier.classify(makeIssue({ labels: ["ai-task"] }));
    const calls = vi.mocked(query).mock.calls;
    if (calls.length > 0) {
      const opts = calls[calls.length - 1]![0] as { options?: { model?: string } };
      expect(opts.options?.model).toBe("haiku");
    }
  });

  it("T-CLS-011: unclear posts GitHub Issue comment", async () => {
    const result = await classifier.classify(makeIssue({ labels: ["ai-task"], body: "" }));
    expect(result.complexity).toBe("unclear");
    expect(mockCreateComment).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "org",
        repo: "repo",
        issue_number: 42,
      }),
    );
  });
});
