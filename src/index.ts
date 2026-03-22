import Database from "better-sqlite3";
import { loadConfig } from "./config/env-config.js";
import { runMigrations } from "./queue/migrations.js";
import { TaskQueue } from "./queue/task-queue.js";
import { Dispatcher } from "./agents/dispatcher.js";
import { CronScheduler } from "./sources/cron-scheduler.js";
import { CircuitBreaker } from "./safety/circuit-breaker.js";
import { RateController } from "./safety/rate-controller.js";
import { BudgetGuard } from "./safety/budget-guard.js";
import { SlackNotifier } from "./notifications/slack-notifier.js";
import { createLogger } from "./logging/logger.js";
import { rotateOldLogs } from "./logging/log-rotation.js";
import { Orchestrator } from "./orchestrator.js";

async function main(): Promise<void> {
  const configResult = loadConfig();
  if (!configResult.success) {
    console.error("Configuration error:", configResult.error);
    process.exit(1);
  }

  const config = configResult.data;
  const logger = createLogger();

  // Log rotation
  rotateOldLogs("logs");

  // Database
  const db = new Database("tasks.db");
  runMigrations(db);

  // Components
  const queue = new TaskQueue(db);
  const dispatcher = new Dispatcher(config.worktreeDir, `${config.projectDir}/.claude/handoff`);
  const cronScheduler = new CronScheduler(queue);
  const slackNotifier = new SlackNotifier(config.slackWebhookUrl);

  const circuitBreaker = new CircuitBreaker(5, 3_600_000, () => {
    void slackNotifier.send({
      level: "error",
      event: "circuit_breaker_open",
      title: "Circuit Breaker OPEN",
      body: "5 consecutive failures detected. All agents paused for 1 hour.",
      fields: {},
      timestamp: new Date().toISOString(),
    });
  });

  const rateController = new RateController(
    config.rateControlEnabled,
    config.rateCooldownSeconds * 1000,
    config.maxTasksPerWindow,
    config.rateLimitWarnThreshold,
  );

  const budgetGuard = new BudgetGuard(config.dailyBudgetUsd);

  const orchestrator = new Orchestrator({
    queue,
    dispatcher,
    cronScheduler,
    circuitBreaker,
    rateController,
    budgetGuard,
    slackNotifier,
    logger,
    pollIntervalMs: 5_000,
    maxConcurrent: config.maxConcurrent,
  });

  // Graceful shutdown
  const shutdown = (): void => {
    logger.info("Shutting down...");
    orchestrator.stop();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  logger.info("AI Agent Orchestrator starting");
  await orchestrator.start();
}

void main();

