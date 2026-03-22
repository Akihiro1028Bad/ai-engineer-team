import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadConfig } from "../../../src/config/env-config.js";

const baseMaxPlan = {
  RATE_CONTROL_ENABLED: "true",
  RATE_COOLDOWN_SECONDS: "60",
  GITHUB_TOKEN: "ghp_test123",
  GITHUB_REPO: "org/repo",
  PROJECT_DIR: "/home/user/project",
  WORKTREE_DIR: "/home/user/worktrees",
  MAX_CONCURRENT: "1",
};

const baseApiPlan = {
  ANTHROPIC_API_KEY: "sk-ant-test",
  RATE_CONTROL_ENABLED: "false",
  GITHUB_TOKEN: "ghp_test123",
  GITHUB_REPO: "org/repo",
  PROJECT_DIR: "/home/user/project",
  WORKTREE_DIR: "/home/user/worktrees",
  DAILY_BUDGET_USD: "10.0",
  MAX_CONCURRENT: "2",
};

describe("loadConfig", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  function setEnv(vars: Record<string, string>): void {
    for (const [k, v] of Object.entries(vars)) {
      vi.stubEnv(k, v);
    }
  }

  it("T-ENV-001: succeeds with all required Max plan vars", () => {
    setEnv(baseMaxPlan);
    const result = loadConfig();
    expect(result.success).toBe(true);
  });

  it("T-ENV-002: succeeds with all required API plan vars", () => {
    setEnv(baseApiPlan);
    const result = loadConfig();
    expect(result.success).toBe(true);
  });

  it("T-ENV-003: fails when GITHUB_TOKEN is missing", () => {
    const { GITHUB_TOKEN: _, ...vars } = baseMaxPlan;
    setEnv(vars);
    const result = loadConfig();
    expect(result.success).toBe(false);
  });

  it("T-ENV-004: fails when PROJECT_DIR is missing", () => {
    const { PROJECT_DIR: _, ...vars } = baseMaxPlan;
    setEnv(vars);
    const result = loadConfig();
    expect(result.success).toBe(false);
  });

  it("T-ENV-005: fails when WORKTREE_DIR is missing", () => {
    const { WORKTREE_DIR: _, ...vars } = baseMaxPlan;
    setEnv(vars);
    const result = loadConfig();
    expect(result.success).toBe(false);
  });

  it("T-ENV-006: fails when GITHUB_REPO is missing", () => {
    const { GITHUB_REPO: _, ...vars } = baseMaxPlan;
    setEnv(vars);
    const result = loadConfig();
    expect(result.success).toBe(false);
  });

  it("T-ENV-007: fails when both ANTHROPIC_API_KEY and RATE_CONTROL_ENABLED=true", () => {
    setEnv({ ...baseMaxPlan, ANTHROPIC_API_KEY: "sk-ant-test" });
    const result = loadConfig();
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("ANTHROPIC_API_KEY");
    }
  });

  it("T-ENV-008: fails when DAILY_BUDGET_USD is negative", () => {
    setEnv({ ...baseApiPlan, DAILY_BUDGET_USD: "-5.0" });
    const result = loadConfig();
    expect(result.success).toBe(false);
  });

  it("T-ENV-009: fails when MAX_CONCURRENT is 0", () => {
    setEnv({ ...baseMaxPlan, MAX_CONCURRENT: "0" });
    const result = loadConfig();
    expect(result.success).toBe(false);
  });

  it("T-ENV-010: defaults MAX_CONCURRENT to 1", () => {
    const { MAX_CONCURRENT: _, ...vars } = baseMaxPlan;
    setEnv(vars);
    const result = loadConfig();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxConcurrent).toBe(1);
    }
  });

  it("T-ENV-011: defaults RATE_COOLDOWN_SECONDS to 60", () => {
    const { RATE_COOLDOWN_SECONDS: _, ...vars } = baseMaxPlan;
    setEnv(vars);
    const result = loadConfig();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rateCooldownSeconds).toBe(60);
    }
  });

  it("T-ENV-012: succeeds when SLACK_WEBHOOK_URL is missing", () => {
    setEnv(baseMaxPlan);
    const result = loadConfig();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.slackWebhookUrl).toBeUndefined();
    }
  });

  it("T-ENV-013: fails when SLACK_WEBHOOK_URL is invalid", () => {
    setEnv({ ...baseMaxPlan, SLACK_WEBHOOK_URL: "not-a-url" });
    const result = loadConfig();
    expect(result.success).toBe(false);
  });

  it("T-ENV-014: fails when GITHUB_REPO has invalid format", () => {
    setEnv({ ...baseMaxPlan, GITHUB_REPO: "invalid" });
    const result = loadConfig();
    expect(result.success).toBe(false);
  });

  it("T-ENV-015: defaults MAX_TASKS_PER_WINDOW to 150", () => {
    setEnv(baseMaxPlan);
    const result = loadConfig();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxTasksPerWindow).toBe(150);
    }
  });

  it("T-ENV-016: defaults RATE_LIMIT_WARN_THRESHOLD to 0.1", () => {
    setEnv(baseMaxPlan);
    const result = loadConfig();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rateLimitWarnThreshold).toBe(0.1);
    }
  });
});
