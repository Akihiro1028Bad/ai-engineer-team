import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../../src/queue/schema.js";
import { TaskQueue } from "../../src/queue/task-queue.js";
import { Classifier } from "../../src/agents/classifier.js";

describe("Full pipeline (design-first flow)", () => {
  let queue: TaskQueue;

  beforeEach(() => {
    const db = new Database(":memory:");
    initSchema(db);
    queue = new TaskQueue(db);
  });

  it("bug issue creates [review, fix] pipeline", async () => {
    const octokit = { issues: { createComment: vi.fn().mockResolvedValue({}) } };
    const classifier = new Classifier(octokit, "org", "repo");

    const result = await classifier.classify({
      number: 42,
      title: "Login validation bug",
      body: "Email with + fails validation",
      labels: ["bug"],
    });

    expect(result.complexity).toBe("pipeline");
    if (result.complexity === "pipeline") {
      expect(result.subTasks).toHaveLength(2);
      expect(result.subTasks[0]!.taskType).toBe("review");
      expect(result.subTasks[1]!.taskType).toBe("fix");
      expect(result.subTasks[0]!.description).toContain("design.md");
    }
  });

  it("feature issue creates [review, build] pipeline", async () => {
    const octokit = { issues: { createComment: vi.fn().mockResolvedValue({}) } };
    const classifier = new Classifier(octokit, "org", "repo");

    const result = await classifier.classify({
      number: 50,
      title: "Add payment feature",
      body: "Implement Stripe integration",
      labels: ["feature"],
    });

    expect(result.complexity).toBe("pipeline");
    if (result.complexity === "pipeline") {
      expect(result.subTasks).toHaveLength(2);
      expect(result.subTasks[0]!.taskType).toBe("review");
      expect(result.subTasks[1]!.taskType).toBe("build");
    }
  });

  it("pipeline with approval gate flow", () => {
    queue.push({ id: "r", taskType: "review", title: "Review", description: "D", source: "s0", priority: 5, dependsOn: null, parentTaskId: null });
    queue.push({ id: "f", taskType: "fix", title: "Fix", description: "D", source: "s1", priority: 5, dependsOn: "r", parentTaskId: "r" });

    // Review completes → awaiting approval
    queue.updateStatus("r", "in_progress");
    queue.updateStatus("r", "awaiting_approval", { approvalPrUrl: "https://pr/1" });

    // Fix should be blocked
    expect(queue.getNext()).toBeNull();

    // Approve → review completed → fix available
    queue.approveTask("r");
    expect(queue.getNext()?.id).toBe("f");
  });
});
