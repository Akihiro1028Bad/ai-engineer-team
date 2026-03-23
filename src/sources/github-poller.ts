import { Classifier } from "../agents/classifier.js";
import type { TaskQueue } from "../queue/task-queue.js";

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: { name: string }[];
  state: string;
}

interface OctokitLike {
  issues: {
    listForRepo: (params: {
      owner: string;
      repo: string;
      labels: string;
      state: string;
    }) => Promise<{ data: GitHubIssue[] }>;
    createComment: (params: {
      owner: string;
      repo: string;
      issue_number: number;
      body: string;
    }) => Promise<unknown>;
  };
  pulls: {
    listReviews: (params: {
      owner: string;
      repo: string;
      pull_number: number;
    }) => Promise<{ data: { state: string }[] }>;
    get: (params: {
      owner: string;
      repo: string;
      pull_number: number;
    }) => Promise<{ data: { state: string; merged: boolean } }>;
  };
}

export class GitHubPoller {
  private readonly classifier: Classifier;

  constructor(
    private readonly octokit: OctokitLike,
    private readonly queue: TaskQueue,
    private readonly owner: string,
    private readonly repo: string,
  ) {
    this.classifier = new Classifier(octokit, owner, repo);
  }

  async pollIssues(): Promise<void> {
    try {
      const { data: issues } = await this.octokit.issues.listForRepo({
        owner: this.owner,
        repo: this.repo,
        labels: "ai-task",
        state: "open",
      });

      for (const issue of issues) {
        const hasAiTask = issue.labels.some((l) => l.name === "ai-task");
        if (!hasAiTask) continue;

        const source = `github_issue:${issue.number}`;
        if (this.queue.isDuplicate(source)) continue;

        const labels = issue.labels.map((l) => l.name);
        const classification = await this.classifier.classify({
          number: issue.number,
          title: issue.title,
          body: issue.body ?? "",
          labels,
        });

        if (classification.complexity === "single") {
          this.queue.push({
            id: `gh-${issue.number}-0`,
            taskType: classification.taskType,
            title: issue.title,
            description: issue.body ?? issue.title,
            source,
            priority: 5,
            dependsOn: null,
            parentTaskId: null,
          });
        } else if (classification.complexity === "pipeline") {
          const tasks = classification.subTasks.map((sub, i) => ({
            id: `gh-${issue.number}-${i}`,
            taskType: sub.taskType,
            title: sub.title,
            description: sub.description,
            source: i === 0 ? source : `${source}:${i}`,
            priority: 5,
            dependsOn: sub.dependsOnIndex !== null ? `gh-${issue.number}-${sub.dependsOnIndex}` : null,
            parentTaskId: `gh-${issue.number}-0`,
          }));
          this.queue.pushPipeline(tasks);
        }
        // unclear → comment already posted by classifier
      }
    } catch {
      // GitHub API errors are logged but not thrown (FR-001a)
    }
  }

  async pollApprovals(): Promise<void> {
    const awaiting = this.queue.getAwaitingApproval();
    if (awaiting.length === 0) return;

    for (const task of awaiting) {
      if (!task.approvalPrUrl) continue;

      try {
        const prNumber = this.extractPrNumber(task.approvalPrUrl);
        if (!prNumber) continue;

        // Check if PR is closed
        const { data: pr } = await this.octokit.pulls.get({
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
        });

        if (pr.state === "closed" && !pr.merged) {
          this.queue.rejectTask(task.id);
          continue;
        }

        // Check reviews
        const { data: reviews } = await this.octokit.pulls.listReviews({
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
        });

        const approved = reviews.some((r) => r.state === "APPROVED");
        if (approved) {
          this.queue.approveTask(task.id);
        }
      } catch {
        // PR API errors are logged but not thrown
      }
    }
  }

  private extractPrNumber(url: string): number | null {
    const match = /\/pull\/(\d+)/.exec(url);
    return match ? Number(match[1]) : null;
  }
}
