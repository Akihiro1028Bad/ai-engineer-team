import { z } from "zod";

import { AgentRoleV3Schema } from "../types.js";

// === Handoff Report (structured inter-agent communication) ===

export const HandoffDecisionSchema = z.object({
  decision: z.string(),
  reasoning: z.string(),
  alternatives: z.array(z.string()).default([]),
});
export type HandoffDecision = z.infer<typeof HandoffDecisionSchema>;

export const HandoffReportSchema = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  fromNodeId: z.string().min(1),
  toNodeId: z.string().min(1),
  fromAgent: AgentRoleV3Schema,
  toAgent: AgentRoleV3Schema,
  summary: z.string().min(1),
  decisions: z.array(HandoffDecisionSchema).default([]),
  artifacts: z.array(z.object({
    type: z.enum(["file", "design_doc", "test_result", "analysis"]),
    path: z.string().optional(),
    content: z.string().optional(),
  })).default([]),
  warnings: z.array(z.string()).default([]),
  timestamp: z.string(),
});
export type HandoffReport = z.infer<typeof HandoffReportSchema>;
