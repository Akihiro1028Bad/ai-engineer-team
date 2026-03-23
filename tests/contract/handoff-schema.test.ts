import { describe, it, expect } from "vitest";
import {
  HandoffSchema,
  ClassificationSchema,
  SlackNotificationSchema,
  ReviewerHandoffDataSchema,
  FixerHandoffDataSchema,
  BuilderHandoffDataSchema,
  ScribeHandoffDataSchema,
} from "../../src/types.js";

describe("Contract: Handoff schemas", () => {
  it("T-CTR-001: Reviewer handoff data", () => {
    const result = ReviewerHandoffDataSchema.safeParse({
      findings: [{ severity: "critical", file: "src/auth.ts", line: 42, issue: "SQL injection", suggestion: "Use parameterized queries" }],
      summary: "1 critical issue found",
    });
    expect(result.success).toBe(true);
  });

  it("T-CTR-002: Fixer handoff data", () => {
    const result = FixerHandoffDataSchema.safeParse({
      fixedFiles: ["src/auth.ts"],
      testResult: { passed: 10, failed: 0, skipped: 0 },
      summary: "Fixed email validation bug",
    });
    expect(result.success).toBe(true);
  });

  it("T-CTR-003: Builder handoff data", () => {
    const result = BuilderHandoffDataSchema.safeParse({
      newFiles: ["src/payment.ts"],
      modifiedFiles: ["src/routes.ts"],
      testResult: { passed: 15, failed: 0, skipped: 1 },
      summary: "Implemented payment module",
    });
    expect(result.success).toBe(true);
  });

  it("T-CTR-004: Scribe handoff data", () => {
    const result = ScribeHandoffDataSchema.safeParse({
      updatedDocs: ["README.md", "docs/api.md"],
      summary: "Updated API documentation",
    });
    expect(result.success).toBe(true);
  });

  it("T-CTR-005: All 12 Slack events validate", () => {
    const events = [
      { level: "info", event: "task_completed", title: "T", body: "B", fields: {}, timestamp: "2026-03-22T00:00:00Z" },
      { level: "info", event: "approval_requested", title: "T", body: "B", fields: { prUrl: "url" }, timestamp: "2026-03-22T00:00:00Z" },
      { level: "info", event: "pipeline_pr_created", title: "T", body: "B", fields: {}, timestamp: "2026-03-22T00:00:00Z" },
      { level: "warn", event: "task_failed_retrying", title: "T", body: "B", fields: {}, timestamp: "2026-03-22T00:00:00Z" },
      { level: "error", event: "task_failed_final", title: "T", body: "B", fields: {}, timestamp: "2026-03-22T00:00:00Z" },
      { level: "warn", event: "approval_rejected", title: "T", body: "B", fields: {}, timestamp: "2026-03-22T00:00:00Z" },
      { level: "error", event: "auth_error", title: "T", body: "B", fields: {}, timestamp: "2026-03-22T00:00:00Z" },
      { level: "error", event: "circuit_breaker_open", title: "T", body: "B", fields: {}, timestamp: "2026-03-22T00:00:00Z" },
      { level: "info", event: "circuit_breaker_closed", title: "T", body: "B", fields: {}, timestamp: "2026-03-22T00:00:00Z" },
      { level: "warn", event: "rate_limit_approaching", title: "T", body: "B", fields: {}, timestamp: "2026-03-22T00:00:00Z" },
      { level: "error", event: "daily_budget_reached", title: "T", body: "B", fields: {}, timestamp: "2026-03-22T00:00:00Z" },
      { level: "info", event: "classifier_unclear", title: "T", body: "B", fields: {}, timestamp: "2026-03-22T00:00:00Z" },
    ];
    for (const evt of events) {
      expect(SlackNotificationSchema.safeParse(evt).success).toBe(true);
    }
  });

  it("T-CTR-006: Classification single response", () => {
    const result = ClassificationSchema.safeParse({
      issueId: 42,
      complexity: "single",
      taskType: "fix",
    });
    expect(result.success).toBe(true);
  });

  it("T-CTR-007: Classification pipeline response", () => {
    const result = ClassificationSchema.safeParse({
      issueId: 50,
      complexity: "pipeline",
      subTasks: [
        { taskType: "review", title: "Review", description: "D", dependsOnIndex: null },
        { taskType: "build", title: "Build", description: "D", dependsOnIndex: 0 },
      ],
    });
    expect(result.success).toBe(true);
  });
});
