import type { TaskQueue } from "./queue/task-queue.js";
import type { Dispatcher } from "./agents/dispatcher.js";
import { getAgentConfig } from "./agents/agent-config.js";
import { taskTypeToRole } from "./agents/role-mapping.js";
import type { CronScheduler } from "./sources/cron-scheduler.js";
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

    // Crash recovery
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

    // Wait for active tasks to finish
    while (this.activeTasks > 0) {
      await this.sleep(1_000);
    }

    logger.info("Orchestrator stopped gracefully");
  }

  async tick(): Promise<void> {
    const { queue, dispatcher, cronScheduler, circuitBreaker, rateController, budgetGuard, slackNotifier, logger } = this.deps;
    const maxConcurrent = this.deps.maxConcurrent ?? 1;

    // Cron check
    cronScheduler.checkAndCreateTasks(new Date());

    // Budget daily reset
    budgetGuard.checkDailyReset();

    // Safety checks
    if (!circuitBreaker.canExecute()) {
      logger.warn("Circuit breaker OPEN — skipping dispatch");
      return;
    }

    if (!budgetGuard.canExecute()) {
      logger.warn("Daily budget exceeded — skipping dispatch");
      return;
    }

    // Dispatch available tasks
    while (this.activeTasks < maxConcurrent) {
      const task = queue.getNext();
      if (!task) break;

      await rateController.waitIfNeeded();

      const role = taskTypeToRole(task.taskType as TaskType);
      const config = getAgentConfig(role);
      queue.updateStatus(task.id, "in_progress");

      this.activeTasks += 1;
      logger.info({ taskId: task.id, agent: config.role }, "Dispatching task");

      // Fire and track
      void this.executeTask(task.id, config).finally(() => {
        this.activeTasks -= 1;
      });

      // For sequential execution (maxConcurrent=1), break after dispatch
      if (maxConcurrent === 1) break;
    }
  }

  private async executeTask(taskId: string, config: AgentConfig): Promise<void> {
    const { queue, dispatcher, circuitBreaker, budgetGuard, slackNotifier, logger } = this.deps;
    const task = queue.getById(taskId);
    if (!task) return;

    const result = await dispatcher.dispatch(task, config);

    if (result.status === "completed") {
      queue.updateStatus(taskId, "completed", {
        result: result.result,
        costUsd: result.costUsd,
        turnsUsed: result.turnsUsed,
      });
      circuitBreaker.recordSuccess();
      budgetGuard.recordCost(result.costUsd);

      await slackNotifier.send({
        level: "info",
        event: "task_completed",
        title: `Task completed: ${task.title}`,
        body: `Agent ${config.role} completed task ${taskId}`,
        fields: {
          taskId,
          agent: config.role,
          cost: `$${result.costUsd.toFixed(2)}`,
          turns: String(result.turnsUsed),
        },
        timestamp: new Date().toISOString(),
      });

      logger.info({ taskId, cost: result.costUsd, turns: result.turnsUsed }, "Task completed");
    } else {
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
