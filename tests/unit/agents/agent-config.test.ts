import { describe, it, expect } from "vitest";
import { getAgentConfig } from "../../../src/agents/agent-config.js";

describe("getAgentConfig", () => {
  it("T-AC-001: Reviewer config is correct", () => {
    const config = getAgentConfig("reviewer");
    expect(config.allowedTools).toEqual(["Read", "Glob", "Grep"]);
    expect(config.permissionMode).toBe("dontAsk");
    expect(config.maxTurns).toBe(15);
    expect(config.maxBudgetUsd).toBe(0.5);
    expect(config.timeoutMs).toBe(600_000);
  });

  it("T-AC-002: Fixer config is correct", () => {
    const config = getAgentConfig("fixer");
    expect(config.maxTurns).toBe(30);
    expect(config.maxBudgetUsd).toBe(1.0);
    expect(config.permissionMode).toBe("acceptEdits");
    expect(config.allowedTools).toContain("Bash(npm test *)");
  });

  it("T-AC-003: Builder config is correct", () => {
    const config = getAgentConfig("builder");
    expect(config.maxTurns).toBe(50);
    expect(config.maxBudgetUsd).toBe(2.0);
    expect(config.permissionMode).toBe("acceptEdits");
    expect(config.allowedTools).toContain("Bash(git commit *)");
  });

  it("T-AC-004: Scribe config is correct", () => {
    const config = getAgentConfig("scribe");
    expect(config.permissionMode).toBe("acceptEdits");
    expect(config.maxTurns).toBe(20);
    expect(config.maxBudgetUsd).toBe(0.5);
    expect(config.timeoutMs).toBe(600_000);
  });

  it("T-AC-005: throws for invalid role", () => {
    // @ts-expect-error testing invalid input
    expect(() => getAgentConfig("hacker")).toThrow();
  });

  it("T-AC-006: Reviewer has no Bash tools", () => {
    const config = getAgentConfig("reviewer");
    const bashTools = config.allowedTools.filter((t) => t.startsWith("Bash"));
    expect(bashTools).toHaveLength(0);
  });

  it("T-AC-007: Scribe has no Bash tools", () => {
    const config = getAgentConfig("scribe");
    const bashTools = config.allowedTools.filter((t) => t.startsWith("Bash"));
    expect(bashTools).toHaveLength(0);
  });
});
