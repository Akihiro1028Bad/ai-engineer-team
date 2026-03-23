import { describe, it, expect } from "vitest";
import { assessRisk } from "../../../src/quality/risk-classifier.js";

describe("assessRisk", () => {
  it("classifies small safe change as low risk", () => {
    const result = assessRisk({
      diffLines: 20,
      changedFiles: ["src/utils.ts"],
    });

    expect(result.level).toBe("low");
    expect(result.requiresCriticLoop).toBe(false);
    expect(result.reasons).toHaveLength(0);
  });

  it("classifies large diff as high risk", () => {
    const result = assessRisk({
      diffLines: 400,
      changedFiles: ["src/app.ts"],
    });

    expect(result.level).toBe("high");
    expect(result.requiresCriticLoop).toBe(true);
  });

  it("classifies medium diff as medium risk", () => {
    const result = assessRisk({
      diffLines: 150,
      changedFiles: ["src/app.ts"],
    });

    expect(result.level).toBe("medium");
    expect(result.requiresCriticLoop).toBe(true);
  });

  it("classifies security file changes as high risk", () => {
    const result = assessRisk({
      diffLines: 10,
      changedFiles: ["src/auth/login.ts"],
    });

    expect(result.level).toBe("high");
    expect(result.requiresCriticLoop).toBe(true);
    expect(result.reasons.some((r) => r.includes("セキュリティ"))).toBe(true);
  });

  it("flags low confidence", () => {
    const result = assessRisk({
      diffLines: 50,
      changedFiles: ["src/utils.ts"],
      confidence: 0.4,
    });

    expect(result.level).toBe("high");
    expect(result.reasons.some((r) => r.includes("低信頼度"))).toBe(true);
  });

  it("flags low quality score", () => {
    const result = assessRisk({
      diffLines: 50,
      changedFiles: ["src/utils.ts"],
      qualityScore: 60,
    });

    expect(result.reasons.some((r) => r.includes("品質スコア"))).toBe(true);
  });

  it("detects multiple security patterns", () => {
    const result = assessRisk({
      diffLines: 30,
      changedFiles: ["src/auth/session.ts", "src/crypto/hash.ts"],
    });

    expect(result.level).toBe("high");
    expect(result.reasons.some((r) => r.includes("session"))).toBe(true);
  });
});
