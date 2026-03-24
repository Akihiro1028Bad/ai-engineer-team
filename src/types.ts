import { z } from "zod";

// === Task Types ===

/** v2.1 互換: 既存コードが依存するタスクタイプ */
export const TaskTypeSchema = z.enum(["review", "fix", "build", "document"]);
export type TaskType = z.infer<typeof TaskTypeSchema>;

/** v3.0: DAG ノード用の拡張タスクタイプ */
export const TaskTypeV3Schema = z.enum([
  // v2.1 互換
  "review", "fix", "build", "document",
  // v3.0 新規
  "analyze", "design", "implement", "critique",
]);
export type TaskTypeV3 = z.infer<typeof TaskTypeV3Schema>;

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
  // v3.0 新規
  "planning",
  "validating",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** v2.1 互換: 既存の4エージェント */
export const AgentRoleSchema = z.enum(["reviewer", "fixer", "builder", "scribe"]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

/** v3.0: 5コアエージェント + 補助エージェント */
export const AgentRoleV3Schema = z.enum([
  // コアエージェント
  "analyzer", "designer", "implementer", "critic", "scribe",
  // 補助エージェント
  "classifier", "optimizer", "tool_synthesizer",
  // v2.1 互換エイリアス
  "reviewer", "fixer", "builder",
]);
export type AgentRoleV3 = z.infer<typeof AgentRoleV3Schema>;

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
  /** リポジトリ識別子 (owner/repo 形式) */
  repo: z.string().nullable().optional().default(null),
  /** CI修正タスク用: 元PRのブランチ名 */
  contextFile: z.string().nullable().optional().default(null),
});
export type CreateTaskInput = z.input<typeof CreateTaskInputSchema>;

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

/** v3.0: 拡張 AgentConfig（role が V3 ロールに対応） */
export interface AgentConfigV3 {
  readonly role: AgentRoleV3;
  readonly allowedTools: readonly string[];
  readonly permissionMode: "dontAsk" | "acceptEdits";
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly timeoutMs: number;
  readonly model: "opus" | "sonnet" | "haiku";
  readonly systemPrompt: string;
}

// === Multi-Repository Config ===

export const RepoConfigSchema = z.object({
  id: z.string().min(1),
  githubRepo: z.string().regex(/^[^/]+\/[^/]+$/),
  projectDir: z.string().min(1),
  worktreeDir: z.string().min(1),
  enabled: z.boolean().default(true),
  dailyBudgetUsd: z.number().nonnegative().optional(),
  maxConcurrent: z.number().int().positive().default(1),
});
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

// === Re-exports (v3.0 types) ===

export type {
  ExecutionPlan,
  PlanNode,
  RiskLevel,
  ExecutionPlanStatus,
  NodeExecutionState,
  NodeExecutionRecord,
  AnalysisReport,
} from "./types/execution-plan.js";

export type {
  ValidationResult,
  ValidationCheck,
  ValidationSeverity,
  CriticReview,
  CriticFinding,
} from "./types/validation.js";

export type {
  EvalRecord,
  PatternMemory,
  FailurePattern,
  CostEstimate,
  FeedbackLearning,
  FailureCategory,
} from "./types/eval.js";

export type {
  HandoffReport,
  HandoffDecision,
} from "./types/handoff-report.js";
