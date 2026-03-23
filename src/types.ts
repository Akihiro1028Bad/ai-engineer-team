import { z } from "zod";

// === Task Types ===

export const TaskTypeSchema = z.enum(["review", "fix", "build", "document"]);
export type TaskType = z.infer<typeof TaskTypeSchema>;

export const TaskStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "failed",
  "awaiting_approval",
  "ci_checking",
  "ci_passed",
  "ci_fixing",
  "ci_failed",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const AgentRoleSchema = z.enum(["reviewer", "fixer", "builder", "scribe"]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

// === CreateTaskInput ===

export const CreateTaskInputSchema = z.object({
  id: z.string().min(1),
  taskType: TaskTypeSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  source: z.string().min(1),
  priority: z.number().int().min(1).max(10).optional().default(5),
  dependsOn: z.string().nullable().optional().default(null),
  parentTaskId: z.string().nullable().optional().default(null),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

// === Task (full DB model) ===

export const TaskSchema = CreateTaskInputSchema.extend({
  status: TaskStatusSchema.default("pending"),
  result: z.string().nullable().default(null),
  costUsd: z.number().default(0),
  turnsUsed: z.number().int().default(0),
  retryCount: z.number().int().min(0).max(3).default(0),
  contextFile: z.string().nullable().default(null),
  approvalPrUrl: z.string().nullable().default(null),
  prNumber: z.number().int().nullable().default(null),
  ciFixCount: z.number().int().default(0),
  createdAt: z.string(),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
});
export type Task = z.infer<typeof TaskSchema>;

// === Handoff ===

export const HandoffSchema = z.object({
  taskId: z.string().min(1),
  agent: z.string().min(1),
  timestamp: z.string().min(1),
  data: z.record(z.unknown()),
});
export type Handoff = z.infer<typeof HandoffSchema>;

// === Classification ===

export const SubTaskDefSchema = z.object({
  taskType: TaskTypeSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  dependsOnIndex: z.number().int().nullable(),
});
export type SubTaskDef = z.infer<typeof SubTaskDefSchema>;

export const ClassificationSchema = z.discriminatedUnion("complexity", [
  z.object({
    issueId: z.number().int(),
    complexity: z.literal("single"),
    taskType: TaskTypeSchema,
  }),
  z.object({
    issueId: z.number().int(),
    complexity: z.literal("pipeline"),
    subTasks: z.array(SubTaskDefSchema).min(1),
  }),
  z.object({
    issueId: z.number().int(),
    complexity: z.literal("unclear"),
    question: z.string().min(1),
  }),
]);
export type Classification = z.infer<typeof ClassificationSchema>;

// === SlackNotification ===

export const SlackNotificationSchema = z.object({
  level: z.enum(["info", "warn", "error"]),
  event: z.string().min(1),
  title: z.string().min(1),
  body: z.string(),
  fields: z.record(z.string()),
  timestamp: z.string().min(1),
});
export type SlackNotification = z.infer<typeof SlackNotificationSchema>;

// === Agent-specific Handoff Data Schemas ===

const TestResultSchema = z.object({
  passed: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int(),
});

export const ReviewerHandoffDataSchema = z.object({
  findings: z.array(
    z.object({
      severity: z.string(),
      file: z.string(),
      line: z.number().int().optional(),
      issue: z.string(),
      suggestion: z.string().optional(),
    }),
  ),
  summary: z.string(),
});

export const FixerHandoffDataSchema = z.object({
  fixedFiles: z.array(z.string()),
  testResult: TestResultSchema,
  summary: z.string(),
});

export const BuilderHandoffDataSchema = z.object({
  newFiles: z.array(z.string()),
  modifiedFiles: z.array(z.string()),
  testResult: TestResultSchema,
  summary: z.string(),
});

export const ScribeHandoffDataSchema = z.object({
  updatedDocs: z.array(z.string()),
  summary: z.string(),
});

// === AgentConfig ===

export interface AgentConfig {
  readonly role: AgentRole;
  readonly allowedTools: readonly string[];
  readonly permissionMode: "dontAsk" | "acceptEdits";
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly timeoutMs: number;
  readonly model: "opus" | "sonnet" | "haiku";
  readonly systemPrompt: string;
}
