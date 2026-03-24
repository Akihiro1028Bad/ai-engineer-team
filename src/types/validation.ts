import { z } from "zod";

// === Validation Severity ===

export const ValidationSeveritySchema = z.enum(["error", "warning", "info"]);
export type ValidationSeverity = z.infer<typeof ValidationSeveritySchema>;

// === Validation Check ===

export const ValidationCheckSchema = z.object({
  name: z.string().min(1),
  passed: z.boolean(),
  severity: ValidationSeveritySchema,
  message: z.string(),
  details: z.string().optional(),
});
export type ValidationCheck = z.infer<typeof ValidationCheckSchema>;

// === Validation Result ===

export const ValidationResultSchema = z.object({
  nodeId: z.string().min(1),
  planId: z.string().min(1),
  passed: z.boolean(),
  checks: z.array(ValidationCheckSchema),
  confidence: z.number().min(0).max(1).default(1),
  timestamp: z.string(),
});
export type ValidationResult = z.infer<typeof ValidationResultSchema>;

// === Critic Review (Generator-Critic Loop) ===

export const CriticFindingSchema = z.object({
  severity: z.enum(["critical", "warning", "info"]),
  file: z.string(),
  line: z.number().int().optional(),
  issue: z.string(),
  suggestion: z.string(),
});
export type CriticFinding = z.infer<typeof CriticFindingSchema>;

export const CriticReviewSchema = z.object({
  qualityScore: z.number().int().min(0).max(100),
  verdict: z.enum(["pass", "fail_with_suggestions", "fail_critical"]),
  findings: z.array(CriticFindingSchema),
  summary: z.string(),
  iteration: z.number().int().min(1),
});
export type CriticReview = z.infer<typeof CriticReviewSchema>;
