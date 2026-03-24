import { describe, it, expect, vi, beforeEach } from "vitest";
import { SlackNotifier } from "../../../src/notifications/slack-notifier.js";
import type { SlackNotification } from "../../../src/types.js";

function makeNotification(overrides: Partial<SlackNotification> = {}): SlackNotification {
  return {
    level: overrides.level ?? "info",
    event: overrides.event ?? "task_completed",
    title: overrides.title ?? "Test",
    body: overrides.body ?? "Test body",
    fields: overrides.fields ?? {},
    timestamp: overrides.timestamp ?? new Date().toISOString(),
  };
}

function extractBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const calls = fetchMock.mock.calls as unknown[][];
  const firstCall = calls[0] ?? [];
  const opts = firstCall[1] as { body?: string } | undefined;
  return JSON.parse(opts?.body ?? "{}") as Record<string, unknown>;
}

describe("SlackNotifier", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
  });

  it("T-SN-001: sends info with green color", async () => {
    const notifier = new SlackNotifier("https://hooks.slack.com/test");
    await notifier.send(makeNotification({ level: "info" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = extractBody(fetchMock) as { attachments: { color: string }[] };
    const att = body.attachments[0] ?? { color: "" };
    expect(att.color).toBe("#36a64f");
  });

  it("T-SN-002: sends warn with yellow color", async () => {
    const notifier = new SlackNotifier("https://hooks.slack.com/test");
    await notifier.send(makeNotification({ level: "warn" }));
    const body = extractBody(fetchMock) as { attachments: { color: string }[] };
    const att = body.attachments[0] ?? { color: "" };
    expect(att.color).toBe("#ff9900");
  });

  it("T-SN-003: sends error with red color", async () => {
    const notifier = new SlackNotifier("https://hooks.slack.com/test");
    await notifier.send(makeNotification({ level: "error" }));
    const body = extractBody(fetchMock) as { attachments: { color: string }[] };
    const att = body.attachments[0] ?? { color: "" };
    expect(att.color).toBe("#cc0000");
  });

  it("T-SN-004: skips when webhook URL is undefined", async () => {
    const notifier = new SlackNotifier(undefined);
    await notifier.send(makeNotification());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("T-SN-005: does not throw on HTTP 500", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const notifier = new SlackNotifier("https://hooks.slack.com/test");
    await expect(notifier.send(makeNotification())).resolves.toBeUndefined();
  });

  it("T-SN-006: does not throw on network error", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const notifier = new SlackNotifier("https://hooks.slack.com/test");
    await expect(notifier.send(makeNotification())).resolves.toBeUndefined();
  });

  it("T-SN-007: daily digest includes correct body format", async () => {
    const notifier = new SlackNotifier("https://hooks.slack.com/test");
    await notifier.send(
      makeNotification({
        event: "daily_digest",
        body: "完了: 7 tasks\n失敗: 1 task\nコスト: $4.23",
        fields: { completed: "7", failed: "1", cost: "$4.23" },
      }),
    );
    const body = extractBody(fetchMock) as { attachments: { text: string }[] };
    const att = body.attachments[0] ?? { text: "" };
    expect(att.text).toContain("完了: 7 tasks");
  });

  it("T-SN-008: sends successfully with empty fields", async () => {
    const notifier = new SlackNotifier("https://hooks.slack.com/test");
    await notifier.send(makeNotification({ fields: {} }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("T-SN-009: approval_requested includes PR URL", async () => {
    const notifier = new SlackNotifier("https://hooks.slack.com/test");
    await notifier.send(
      makeNotification({
        event: "approval_requested",
        fields: { prUrl: "https://github.com/org/repo/pull/123" },
      }),
    );
    const body = extractBody(fetchMock) as { attachments: { fields: { value: string }[] }[] };
    const att = body.attachments[0] ?? { fields: [] };
    const fieldValues = att.fields.map((f) => f.value);
    expect(fieldValues).toContain("https://github.com/org/repo/pull/123");
  });

  it("T-SN-010: all 12 event types produce valid payloads", async () => {
    const events = [
      "task_completed", "approval_requested", "pipeline_pr_created",
      "task_failed_retrying", "task_failed_final", "approval_rejected",
      "auth_error", "circuit_breaker_open", "circuit_breaker_closed",
      "rate_limit_approaching", "daily_budget_reached", "classifier_unclear",
    ];
    const notifier = new SlackNotifier("https://hooks.slack.com/test");
    for (const event of events) {
      fetchMock.mockClear();
      await notifier.send(makeNotification({ event }));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });
});
