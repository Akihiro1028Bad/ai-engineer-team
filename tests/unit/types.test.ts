import { describe, it, expect } from "vitest";
import {
  TaskTypeSchema,
  TaskStatusSchema,
  AgentRoleSchema,
  CreateTaskInputSchema,
  HandoffSchema,
  ClassificationSchema,
  SlackNotificationSchema,
} from "../../src/types.js";

describe("TaskTypeSchema", () => {
  it("T-TYP-001: accepts valid task types", () => {
    for (const v of ["review", "fix", "build", "document"]) {
      expect(TaskTypeSchema.safeParse(v).success).toBe(true);
    }
  });

  it("T-TYP-002: rejects invalid task types", () => {
    for (const v of ["deploy", "", null]) {
      expect(TaskTypeSchema.safeParse(v).success).toBe(false);
    }
  });
});

describe("TaskStatusSchema", () => {
  it("T-TYP-003: accepts all valid statuses", () => {
    for (const v of ["pending", "in_progress", "completed", "failed", "awaiting_approval"]) {
      expect(TaskStatusSchema.safeParse(v).success).toBe(true);
    }
  });

  it("T-TYP-004: rejects invalid statuses", () => {
    for (const v of ["cancelled", "unknown"]) {
      expect(TaskStatusSchema.safeParse(v).success).toBe(false);
    }
  });
});

describe("CreateTaskInputSchema", () => {
  const validInput = {
    id: "gh-42-0",
    taskType: "review",
    title: "Test task",
    description: "Test description",
    source: "manual",
  };

  it("T-TYP-005: rejects when required fields are missing", () => {
    for (const field of ["id", "taskType", "title", "description", "source"] as const) {
      const input = { ...validInput };
      delete (input as Record<string, unknown>)[field];
      expect(CreateTaskInputSchema.safeParse(input).success).toBe(false);
    }
  });

  it("T-TYP-006: accepts when optional fields are omitted", () => {
    const result = CreateTaskInputSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it("T-TYP-007: validates priority range 1-10", () => {
    expect(CreateTaskInputSchema.safeParse({ ...validInput, priority: 0 }).success).toBe(false);
    expect(CreateTaskInputSchema.safeParse({ ...validInput, priority: 1 }).success).toBe(true);
    expect(CreateTaskInputSchema.safeParse({ ...validInput, priority: 5 }).success).toBe(true);
    expect(CreateTaskInputSchema.safeParse({ ...validInput, priority: 10 }).success).toBe(true);
    expect(CreateTaskInputSchema.safeParse({ ...validInput, priority: 11 }).success).toBe(false);
  });
});

describe("AgentRoleSchema", () => {
  it("T-TYP-008: accepts all valid roles", () => {
    for (const v of ["reviewer", "fixer", "builder", "scribe"]) {
      expect(AgentRoleSchema.safeParse(v).success).toBe(true);
    }
  });
});

describe("HandoffSchema", () => {
  it("T-TYP-009: validates a valid handoff", () => {
    const result = HandoffSchema.safeParse({
      taskId: "gh-42-0",
      agent: "Reviewer",
      timestamp: "2026-03-22T03:15:00+09:00",
      data: { findings: [], summary: "No issues" },
    });
    expect(result.success).toBe(true);
  });

  it("T-TYP-010: accepts empty data object", () => {
    const result = HandoffSchema.safeParse({
      taskId: "gh-42-0",
      agent: "Reviewer",
      timestamp: "2026-03-22T03:15:00+09:00",
      data: {},
    });
    expect(result.success).toBe(true);
  });
});

describe("ClassificationSchema", () => {
  it("T-TYP-011: validates single classification", () => {
    const result = ClassificationSchema.safeParse({
      issueId: 42,
      complexity: "single",
      taskType: "review",
    });
    expect(result.success).toBe(true);
  });

  it("T-TYP-012: validates pipeline classification", () => {
    const result = ClassificationSchema.safeParse({
      issueId: 50,
      complexity: "pipeline",
      subTasks: [
        { taskType: "review", title: "Review", description: "Review code", dependsOnIndex: null },
        { taskType: "fix", title: "Fix", description: "Fix bugs", dependsOnIndex: 0 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("T-TYP-013: validates unclear classification", () => {
    const result = ClassificationSchema.safeParse({
      issueId: 55,
      complexity: "unclear",
      question: "Could you provide more details?",
    });
    expect(result.success).toBe(true);
  });

  it("T-TYP-014: rejects pipeline with empty subTasks", () => {
    const result = ClassificationSchema.safeParse({
      issueId: 50,
      complexity: "pipeline",
      subTasks: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("SlackNotificationSchema", () => {
  it("T-TYP-015: validates a valid notification", () => {
    const result = SlackNotificationSchema.safeParse({
      level: "info",
      event: "task_completed",
      title: "Task done",
      body: "Details here",
      fields: { taskId: "gh-42" },
      timestamp: "2026-03-22T03:15:00+09:00",
    });
    expect(result.success).toBe(true);
  });

  it("T-TYP-016: rejects invalid level", () => {
    const result = SlackNotificationSchema.safeParse({
      level: "critical",
      event: "test",
      title: "Test",
      body: "Test",
      fields: {},
      timestamp: "2026-03-22T03:15:00+09:00",
    });
    expect(result.success).toBe(false);
  });
});
