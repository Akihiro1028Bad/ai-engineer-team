import type { TaskQueue } from "./queue/task-queue.js";
import type { Dispatcher } from "./agents/dispatcher.js";
import { getAgentConfig } from "./agents/agent-config.js";
import { taskTypeToRole } from "./agents/role-mapping.js";
import type { CronScheduler } from "./sources/cron-scheduler.js";
import type { GitHubPoller } from "./sources/github-poller.js";
import type { ResultCollector } from "./bridges/result-collector.js";
import type { CircuitBreaker } from "./safety/circuit-breaker.js";
import type { RateController } from "./safety/rate-controller.js";
import type { BudgetGuard } from "./safety/budget-guard.js";
import type { SlackNotifier } from "./notifications/slack-notifier.js";
import type pino from "pino";
import type { AgentConfig, TaskType } from "./types.js";

export interface OrchestratorDeps {
  queue: TaskQueue;
  dispatcher: Dispatcher;
  cronScheduler: CronScheduler;
  githubPoller?: GitHubPoller;
  resultCollector?: ResultCollector;
  circuitBreaker: CircuitBreaker;
  rateController: RateController;
  budgetGuard: BudgetGuard;
  slackNotifier: SlackNotifier;
  logger: pino.Logger;
  pollIntervalMs?: number;
  maxConcurrent?: number;
}

export class Orchestrator {
  private running = false;
  private activeTasks = 0;

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

    cronScheduler.checkAndCreateTasks(new Date());

    if (this.deps.githubPoller) {
      await this.deps.githubPoller.pollIssues();
      await this.deps.githubPoller.pollComments();
      await this.deps.githubPoller.pollApprovals();
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

    const result = await dispatcher.dispatch(task, config);

    if (result.status === "completed") {
      circuitBreaker.recordSuccess();
      budgetGuard.recordCost(result.costUsd);

      // PR 作成フロー（変更がプッシュされた場合のみ）
      if (result.pushed && result.branch && resultCollector) {
        const isPipeline = task.parentTaskId !== null;
        const isReviewTask = task.taskType === "review";

        if (isPipeline && isReviewTask) {
          // パイプライン Reviewer → 設計PR作成 → awaiting_approval
          const prResult = await resultCollector.createDesignPR(task, result.branch);
          if (prResult.success && prResult.prUrl) {
            queue.updateStatus(taskId, "awaiting_approval", {
              result: result.result,
              costUsd: result.costUsd,
              turnsUsed: result.turnsUsed,
              approvalPrUrl: prResult.prUrl,
            });
            logger.info({ taskId, prUrl: prResult.prUrl }, "Design PR created, awaiting approval");

            if (this.deps.githubPoller) {
              await this.deps.githubPoller.postResultToIssue(
                taskId,
                `📋 設計PRを作成しました。確認・承認をお願いします。\n\nPR: ${prResult.prUrl}\n\n${result.result ?? ""}`,
              );
            }
            return; // awaiting_approval に遷移したので completed にしない
          }
        } else {
          // 単体タスク or パイプライン後続 → 実装PR作成
          const prMethod = isPipeline
            ? resultCollector.createFinalPR([task], result.branch)
            : resultCollector.createSinglePR(task, result.branch);
          const prResult = await prMethod;

          if (prResult.success && prResult.prUrl) {
            logger.info({ taskId, prUrl: prResult.prUrl }, "PR created");

            if (this.deps.githubPoller) {
              await this.deps.githubPoller.postResultToIssue(
                taskId,
                `✅ 修正が完了し、PRを作成しました。\n\nPR: ${prResult.prUrl}\n\n${result.result ?? ""}`,
              );
            }
          }
        }
      } else if (this.deps.githubPoller && result.result) {
        // 変更なし（分析・質問のみ）→ Issue にコメント投稿
        await this.deps.githubPoller.postResultToIssue(taskId, result.result);
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

        if (this.deps.githubPoller) {
          await this.deps.githubPoller.postResultToIssue(
            taskId,
            `⚠️ タスクが失敗しました（${updatedTask.retryCount}回リトライ後）\n\nエラー: ${result.error ?? "不明"}`,
          );
        }
      }

      logger.warn({ taskId, error: result.error }, "Task failed");
    }
  }

  stop(): void {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
