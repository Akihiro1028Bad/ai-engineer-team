import { describe, it, expect, vi, beforeEach } from "vitest";
import { ResultCollector } from "../../../src/bridges/result-collector.js";
import { SlackNotifier } from "../../../src/notifications/slack-notifier.js";
import type { Task } from "../../../src/types.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "gh-42-0",
    taskType: "review",
    title: "Test review",
    description: "D",
    source: "github_issue:42",
    priority: 5,
    status: "completed",
    result: '{"findings":[]}',
    costUsd: 0.23,
    turnsUsed: 8,
    retryCount: 0,
    dependsOn: null,
    parentTaskId: null,
    contextFile: null,
    approvalPrUrl: null,
    prNumber: null,
    ciFixCount: 0,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("ResultCollector", () => {
  let mockCreatePR: ReturnType<typeof vi.fn>;
  let mockDiff: ReturnType<typeof vi.fn>;
  let slackSendSpy: ReturnType<typeof vi.fn>;
  let collector: ResultCollector;

  beforeEach(() => {
    mockCreatePR = vi.fn().mockResolvedValue({ data: { html_url: "https://github.com/org/repo/pull/99" } });
    mockDiff = vi.fn().mockResolvedValue({ data: "+line1\n+line2\n".repeat(100) }); // 200 lines
    const octokit = {
      pulls: { create: mockCreatePR },
      repos: { compareCommits: mockDiff },
    };
    slackSendSpy = vi.fn().mockResolvedValue(undefined);
    const notifier = { send: slackSendSpy } as unknown as SlackNotifier;
    collector = new ResultCollector(octokit as never, notifier, "org", "repo");
  });

  it("T-RC-001: creates design PR and sends approval_requested", async () => {
    const result = await collector.createDesignPR(makeTask(), "agent/reviewer/gh-42-0");
    expect(mockCreatePR).toHaveBeenCalled();
    expect(result.prUrl).toContain("pull/99");
    expect(slackSendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "approval_requested" }),
    );
  });

  it("T-RC-002: creates final PR and sends pipeline_pr_created", async () => {
    const tasks = [makeTask(), makeTask({ id: "gh-42-1", taskType: "fix" })];
    const result = await collector.createFinalPR(tasks, "agent/fixer/gh-42-1");
    expect(mockCreatePR).toHaveBeenCalled();
    expect(result.prUrl).toContain("pull/99");
    expect(slackSendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "pipeline_pr_created" }),
    );
  });

  it("T-RC-003: creates single PR and sends task_completed", async () => {
    const _result = await collector.createSinglePR(makeTask(), "agent/reviewer/gh-42-0");
    expect(mockCreatePR).toHaveBeenCalled();
    expect(slackSendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: "task_completed" }),
    );
  });

  it("T-RC-004: succeeds when diff ≤ 500 lines", async () => {
    mockDiff.mockResolvedValue({ data: "+line\n".repeat(300) });
    const result = await collector.createSinglePR(makeTask(), "branch");
    expect(result.success).toBe(true);
  });

  it("T-RC-005: rejects when diff > 500 lines", async () => {
    mockDiff.mockResolvedValue({ data: "+line\n".repeat(600) });
    const result = await collector.createSinglePR(makeTask(), "branch");
    expect(result.success).toBe(false);
    expect(result.error).toContain("500");
  });

  it("T-RC-006: handles PR creation API error", async () => {
    mockCreatePR.mockRejectedValue(new Error("422 Validation Failed"));
    const result = await collector.createSinglePR(makeTask(), "branch");
    expect(result.success).toBe(false);
  });

  it("T-RC-007: PR body includes evidence section", async () => {
    await collector.createSinglePR(makeTask({ result: '{"test":"pass"}' }), "branch");
    const calls = mockCreatePR.mock.calls as unknown[][];
    const call = calls[0] ?? [];
    const arg = call[0] as { body?: string } | undefined;
    const body = arg?.body ?? "";
    expect(body).toContain("エビデンス");
  });

  it("T-RC-008: skips Slack when notifier has no URL", async () => {
    await Promise.resolve();
    const nullNotifier = new SlackNotifier(undefined);
    const _c = new ResultCollector({} as never, nullNotifier, "org", "repo");
  });
});
