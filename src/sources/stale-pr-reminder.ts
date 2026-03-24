import type pino from "pino";

import type { SlackNotifier } from "../notifications/slack-notifier.js";

interface OctokitLike {
  pulls: {
    list: (params: {
      owner: string;
      repo: string;
      state: string;
    }) => Promise<{
      data: {
        number: number;
        title: string;
        html_url: string;
        created_at: string;
        updated_at: string;
        labels: { name: string }[];
        user: { login: string } | null;
      }[];
    }>;
  };
  issues: {
    createComment: (params: {
      owner: string;
      repo: string;
      issue_number: number;
      body: string;
    }) => Promise<unknown>;
  };
}

/** リマインダー閾値 */
const REMINDER_24H_MS = 24 * 60 * 60 * 1000;
const REMINDER_72H_MS = 72 * 60 * 60 * 1000;
const REMINDER_7D_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Stale PR リマインダー。
 * - 24h: PR にコメントでリマインド
 * - 72h: PR コメント + Slack 通知
 * - 7d: Slack のみ、クローズ提案
 */
export class StalePRReminder {
  /** 既にリマインド済みの PR (number → 最終リマインド時刻) */
  private readonly reminded = new Map<number, number>();

  constructor(
    private readonly octokit: OctokitLike,
    private readonly slackNotifier: SlackNotifier,
    private readonly owner: string,
    private readonly repo: string,
    private readonly logger: pino.Logger,
  ) {}

  /** オープンな PR をチェックし、Stale なものにリマインドする */
  async checkStalePRs(): Promise<void> {
    try {
      const { data: prs } = await this.octokit.pulls.list({
        owner: this.owner, repo: this.repo, state: "open",
      });

      const now = Date.now();

      for (const pr of prs) {
        // ai-managed ラベルがない PR はスキップ
        if (!pr.labels.some((l) => l.name === "ai-managed")) continue;

        const updatedAt = new Date(pr.updated_at).getTime();
        const staleDuration = now - updatedAt;

        const lastReminded = this.reminded.get(pr.number) ?? 0;
        const sinceLastRemind = now - lastReminded;

        // 重複リマインド防止（最低12時間間隔）
        if (sinceLastRemind < 12 * 60 * 60 * 1000) continue;

        if (staleDuration >= REMINDER_7D_MS) {
          await this.remind7d(pr);
          this.reminded.set(pr.number, now);
        } else if (staleDuration >= REMINDER_72H_MS) {
          await this.remind72h(pr);
          this.reminded.set(pr.number, now);
        } else if (staleDuration >= REMINDER_24H_MS) {
          await this.remind24h(pr);
          this.reminded.set(pr.number, now);
        }
      }
    } catch {
      this.logger.warn("Failed to check stale PRs");
    }
  }

  private async remind24h(pr: { number: number; title: string; html_url: string }): Promise<void> {
    await this.octokit.issues.createComment({
      owner: this.owner, repo: this.repo, issue_number: pr.number,
      body: "👋 **リマインド** — この PR は 24 時間以上レビュー待ちです。確認をお願いします。",
    });
    this.logger.info({ prNumber: pr.number }, "24h stale PR reminder posted");
  }

  private async remind72h(pr: { number: number; title: string; html_url: string }): Promise<void> {
    await this.octokit.issues.createComment({
      owner: this.owner, repo: this.repo, issue_number: pr.number,
      body: "👋 **リマインド** — この PR は 72 時間以上レビュー待ちです。お手すきの際にご確認ください。",
    });

    await this.slackNotifier.send({
      level: "warn",
      event: "stale_pr",
      title: `Stale PR: ${pr.title}`,
      body: `PR #${pr.number} が 72 時間以上レビュー待ちです。`,
      fields: { pr: pr.html_url },
      timestamp: new Date().toISOString(),
    });
    this.logger.info({ prNumber: pr.number }, "72h stale PR reminder posted + Slack notification");
  }

  private async remind7d(pr: { number: number; title: string; html_url: string }): Promise<void> {
    await this.slackNotifier.send({
      level: "warn",
      event: "stale_pr_critical",
      title: `Stale PR (7日以上): ${pr.title}`,
      body: `PR #${pr.number} が 7 日以上放置されています。クローズを検討してください。`,
      fields: { pr: pr.html_url },
      timestamp: new Date().toISOString(),
    });
    this.logger.info({ prNumber: pr.number }, "7d stale PR Slack notification sent");
  }
}
