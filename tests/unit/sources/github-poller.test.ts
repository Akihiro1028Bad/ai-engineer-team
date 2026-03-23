import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initSchema } from "../../../src/queue/schema.js";
import { TaskQueue } from "../../../src/queue/task-queue.js";
import { GitHubPoller } from "../../../src/sources/github-poller.js";

// Mock Agent SDK for Classifier
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(async function* () {
    yield {
      type: "result",
      subtype: "success",
      structured_output: { complexity: "single", taskType: "fix" },
    };
  }),
}));

function makeOctokitMock(issues: unknown[] = [], reviews: unknown[] = []) {
  return {
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

function makeIssue(number: number, labels: string[] = ["ai-task", "bug"]) {
  return {
    number,
    title: `Issue #${number}`,
    body: "Some description of the issue that needs attention",
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
    it("T-GHP-001: detects ai-task labeled issue", async () => {
      const octokit = makeOctokitMock([makeIssue(42)]);
      const poller = new GitHubPoller(octokit as never, queue, "org", "repo");
      await poller.pollIssues();
      expect(queue.getNext()).not.toBeNull();
    });

    it("T-GHP-002: ignores issue without ai-task label", async () => {
      const octokit = makeOctokitMock([makeIssue(43, ["bug"])]);
      const poller = new GitHubPoller(octokit as never, queue, "org", "repo");
      await poller.pollIssues();
      expect(queue.getNext()).toBeNull();
    });

    it("T-GHP-003: ignores already processed issue", async () => {
      const octokit = makeOctokitMock([makeIssue(42)]);
      const poller = new GitHubPoller(octokit as never, queue, "org", "repo");
      await poller.pollIssues();
      await poller.pollIssues(); // second poll
      expect(queue.getByStatus("pending")).toHaveLength(1);
    });

    it("T-GHP-004: processes multiple issues", async () => {
      const octokit = makeOctokitMock([makeIssue(42), makeIssue(43), makeIssue(44)]);
      const poller = new GitHubPoller(octokit as never, queue, "org", "repo");
      await poller.pollIssues();
      expect(queue.getByStatus("pending")).toHaveLength(3);
    });

    it("T-GHP-005: handles GitHub API 5xx", async () => {
      const octokit = makeOctokitMock();
      octokit.issues.listForRepo.mockRejectedValue(new Error("500 Internal Server Error"));
      const poller = new GitHubPoller(octokit as never, queue, "org", "repo");
      await expect(poller.pollIssues()).resolves.toBeUndefined();
    });

    it("T-GHP-006: handles GitHub rate limit 403", async () => {
      const octokit = makeOctokitMock();
      octokit.issues.listForRepo.mockRejectedValue(new Error("403 rate limit exceeded"));
      const poller = new GitHubPoller(octokit as never, queue, "org", "repo");
      await expect(poller.pollIssues()).resolves.toBeUndefined();
    });

    it("T-GHP-007: handles network error", async () => {
      const octokit = makeOctokitMock();
      octokit.issues.listForRepo.mockRejectedValue(new Error("ECONNREFUSED"));
      const poller = new GitHubPoller(octokit as never, queue, "org", "repo");
      await expect(poller.pollIssues()).resolves.toBeUndefined();
    });
  });

  describe("pollApprovals", () => {
    it("T-GHP-008: approve unblocks successor", async () => {
      // Setup: review task awaiting approval
      queue.push({
        id: "review-1", taskType: "review", title: "Review",
        description: "D", source: "github_issue:42", priority: 5,
        dependsOn: null, parentTaskId: null,
      });
      queue.push({
        id: "fix-1", taskType: "fix", title: "Fix",
        description: "D", source: "github_issue:42:fix", priority: 5,
        dependsOn: "review-1", parentTaskId: null,
      });
      queue.updateStatus("review-1", "in_progress");
      queue.updateStatus("review-1", "awaiting_approval", {
        approvalPrUrl: "https://github.com/org/repo/pull/10",
      });

      const octokit = makeOctokitMock([], [{ state: "APPROVED" }]);
      const poller = new GitHubPoller(octokit as never, queue, "org", "repo");
      await poller.pollApprovals();

      expect(queue.getById("review-1")?.status).toBe("completed");
    });

    it("T-GHP-009: changes_requested keeps awaiting", async () => {
      queue.push({
        id: "review-1", taskType: "review", title: "Review",
        description: "D", source: "s1", priority: 5,
        dependsOn: null, parentTaskId: null,
      });
      queue.updateStatus("review-1", "in_progress");
      queue.updateStatus("review-1", "awaiting_approval", {
        approvalPrUrl: "https://github.com/org/repo/pull/10",
      });

      const octokit = makeOctokitMock([], [{ state: "CHANGES_REQUESTED" }]);
      const poller = new GitHubPoller(octokit as never, queue, "org", "repo");
      await poller.pollApprovals();

      expect(queue.getById("review-1")?.status).toBe("awaiting_approval");
    });

    it("T-GHP-010: closed PR cancels pipeline", async () => {
      queue.push({
        id: "parent", taskType: "review", title: "Parent",
        description: "D", source: "s0", priority: 5,
        dependsOn: null, parentTaskId: null,
      });
      queue.push({
        id: "review-1", taskType: "review", title: "Review",
        description: "D", source: "s1", priority: 5,
        dependsOn: null, parentTaskId: "parent",
      });
      queue.push({
        id: "fix-1", taskType: "fix", title: "Fix",
        description: "D", source: "s2", priority: 5,
        dependsOn: "review-1", parentTaskId: "parent",
      });
      queue.updateStatus("review-1", "in_progress");
      queue.updateStatus("review-1", "awaiting_approval", {
        approvalPrUrl: "https://github.com/org/repo/pull/10",
      });

      const octokit = makeOctokitMock();
      octokit.pulls.get.mockResolvedValue({ data: { state: "closed", merged: false } });
      octokit.pulls.listReviews.mockResolvedValue({ data: [] });
      const poller = new GitHubPoller(octokit as never, queue, "org", "repo");
      await poller.pollApprovals();

      expect(queue.getById("review-1")?.status).toBe("failed");
      expect(queue.getById("fix-1")?.status).toBe("failed");
    });

    it("T-GHP-011: no awaiting tasks skips check", async () => {
      const octokit = makeOctokitMock();
      const poller = new GitHubPoller(octokit as never, queue, "org", "repo");
      await poller.pollApprovals();
      expect(octokit.pulls.listReviews).not.toHaveBeenCalled();
    });

    it("T-GHP-013: PR API error is handled gracefully", async () => {
      queue.push({
        id: "review-1", taskType: "review", title: "Review",
        description: "D", source: "s1", priority: 5,
        dependsOn: null, parentTaskId: null,
      });
      queue.updateStatus("review-1", "in_progress");
      queue.updateStatus("review-1", "awaiting_approval", {
        approvalPrUrl: "https://github.com/org/repo/pull/10",
      });

      const octokit = makeOctokitMock();
      octokit.pulls.get.mockRejectedValue(new Error("500"));
      const poller = new GitHubPoller(octokit as never, queue, "org", "repo");
      await expect(poller.pollApprovals()).resolves.toBeUndefined();
    });
  });
});
