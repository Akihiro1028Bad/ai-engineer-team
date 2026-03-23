import { z } from "zod";

import { AgentRoleV3Schema } from "../types.js";

// === Eval Record ===

export const FailureCategorySchema = z.enum([
  "timeout",
  "budget_exceeded",
  "quality_below_threshold",
  "crash",
  "validation_failed",
  "ci_failed",
  "manual_reject",
  "unknown",
]);
export type FailureCategory = z.infer<typeof FailureCategorySchema>;

export const EvalRecordSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  planId: z.string().optional(),
  nodeId: z.string().optional(),
  repo: z.string().optional(),
  agentRole: AgentRoleV3Schema,
  model: z.enum(["haiku", "sonnet", "opus"]),
  costUsd: z.number().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  turnsUsed: z.number().int().nonnegative(),
  success: z.boolean(),
  qualityScore: z.number().min(0).max(100).optional(),
  diffLines: z.number().int().nonnegative().optional(),
  fileCount: z.number().int().nonnegative().optional(),
  failureCategory: FailureCategorySchema.optional(),
  issueLabels: z.array(z.string()).default([]),
  createdAt: z.string(),
});
export type EvalRecord = z.infer<typeof EvalRecordSchema>;

// === Pattern Memory ===

export const PatternMemorySchema = z.object({
  id: z.string().min(1),
  repo: z.string().optional(),
  agentRole: AgentRoleV3Schema,
  model: z.enum(["haiku", "sonnet", "opus"]),
  taskType: z.string(),
  successRate: z.number().min(0).max(1),
  avgCostUsd: z.number().nonnegative(),
  avgDurationMs: z.number().nonnegative(),
  avgQualityScore: z.number().min(0).max(100).optional(),
  sampleCount: z.number().int().nonnegative(),
  updatedAt: z.string(),
});
export type PatternMemory = z.infer<typeof PatternMemorySchema>;

// === Failure Pattern ===

export const FailurePatternSchema = z.object({
  id: z.string().min(1),
  description: z.string(),
  mitigation: z.string(),
  occurrences: z.number().int().nonnegative(),
  lastOccurredAt: z.string(),
});
export type FailurePattern = z.infer<typeof FailurePatternSchema>;

// === Cost Estimate ===

export const CostEstimateSchema = z.object({
  patternKey: z.string(),
  predictedCostUsd: z.number().nonnegative(),
  actualAvgUsd: z.number().nonnegative(),
  accuracy: z.number().min(0).max(1),
  sampleCount: z.number().int().nonnegative(),
});
export type CostEstimate = z.infer<typeof CostEstimateSchema>;

// === Feedback Learning ===

export const FeedbackLearningSchema = z.object({
  id: z.string().min(1),
  repo: z.string().optional(),
  prNumber: z.number().int(),
  feedbackType: z.enum(["style", "logic", "design", "naming", "testing", "other"]),
  feedbackContent: z.string(),
  agentRole: AgentRoleV3Schema,
  resolution: z.enum(["applied", "rejected", "partial"]),
  createdAt: z.string(),
});
export type FeedbackLearning = z.infer<typeof FeedbackLearningSchema>;
