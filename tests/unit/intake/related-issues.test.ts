import { describe, it, expect, vi } from "vitest";
import { RelatedIssueDetector } from "../../../src/intake/related-issues.js";
import pino from "pino";

const logger = pino({ level: "silent" });

function makeOctokit(issues: { number: number; title: string; body: string | null }[]) {
  return {
    paginate: vi.fn().mockResolvedValue(
      issues.map((i) => ({ ...i, labels: [] })),
    ),
    issues: {
      listForRepo: vi.fn().mockResolvedValue({
        data: issues.map((i) => ({ ...i, labels: [] })),
      }),
      createComment: vi.fn().mockResolvedValue({}),
    },
  };
}

describe("RelatedIssueDetector", () => {
  it("finds related issues by keyword similarity", async () => {
    const octokit = makeOctokit([
      { number: 1, title: "Fix login button broken", body: "The login button does not work" },
      { number: 2, title: "Login page CSS issue", body: "Login page style is broken" },
      { number: 3, title: "Database migration script", body: "Add migration for users table" },
    ]);

    const detector = new RelatedIssueDetector(octokit, "owner", "repo", logger);
    const related = await detector.findRelated(10, "Login button not working", "Login button click does nothing");

    // Should find issue #1 and #2 as related (login keyword overlap)
    expect(related.length).toBeGreaterThan(0);
    const relatedNumbers = related.map((r) => r.number);
    expect(relatedNumbers).toContain(1);
  });

  it("excludes the source issue itself", async () => {
    const octokit = makeOctokit([
      { number: 5, title: "Same issue title", body: "Same body content" },
    ]);

    const detector = new RelatedIssueDetector(octokit, "owner", "repo", logger);
    const related = await detector.findRelated(5, "Same issue title", "Same body content");

    expect(related.every((r) => r.number !== 5)).toBe(true);
  });

  it("returns empty for unrelated issues", async () => {
    const octokit = makeOctokit([
      { number: 1, title: "完全に無関係な話題", body: "天気予報について" },
    ]);

    const detector = new RelatedIssueDetector(octokit, "owner", "repo", logger);
    const related = await detector.findRelated(10, "API endpoint returns 500", "Server error on /api/users");

    expect(related).toHaveLength(0);
  });

  it("posts related comment", async () => {
    const octokit = makeOctokit([]);
    const detector = new RelatedIssueDetector(octokit, "owner", "repo", logger);

    await detector.postRelatedComment(10, [
      { number: 1, title: "Related issue", similarity: 0.6, relationship: "related" },
    ]);

    expect(octokit.issues.createComment).toHaveBeenCalledOnce();
  });

  it("does not post comment for empty related list", async () => {
    const octokit = makeOctokit([]);
    const detector = new RelatedIssueDetector(octokit, "owner", "repo", logger);

    await detector.postRelatedComment(10, []);

    expect(octokit.issues.createComment).not.toHaveBeenCalled();
  });

  it("limits results to max 5", async () => {
    const issues = Array.from({ length: 20 }, (_, i) => ({
      number: i + 1,
      title: "Login button issue variant " + String(i),
      body: "The login button has a problem " + String(i),
    }));
    const octokit = makeOctokit(issues);

    const detector = new RelatedIssueDetector(octokit, "owner", "repo", logger);
    const related = await detector.findRelated(100, "Login button problem", "Login button broken");

    expect(related.length).toBeLessThanOrEqual(5);
  });
});
