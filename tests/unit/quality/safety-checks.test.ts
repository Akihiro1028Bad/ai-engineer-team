import { describe, it, expect } from "vitest";
import { runSafetyChecks } from "../../../src/quality/safety-checks.js";

describe("runSafetyChecks", () => {
  it("passes clean diff", () => {
    const checks = runSafetyChecks({
      diff: "+ const x = 1;\n- const y = 2;",
      diffLines: 2,
      deletedFiles: [],
    });

    const errors = checks.filter((c) => !c.passed && c.severity === "error");
    expect(errors).toHaveLength(0);
  });

  it("detects API key in diff", () => {
    const checks = runSafetyChecks({
      diff: '+ ANTHROPIC_API_KEY = "sk-ant-1234"',
      diffLines: 1,
      deletedFiles: [],
    });

    const leaked = checks.find((c) => c.name.includes("秘密情報"));
    expect(leaked).toBeDefined();
    if (leaked) { expect(leaked.passed).toBe(false); }
  });

  it("detects private key in diff", () => {
    const checks = runSafetyChecks({
      diff: "+ -----BEGIN RSA PRIVATE KEY-----",
      diffLines: 1,
      deletedFiles: [],
    });

    const leaked = checks.find((c) => c.name.includes("秘密鍵"));
    expect(leaked).toBeDefined();
    if (leaked) { expect(leaked.passed).toBe(false); }
  });

  it("detects protected file deletion", () => {
    const checks = runSafetyChecks({
      diff: "",
      diffLines: 0,
      deletedFiles: [".github/workflows/ci.yml"],
    });

    const deleted = checks.find((c) => c.name.includes("protected_file_deletion"));
    expect(deleted).toBeDefined();
    if (deleted) { expect(deleted.passed).toBe(false); }
  });

  it("detects diff size over limit", () => {
    const checks = runSafetyChecks({
      diff: "",
      diffLines: 600,
      deletedFiles: [],
    });

    const sizeCheck = checks.find((c) => c.name === "diff_size_per_node");
    expect(sizeCheck).toBeDefined();
    if (sizeCheck) { expect(sizeCheck.passed).toBe(false); }
  });

  it("passes diff within size limit", () => {
    const checks = runSafetyChecks({
      diff: "",
      diffLines: 100,
      deletedFiles: [],
    });

    const sizeCheck = checks.find((c) => c.name === "diff_size_per_node");
    if (sizeCheck) { expect(sizeCheck.passed).toBe(true); }
  });

  it("checks PR total diff size", () => {
    const checks = runSafetyChecks({
      diff: "",
      diffLines: 100,
      deletedFiles: [],
      totalPrDiffLines: 1200,
    });

    const prCheck = checks.find((c) => c.name === "diff_size_per_pr");
    expect(prCheck).toBeDefined();
    if (prCheck) { expect(prCheck.passed).toBe(false); }
  });

  it("detects binary files", () => {
    const checks = runSafetyChecks({
      diff: "Binary files a/image.png and b/image.png differ",
      diffLines: 1,
      deletedFiles: [],
    });

    const binaryCheck = checks.find((c) => c.name === "binary_file_detection");
    if (binaryCheck) { expect(binaryCheck.passed).toBe(false); }
  });

  it("allows non-protected file deletion", () => {
    const checks = runSafetyChecks({
      diff: "",
      diffLines: 0,
      deletedFiles: ["src/old-file.ts"],
    });

    const deletionChecks = checks.filter((c) => c.name.includes("protected_file_deletion"));
    expect(deletionChecks).toHaveLength(0);
  });
});
