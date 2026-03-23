import type { AgentConfig, AgentRole } from "../types.js";

const AGENT_CONFIGS = {
  reviewer: {
    role: "reviewer" as const,
    allowedTools: ["Read", "Glob", "Grep"],
    permissionMode: "dontAsk" as const,
    maxTurns: 30,
    maxBudgetUsd: 1.0,
    timeoutMs: 600_000,
    model: "sonnet" as const,
    systemPrompt: "",
  },
  fixer: {
    role: "fixer" as const,
    allowedTools: [
      "Read", "Edit", "Glob", "Grep",
      "Bash(npm test *)", "Bash(npx jest *)", "Bash(npx vitest *)",
      "Bash(git diff *)", "Bash(git status *)",
    ],
    permissionMode: "acceptEdits" as const,
    maxTurns: 30,
    maxBudgetUsd: 1.0,
    timeoutMs: 1_800_000,
    model: "sonnet" as const,
    systemPrompt: "",
  },
  builder: {
    role: "builder" as const,
    allowedTools: [
      "Read", "Edit", "Glob", "Grep",
      "Bash(npm *)", "Bash(npx *)",
      "Bash(git diff *)", "Bash(git status *)",
      "Bash(git add *)", "Bash(git commit *)",
    ],
    permissionMode: "acceptEdits" as const,
    maxTurns: 50,
    maxBudgetUsd: 2.0,
    timeoutMs: 2_400_000,
    model: "sonnet" as const,
    systemPrompt: "",
  },
  scribe: {
    role: "scribe" as const,
    allowedTools: ["Read", "Edit", "Glob", "Grep"],
    permissionMode: "acceptEdits" as const,
    maxTurns: 20,
    maxBudgetUsd: 0.5,
    timeoutMs: 600_000,
    model: "sonnet" as const,
    systemPrompt: "",
  },
} as const satisfies Record<AgentRole, AgentConfig>;

export function getAgentConfig(role: AgentRole): AgentConfig {
  const config = AGENT_CONFIGS[role];
  if (!config) {
    throw new Error(`Unknown agent role: ${String(role)}`);
  }
  return config;
}
