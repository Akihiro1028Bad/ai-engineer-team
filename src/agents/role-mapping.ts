import type { AgentRole, TaskType } from "../types.js";

const TASK_TYPE_TO_ROLE: Record<TaskType, AgentRole> = {
  review: "reviewer",
  fix: "fixer",
  build: "builder",
  document: "scribe",
} as const;

export function taskTypeToRole(taskType: TaskType): AgentRole {
  return TASK_TYPE_TO_ROLE[taskType];
}
