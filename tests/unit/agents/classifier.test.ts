import { describe, it, expect, beforeEach } from "vitest";
import { Classifier } from "../../../src/agents/classifier.js";

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
    classifier = new Classifier(mockOctokit, "org", "repo");
  });

  it("always returns pipeline", async () => {
    const result = await classifier.classify(makeIssue());
    expect(result.complexity).toBe("pipeline");
  });

  it("bug label → pipeline [review, fix]", async () => {
    const result = await classifier.classify(makeIssue({ labels: ["bug"] }));
    if (result.complexity === "pipeline") {
      expect(result.subTasks).toHaveLength(2);
      expect(result.subTasks[0]!.taskType).toBe("review");
      expect(result.subTasks[1]!.taskType).toBe("fix");
    }
  });

  it("feature label → pipeline [review, build]", async () => {
    const result = await classifier.classify(makeIssue({ labels: ["feature"] }));
    if (result.complexity === "pipeline") {
      expect(result.subTasks[1]!.taskType).toBe("build");
    }
  });

  it("documentation label → pipeline [review, document]", async () => {
    const result = await classifier.classify(makeIssue({ labels: ["documentation"] }));
    if (result.complexity === "pipeline") {
      expect(result.subTasks[1]!.taskType).toBe("document");
    }
  });

  it("no label → pipeline [review, fix] (default)", async () => {
    const result = await classifier.classify(makeIssue({ labels: [] }));
    if (result.complexity === "pipeline") {
      expect(result.subTasks[1]!.taskType).toBe("fix");
    }
  });

  it("subtask dependencies are correct", async () => {
    const result = await classifier.classify(makeIssue());
    if (result.complexity === "pipeline") {
      expect(result.subTasks[0]!.dependsOnIndex).toBeNull();
      expect(result.subTasks[1]!.dependsOnIndex).toBe(0);
    }
  });

  it("review task description includes issue number", async () => {
    const result = await classifier.classify(makeIssue());
    if (result.complexity === "pipeline") {
      expect(result.subTasks[0]!.description).toContain("42");
      expect(result.subTasks[0]!.description).toContain("specs/issue-42/design.md");
    }
  });

  it("impl task description references design.md", async () => {
    const result = await classifier.classify(makeIssue());
    if (result.complexity === "pipeline") {
      expect(result.subTasks[1]!.description).toContain("specs/issue-42/design.md");
    }
  });
});
