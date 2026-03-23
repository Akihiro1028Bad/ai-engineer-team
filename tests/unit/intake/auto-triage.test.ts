import { describe, it, expect, vi } from "vitest";
import { AutoTriage } from "../../../src/intake/auto-triage.js";
import pino from "pino";

const logger = pino({ level: "silent" });

function makeOctokit() {
  return {
    issues: {
      addLabels: vi.fn().mockResolvedValue({}),
    },
  };
}

describe("AutoTriage", () => {
  it("adds size and type labels", async () => {
    const octokit = makeOctokit();
    const triage = new AutoTriage(octokit, "owner", "repo", logger);

    const result = await triage.triage(1, [], ["bug"], "M", "fix");

    expect(result.appliedLabels).toContain("size/M");
    expect(result.appliedLabels).toContain("bug");
    expect(result.appliedLabels).toContain("ai-managed");
    expect(octokit.issues.addLabels).toHaveBeenCalledOnce();
  });

  it("skips size label if already present", async () => {
    const octokit = makeOctokit();
    const triage = new AutoTriage(octokit, "owner", "repo", logger);

    const result = await triage.triage(1, ["size/L"], [], "M", "fix");

    expect(result.appliedLabels).not.toContain("size/M");
  });

  it("calculates priority based on size", async () => {
    const octokit = makeOctokit();
    const triage = new AutoTriage(octokit, "owner", "repo", logger);

    const small = await triage.triage(1, [], [], "S", "fix");
    const large = await triage.triage(2, [], [], "L", "fix");

    expect(small.priority).toBeLessThan(large.priority);
  });

  it("boosts priority for critical labels", async () => {
    const octokit = makeOctokit();
    const triage = new AutoTriage(octokit, "owner", "repo", logger);

    const normal = await triage.triage(1, [], [], "S", "fix");
    const critical = await triage.triage(2, ["security"], [], "S", "fix");

    expect(critical.priority).toBeGreaterThan(normal.priority);
  });

  it("adds feature label for build type", async () => {
    const octokit = makeOctokit();
    const triage = new AutoTriage(octokit, "owner", "repo", logger);

    const result = await triage.triage(1, [], [], "M", "build");

    expect(result.appliedLabels).toContain("feature");
  });

  it("caps priority at 10", async () => {
    const octokit = makeOctokit();
    const triage = new AutoTriage(octokit, "owner", "repo", logger);

    const result = await triage.triage(1, ["security"], [], "XL", "fix");

    expect(result.priority).toBeLessThanOrEqual(10);
  });
});
