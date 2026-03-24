import type { AgentRole, AgentRoleV3, TaskType, TaskTypeV3 } from "../types.js";

/** v2.1 互換マッピング */
const TASK_TYPE_TO_ROLE: Record<TaskType, AgentRole> = {
  review: "reviewer",
  fix: "fixer",
  build: "builder",
  document: "scribe",
} as const;

export function taskTypeToRole(taskType: TaskType): AgentRole {
  return TASK_TYPE_TO_ROLE[taskType];
}

/** v3.0 DAG ノード用マッピング */
const TASK_TYPE_V3_TO_ROLE: Record<TaskTypeV3, AgentRoleV3> = {
  // v2.1 互換
  review: "reviewer",
  fix: "fixer",
  build: "builder",
  document: "scribe",
  // v3.0 新規
  analyze: "analyzer",
  design: "designer",
  implement: "implementer",
  critique: "critic",
} as const;

export function taskTypeToRoleV3(taskType: TaskTypeV3): AgentRoleV3 {
  return TASK_TYPE_V3_TO_ROLE[taskType];
}
