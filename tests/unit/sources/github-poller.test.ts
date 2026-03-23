import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../../../src/queue/schema.js";
import { TaskQueue } from "../../../src/queue/task-queue.js";
import { GitHubPoller } from "../../../src/sources/github-poller.js";

// Mock Agent SDK for Classifier's Haiku scope analysis
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(async function* () {
    await Promise.resolve();
    yield { type: "result", result: '{ "isLarge": false, "scopes": [] }' };
  }),
}));

function makeOctokitMock(issues: unknown[] = [], reviews: unknown[] = []) {
  return {
    paginate: vi.fn().mockResolvedValue(issues),
    issues: {
      listForRepo: vi.fn().mockResolvedValue({ data: issues }),
      createComment: vi.fn().mockResolvedValue({}),
    },
    pulls: {
      listReviews: vi.fn().mockResolvedValue({ data: reviews }),
      get: vi.fn().mockResolvedValue({ data: { state: "open", merged: false } }),
    },
  };
}

function makeIssue(number: number, labels: string[] = ["bug"]) {
  return {
    number,
    title: `Issue #${number}`,
    body: "Description of the issue",
    labels: labels.map((name) => ({ name })),
    state: "open",
  };
}

describe("GitHubPoller", () => {
  let queue: TaskQueue;

  beforeEach(() => {
    const db = new Database(":memory:");
    initSchema(db);
    queue = new TaskQueue(db);
  });

  describe("pollIssues", () => {
    it("detects open issue and creates pipeline tasks", async () => {
      const octokit = makeOctokitMock([makeIssue(42)]);
      const poller = new GitHubPoller(octokit as never, queue, "org", "repo");
      await poller.pollIssues();
      // Pipeline creates 2 tasks: review + fix
      const pending = queue.getByStatus("pending");
      expect(pending.length).toBeGreaterThanOrEqual(2);
      expect(pending[0]?.taskType).toBe("review");
    });

    it("ignores already processed issue", async () => {
      const octokit = makeOctokitMock([makeIssue(42)]);
      const poller = new GitHubPoller(octokit as never, queue, "org", "repo");
      await poller.pollIssues();
      const count1 = queue.getByStatus("pending").length;
      await poller.pollIssues();
      expect(queue.getByStatus("pending").length).toBe(count1);
    });

    it("handles GitHub API error gracefully", async () => {
      const octokit = makeOctokitMock();
      octokit.issues.listForRepo.mockRejectedValue(new Error("500"));
      const poller = new GitHubPoller(octokit as never, queue, "org", "repo");
      await expect(poller.pollIssues()).resolves.toBeUndefined();
    });

    it("feature label creates review+build pipeline", async () => {
      const octokit = makeOctokitMock([makeIssue(50, ["feature"])]);
      const poller = new GitHubPoller(octokit as never, queue, "org", "repo");
      await poller.pollIssues();
      const pending = queue.getByStatus("pending");
      expect(pending.some((t) => t.taskType === "review")).toBe(true);
      expect(pending.some((t) => t.taskType === "build")).toBe(true);
    });
  });

  describe("pollApprovals", () => {
    it("approve unblocks successor", async () => {
      queue.push({
        id: "review-1", taskType: "review", title: "Review",
        description: "D", source: "github_issue:42", priority: 5,
        dependsOn: null, parentTaskId: null, repo: null,
      });
      queue.push({
        id: "fix-1", taskType: "fix", title: "Fix",
        description: "D", source: "github_issue:42:1", priority: 5,
        dependsOn: "review-1", parentTaskId: "review-1", repo: null,
      });
      queue.updateStatus("review-1", "in_progress");
      queue.updateStatus("review-1", "awaiting_approval", {
        approvalPrUrl: "https://github.com/org/repo/pull/10",
      });

      const octokit = makeOctokitMock([], [{ state: "APPROVED" }]);
      const poller = new GitHubPoller(octokit as never, queue, "org", "repo");
      await poller.pollApprovals();

      expect(queue.getById("review-1")?.status).toBe("in_progress");
    });

    it("closed PR cancels pipeline", async () => {
      queue.push({
        id: "review-1", taskType: "review", title: "Review",
        description: "D", source: "s1", priority: 5,
        dependsOn: null, parentTaskId: null, repo: null,
      });
      queue.push({
        id: "fix-1", taskType: "fix", title: "Fix",
        description: "D", source: "s2", priority: 5,
        dependsOn: "review-1", parentTaskId: "review-1", repo: null,
      });
      queue.updateStatus("review-1", "in_progress");
      queue.updateStatus("review-1", "awaiting_approval", {
        approvalPrUrl: "https://github.com/org/repo/pull/10",
      });

      const octokit = makeOctokitMock();
      octokit.pulls.get.mockResolvedValue({ data: { state: "closed", merged: false } });
      const poller = new GitHubPoller(octokit as never, queue, "org", "repo");
      await poller.pollApprovals();

      expect(queue.getById("review-1")?.status).toBe("failed");
    });

    it("no awaiting tasks skips check", async () => {
      const octokit = makeOctokitMock();
      const poller = new GitHubPoller(octokit as never, queue, "org", "repo");
      await poller.pollApprovals();
      expect(octokit.pulls.listReviews).not.toHaveBeenCalled();
    });
  });
});
