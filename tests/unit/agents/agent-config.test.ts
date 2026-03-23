import { describe, it, expect } from "vitest";
import { getAgentConfig } from "../../../src/agents/agent-config.js";

describe("getAgentConfig", () => {
  it("Reviewer config has Write tool and system prompt", () => {
    const config = getAgentConfig("reviewer");
    expect(config.allowedTools).toContain("Write");
    expect(config.allowedTools).toContain("Read");
    expect(config.permissionMode).toBe("acceptEdits");
    expect(config.maxTurns).toBe(50);
    expect(config.maxBudgetUsd).toBe(1.0);
    expect(config.systemPrompt).toContain("設計レビュアー");
    expect(config.systemPrompt).toContain("design.md");
    expect(config.systemPrompt).toContain("カバレッジ");
  });

  it("Fixer config has test/lint tools and system prompt", () => {
    const config = getAgentConfig("fixer");
    expect(config.maxTurns).toBe(50);
    expect(config.maxBudgetUsd).toBe(2.0);
    expect(config.permissionMode).toBe("acceptEdits");
    expect(config.allowedTools).toContain("Bash(npm test *)");
    expect(config.systemPrompt).toContain("設計書に従って");
  });

  it("Builder config has npm/git tools and system prompt", () => {
    const config = getAgentConfig("builder");
    expect(config.maxTurns).toBe(50);
    expect(config.maxBudgetUsd).toBe(2.0);
    expect(config.allowedTools).toContain("Bash(git commit *)");
    expect(config.systemPrompt).toContain("設計書に従って");
  });

  it("Scribe config", () => {
    const config = getAgentConfig("scribe");
    expect(config.permissionMode).toBe("acceptEdits");
    expect(config.allowedTools).toContain("Write");
  });

  it("throws for invalid role", () => {
    // @ts-expect-error testing invalid input
    expect(() => getAgentConfig("hacker")).toThrow();
  });
});
