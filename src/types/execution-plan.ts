import { z } from "zod";

import { AgentRoleV3Schema } from "../types.js";

// === DAG Node ===

export const PlanNodeSchema = z.object({
  id: z.string().min(1),
  agentRole: AgentRoleV3Schema,
  prompt: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  validationRule: z.string().optional(),
  model: z.enum(["haiku", "sonnet", "opus"]),
  estimatedCostUsd: z.number().nonnegative(),
  estimatedDurationMs: z.number().int().nonnegative().optional(),
  requiresCriticLoop: z.boolean().default(false),
  maxRetries: z.number().int().min(0).max(3).default(1),
});
export type PlanNode = z.infer<typeof PlanNodeSchema>;

// === Execution Plan (DAG) ===

export const RiskLevelSchema = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const ExecutionPlanSchema = z.object({
  taskId: z.string().min(1),
  issueNumber: z.number().int().optional(),
  nodes: z.array(PlanNodeSchema).min(1),
  criticalPath: z.array(z.string()).default([]),
  totalEstimatedCostUsd: z.number().nonnegative(),
  totalEstimatedDurationMs: z.number().int().nonnegative().optional(),
  riskLevel: RiskLevelSchema,
  rationale: z.string().min(1),
  createdAt: z.string(),
});
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;

// === Execution Plan Status ===

export const ExecutionPlanStatusSchema = z.enum([
  "draft",
  "dry_run",
  "approved",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type ExecutionPlanStatus = z.infer<typeof ExecutionPlanStatusSchema>;

// === DAG Node Execution State ===

export const NodeExecutionStateSchema = z.enum([
  "pending",
  "ready",
  "running",
  "completed",
  "failed",
  "skipped",
]);
export type NodeExecutionState = z.infer<typeof NodeExecutionStateSchema>;

export const NodeExecutionRecordSchema = z.object({
  nodeId: z.string().min(1),
  planId: z.string().min(1),
  state: NodeExecutionStateSchema,
  agentRole: AgentRoleV3Schema,
  model: z.enum(["haiku", "sonnet", "opus"]),
  costUsd: z.number().nonnegative().default(0),
  turnsUsed: z.number().int().default(0),
  durationMs: z.number().int().default(0),
  criticIterations: z.number().int().default(0),
  qualityScore: z.number().min(0).max(100).optional(),
  error: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
});
export type NodeExecutionRecord = z.infer<typeof NodeExecutionRecordSchema>;

// === Analysis Report (Analyzer Agent output) ===

export const AnalysisReportSchema = z.object({
  affectedFiles: z.array(z.object({
    path: z.string(),
    changeType: z.enum(["create", "modify", "delete"]),
    complexity: z.enum(["low", "medium", "high"]),
  })),
  dependencies: z.array(z.string()).default([]),
  risks: z.array(z.object({
    description: z.string(),
    severity: z.enum(["low", "medium", "high"]),
    mitigation: z.string().optional(),
  })).default([]),
  testCoverage: z.object({
    hasTests: z.boolean(),
    relevantTestFiles: z.array(z.string()).default([]),
  }).optional(),
  estimatedComplexity: z.enum(["trivial", "small", "medium", "large"]),
  summary: z.string(),
});
export type AnalysisReport = z.infer<typeof AnalysisReportSchema>;
