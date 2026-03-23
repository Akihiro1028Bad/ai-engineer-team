import type { TaskQueue } from "./queue/task-queue.js";
import type { Dispatcher } from "./agents/dispatcher.js";
import { getAgentConfig } from "./agents/agent-config.js";
import { taskTypeToRole } from "./agents/role-mapping.js";
import type { CronScheduler } from "./sources/cron-scheduler.js";
import type { GitHubPoller } from "./sources/github-poller.js";
import type { ResultCollector } from "./bridges/result-collector.js";
import type { CIMonitor } from "./sources/ci-monitor.js";
import type { StalePRReminder } from "./sources/stale-pr-reminder.js";
import type { CircuitBreaker } from "./safety/circuit-breaker.js";
import type { RateController } from "./safety/rate-controller.js";
import type { BudgetGuard } from "./safety/budget-guard.js";
import type { SlackNotifier } from "./notifications/slack-notifier.js";
import type { StatusEmitter } from "./execution/status-emitter.js";
import type { HandoffStore } from "./execution/handoff-store.js";
import type { EvalStore } from "./feedback/eval-store.js";
import type { PatternMemoryStore } from "./feedback/pattern-memory.js";
import type { ModelRouter } from "./feedback/model-router.js";
import type { PRFeedbackLearner } from "./feedback/pr-feedback-learner.js";
import type { ValidationGate } from "./quality/validation-gate.js";
import type { SkillRegistry } from "./toolforge/skill-registry.js";
import type pino from "pino";
import type { AgentConfig, TaskType } from "./types.js";

/** リポジトリごとのコンポーネント参照 */
export interface RepoRef {
  repoId: string;
  githubPoller: GitHubPoller;
  resultCollector: ResultCollector;
  ciMonitor: CIMonitor;
  stalePRReminder: StalePRReminder;
  dispatcher: Dispatcher;
}

export interface OrchestratorDeps {
  queue: TaskQueue;
  dispatcher: Dispatcher;
  cronScheduler: CronScheduler;
  githubPoller?: GitHubPoller;
  resultCollector?: ResultCollector;
  ciMonitor?: CIMonitor;
  circuitBreaker: CircuitBreaker;
  rateController: RateController;
  budgetGuard: BudgetGuard;
  slackNotifier: SlackNotifier;
  logger: pino.Logger;
  pollIntervalMs?: number;
  maxConcurrent?: number;
  // v3.0 新規（optional で後方互換維持）
  statusEmitter?: StatusEmitter;
  handoffStore?: HandoffStore;
  evalStore?: EvalStore;
  patternMemory?: PatternMemoryStore;
  modelRouter?: ModelRouter;
  feedbackLearner?: PRFeedbackLearner;
  validationGate?: ValidationGate;
  skillRegistry?: SkillRegistry;
  repoComponents?: RepoRef[];
  dryRunDefault?: boolean;
}

/** Pattern Memory 更新間隔（100 タスク実行ごと） */
const PATTERN_UPDATE_INTERVAL = 100;
/** Stale PR チェック間隔（10 tick ごと = 約5分） */
const STALE_PR_CHECK_INTERVAL = 10;

export class Orchestrator {
  private running = false;
  private activeTasks = 0;
  private tasksSincePatternUpdate = 0;
  private tickCount = 0;

  constructor(private readonly deps: OrchestratorDeps) {}

  async start(): Promise<void> {
    this.running = true;
    const { queue, logger } = this.deps;

    queue.recoverFromCrash();
    logger.info("Crash recovery complete");

    while (this.running) {
      try {
        await this.tick();
      } catch (error: unknown) {
        this.deps.logger.error({ error }, "Orchestrator tick error");
      }

      await this.sleep(this.deps.pollIntervalMs ?? 5_000);
    }

    while (this.activeTasks > 0) {
      await this.sleep(1_000);
    }

    logger.info("Orchestrator stopped gracefully");
  }

  async tick(): Promise<void> {
    const { queue, cronScheduler, circuitBreaker, rateController, budgetGuard, logger } = this.deps;
    const maxConcurrent = this.deps.maxConcurrent ?? 1;

    this.tickCount++;

    cronScheduler.checkAndCreateTasks(new Date());

    // マルチリポ対応: 全リポジトリの GitHub をポーリング
    if (this.deps.repoComponents && this.deps.repoComponents.length > 0) {
      for (const repo of this.deps.repoComponents) {
        try {
          await repo.githubPoller.pollIssues();
          await repo.githubPoller.pollApprovals();
        } catch (error: unknown) {
          logger.warn({ repoId: repo.repoId, error }, "Repo polling error");
        }

        // CI 監視
        try {
          await repo.ciMonitor.checkPendingPRs();
        } catch (error: unknown) {
          logger.warn({ repoId: repo.repoId, error }, "Repo CI monitor error");
        }

        // Stale PR リマインダー（低頻度）
        if (this.tickCount % STALE_PR_CHECK_INTERVAL === 0) {
          try {
            await repo.stalePRReminder.checkStalePRs();
          } catch { /* non-critical */ }
        }
      }
    } else {
      // 後方互換: 単一リポジトリモード
      if (this.deps.githubPoller) {
        await this.deps.githubPoller.pollIssues();
        await this.deps.githubPoller.pollApprovals();
      }
      if (this.deps.ciMonitor) {
        await this.deps.ciMonitor.checkPendingPRs();
      }
    }

    budgetGuard.checkDailyReset();

    if (!circuitBreaker.canExecute()) {
      logger.warn("Circuit breaker OPEN — skipping dispatch");
      return;
    }

    if (!budgetGuard.canExecute()) {
      logger.warn("Daily budget exceeded — skipping dispatch");
      return;
    }

    while (this.activeTasks < maxConcurrent) {
      const task = queue.getNext();
      if (!task) break;

      await rateController.waitIfNeeded();

      const role = taskTypeToRole(task.taskType as TaskType);
      const config = getAgentConfig(role);
      queue.updateStatus(task.id, "in_progress");

      this.activeTasks += 1;
      logger.info({ taskId: task.id, agent: config.role }, "Dispatching task");

      // ステータス通知
      this.deps.statusEmitter?.emitTaskStarted(task.id, config.role);

      // 👀 処理開始リアクション（該当リポジトリを特定）
      const poller = this.findPollerForTask(task.id);
      if (poller) {
        void poller.reactToIssue(task.id, "eyes");
      }

      void this.executeTask(task.id, config).finally(() => {
        this.activeTasks -= 1;
      });

      if (maxConcurrent === 1) break;
    }
  }

  private async executeTask(taskId: string, config: AgentConfig): Promise<void> {
    const { queue, dispatcher, resultCollector, circuitBreaker, budgetGuard, slackNotifier, logger } = this.deps;
    const task = queue.getById(taskId);
    if (!task) return;

    // Fixer/Builder は Reviewer と同じブランチを使う
    let existingBranch: string | undefined;
    if (task.taskType !== "review" && task.dependsOn) {
      const dependsOnTask = queue.getById(task.dependsOn);
      const depRole = dependsOnTask
        ? taskTypeToRole(dependsOnTask.taskType as TaskType)
        : "reviewer";
      existingBranch = `agent/${depRole}/${task.dependsOn}`;
    }

    const result = await dispatcher.dispatch(task, config, existingBranch);

    // Eval Store に記録
    this.deps.evalStore?.record({
      taskId,
      agentRole: config.role,
      model: config.model,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      turnsUsed: result.turnsUsed,
      success: result.status === "completed",
      failureCategory: result.status !== "completed" ? "unknown" : undefined,
      issueLabels: [],
    });

    // Pattern Memory 定期更新
    this.tasksSincePatternUpdate++;
    if (this.tasksSincePatternUpdate >= PATTERN_UPDATE_INTERVAL) {
      this.deps.patternMemory?.updatePatterns();
      this.tasksSincePatternUpdate = 0;
    }

    if (result.status === "completed") {
      circuitBreaker.recordSuccess();
      budgetGuard.recordCost(result.costUsd);

      // Validation Gate（v3.0）
      if (this.deps.validationGate && result.pushed) {
        const validation = this.deps.validationGate.validate({
          nodeId: taskId,
          planId: taskId,
          structuredOutput: result.structuredOutput,
          diff: result.result,
          diffLines: 0,
          deletedFiles: [],
        });

        if (!validation.passed) {
          logger.warn({ taskId, checks: validation.checks.filter((c) => !c.passed) }, "Validation gate failed");
          // 検証失敗でも処理は継続（警告のみ）
        }
      }

      // PR 作成フロー
      const collector = this.findCollectorForTask(task.id);
      if (result.pushed && result.branch && collector) {
        if (task.taskType === "review") {
          const prResult = await collector.createDesignPR(task, result.branch);
          if (prResult.success && prResult.prUrl) {
            queue.updateStatus(taskId, "awaiting_approval", {
              result: result.result,
              costUsd: result.costUsd,
              turnsUsed: result.turnsUsed,
              approvalPrUrl: prResult.prUrl,
            });
            logger.info({ taskId, prUrl: prResult.prUrl }, "Design PR created, awaiting approval");

            const poller = this.findPollerForTask(task.id);
            if (poller) {
              await poller.postResultToIssue(
                taskId,
                `📋 設計書PRを作成しました。確認・承認をお願いします。\n\nPR: ${prResult.prUrl}`,
              );
            }

            this.deps.statusEmitter?.emitTaskCompleted(taskId, { prUrl: prResult.prUrl, status: "awaiting_approval" });
            return;
          }
        } else {
          const reviewTask = task.dependsOn ? queue.getById(task.dependsOn) : null;
          const prUrl = reviewTask?.approvalPrUrl;
          const prNum = prUrl ? this.extractPrNumber(prUrl) : null;

          queue.updateStatus(taskId, "completed", {
            result: result.result,
            costUsd: result.costUsd,
            turnsUsed: result.turnsUsed,
          });

          if (prNum) {
            queue.updateStatus(taskId, "ci_checking", { prNumber: prNum });

            const poller = this.findPollerForTask(task.id);
            if (poller) {
              await poller.postResultToIssue(
                taskId,
                `✅ 実装が完了しました。同じPRに追加コミットしました。CIの結果を監視中です。\n\nPR: ${prUrl}`,
              );
            }
          }

          logger.info({ taskId, prNum, branch: result.branch }, "Implementation pushed to existing PR, CI monitoring started");
          this.deps.statusEmitter?.emitTaskCompleted(taskId, { prNum, branch: result.branch });
          return;
        }
      }

      // completed に更新
      queue.updateStatus(taskId, "completed", {
        result: result.result,
        costUsd: result.costUsd,
        turnsUsed: result.turnsUsed,
      });

      await slackNotifier.send({
        level: "info",
        event: "task_completed",
        title: `Task completed: ${task.title}`,
        body: `Agent ${config.role} completed task ${taskId}${result.pushed ? " (PR created)" : ""}`,
        fields: {
          taskId,
          agent: config.role,
          cost: `$${result.costUsd.toFixed(2)}`,
          turns: String(result.turnsUsed),
        },
        timestamp: new Date().toISOString(),
      });

      logger.info({ taskId, cost: result.costUsd, turns: result.turnsUsed, pushed: result.pushed }, "Task completed");
      this.deps.statusEmitter?.emitTaskCompleted(taskId, { cost: result.costUsd });

      const poller = this.findPollerForTask(task.id);
      if (poller) {
        void poller.reactToIssue(taskId, "rocket");
      }
    } else {
      // 失敗
      circuitBreaker.recordFailure();
      queue.retryTask(taskId);

      const updatedTask = queue.getById(taskId);
      if (updatedTask?.status === "failed") {
        await slackNotifier.send({
          level: "error",
          event: "task_failed_final",
          title: `Task failed: ${task.title}`,
          body: result.error ?? "Unknown error",
          fields: { taskId, agent: config.role },
          timestamp: new Date().toISOString(),
        });

        const poller = this.findPollerForTask(task.id);
        if (poller) {
          await poller.postResultToIssue(
            taskId,
            `⚠️ タスクが失敗しました（${updatedTask.retryCount}回リトライ後）\n\nエラー: ${result.error ?? "不明"}`,
          );
        }
      }

      logger.warn({ taskId, error: result.error }, "Task failed");
      this.deps.statusEmitter?.emitTaskFailed(taskId, result.error ?? "unknown");

      const failedTask = queue.getById(taskId);
      const failPoller = this.findPollerForTask(taskId);
      if (failedTask?.status === "failed" && failPoller) {
        void failPoller.reactToIssue(taskId, "confused");
      }
    }
  }

  /** タスク ID からリポジトリの GitHubPoller を特定する */
  private findPollerForTask(taskId: string): GitHubPoller | undefined {
    // マルチリポ: 将来的にタスクの repo フィールドで特定
    // 現時点: 最初のリポジトリ or 単一リポモード
    if (this.deps.repoComponents && this.deps.repoComponents.length > 0) {
      return this.deps.repoComponents[0]!.githubPoller;
    }
    return this.deps.githubPoller;
  }

  /** タスク ID からリポジトリの ResultCollector を特定する */
  private findCollectorForTask(_taskId: string): ResultCollector | undefined {
    if (this.deps.repoComponents && this.deps.repoComponents.length > 0) {
      return this.deps.repoComponents[0]!.resultCollector;
    }
    return this.deps.resultCollector;
  }

  stop(): void {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  private extractPrNumber(url: string): number | null {
    const match = /\/pull\/(\d+)/.exec(url);
    return match ? Number(match[1]) : null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
