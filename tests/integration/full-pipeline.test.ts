import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../../src/queue/schema.js";
import { TaskQueue } from "../../src/queue/task-queue.js";
import { Classifier } from "../../src/agents/classifier.js";

// Mock Agent SDK
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(async function* () {
    yield {
      type: "result",
      subtype: "success",
      result: "done",
      total_cost_usd: 0.1,
      num_turns: 3,
      duration_ms: 5000,
    };
  }),
}));

describe("Full pipeline (US3)", () => {
  let queue: TaskQueue;

  beforeEach(() => {
    const db = new Database(":memory:");
    initSchema(db);
    queue = new TaskQueue(db);
  });

  it("T056-1: feature issue creates 3-step pipeline", async () => {
    const octokit = { issues: { createComment: vi.fn().mockResolvedValue({}) } };
    const classifier = new Classifier(octokit, "org", "repo");

    const result = await classifier.classify({
      number: 50,
      title: "Add payment feature",
      body: "Implement payment processing with Stripe integration",
      labels: ["ai-task", "feature"],
    });

    expect(result.complexity).toBe("pipeline");
    if (result.complexity === "pipeline") {
      expect(result.subTasks).toHaveLength(3);
      expect(result.subTasks.map((s) => s.taskType)).toEqual(["review", "build", "document"]);

      // Push to queue
      const tasks = result.subTasks.map((sub, i) => ({
        id: `gh-50-${i}`,
        taskType: sub.taskType,
        title: sub.title,
        description: sub.description,
        source: i === 0 ? "github_issue:50" : `github_issue:50:${i}`,
        priority: 5 as const,
        dependsOn: sub.dependsOnIndex !== null ? `gh-50-${sub.dependsOnIndex}` : null,
        parentTaskId: null,
      }));
      queue.pushPipeline(tasks);

      // Verify dependency chain
      expect(queue.getNext()?.id).toBe("gh-50-0"); // review first
      queue.updateStatus("gh-50-0", "in_progress");
      queue.updateStatus("gh-50-0", "completed");
      expect(queue.getNext()?.id).toBe("gh-50-1"); // then build
      queue.updateStatus("gh-50-1", "in_progress");
      queue.updateStatus("gh-50-1", "completed");
      expect(queue.getNext()?.id).toBe("gh-50-2"); // then document
    }
  });

  it("T056-2: enhancement label also triggers pipeline", async () => {
    const octokit = { issues: { createComment: vi.fn().mockResolvedValue({}) } };
    const classifier = new Classifier(octokit, "org", "repo");

    const result = await classifier.classify({
      number: 51,
      title: "Enhance logging",
      body: "Add structured logging with correlation IDs",
      labels: ["ai-task", "enhancement"],
    });

    expect(result.complexity).toBe("pipeline");
  });

  it("T056-3: pipeline with approval gate flow", () => {
    // Setup 3-step pipeline
    queue.push({ id: "r", taskType: "review", title: "Review", description: "D", source: "s0", priority: 5, dependsOn: null, parentTaskId: null });
    queue.push({ id: "b", taskType: "build", title: "Build", description: "D", source: "s1", priority: 5, dependsOn: "r", parentTaskId: null });
    queue.push({ id: "d", taskType: "document", title: "Docs", description: "D", source: "s2", priority: 5, dependsOn: "b", parentTaskId: null });

    // Review completes → awaiting approval
    queue.updateStatus("r", "in_progress");
    queue.updateStatus("r", "awaiting_approval", { approvalPrUrl: "https://pr/1" });

    // Build and doc should be blocked
    expect(queue.getNext()).toBeNull();

    // Approve → review completed → build available
    queue.approveTask("r");
    expect(queue.getNext()?.id).toBe("b");

    // Build completes → doc available
    queue.updateStatus("b", "in_progress");
    queue.updateStatus("b", "completed");
    expect(queue.getNext()?.id).toBe("d");
  });
});
