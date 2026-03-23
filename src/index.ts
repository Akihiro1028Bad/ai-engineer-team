import "dotenv/config";
import { execSync } from "node:child_process";

import Database from "better-sqlite3";
import { Octokit } from "@octokit/rest";

import { loadConfig } from "./config/env-config.js";
import { loadReposConfig } from "./config/repos.js";
import { runMigrations } from "./queue/migrations.js";
import { TaskQueue } from "./queue/task-queue.js";
import { WorktreeManager } from "./agents/worktree-manager.js";
import { Dispatcher } from "./agents/dispatcher.js";
import { CronScheduler } from "./sources/cron-scheduler.js";
import { GitHubPoller } from "./sources/github-poller.js";
import { ResultCollector } from "./bridges/result-collector.js";
import { CIMonitor } from "./sources/ci-monitor.js";
import { StalePRReminder } from "./sources/stale-pr-reminder.js";
import { CircuitBreaker } from "./safety/circuit-breaker.js";
import { RateController } from "./safety/rate-controller.js";
import { BudgetGuard } from "./safety/budget-guard.js";
import { SlackNotifier } from "./notifications/slack-notifier.js";
import { createLogger } from "./logging/logger.js";
import { rotateOldLogs } from "./logging/log-rotation.js";
import { StatusEmitter } from "./execution/status-emitter.js";
import { HandoffStore } from "./execution/handoff-store.js";
import { EvalStore } from "./feedback/eval-store.js";
import { PatternMemoryStore } from "./feedback/pattern-memory.js";
import { ModelRouter } from "./feedback/model-router.js";
import { PRFeedbackLearner } from "./feedback/pr-feedback-learner.js";
import { ValidationGate } from "./quality/validation-gate.js";
import { DashboardServer } from "./dashboard/server.js";
import { SkillRegistry } from "./toolforge/skill-registry.js";
import { Orchestrator } from "./orchestrator.js";
import type { RepoConfig } from "./types.js";

/** リポジトリごとのコンポーネント群 */
interface RepoComponents {
  repoConfig: RepoConfig;
  owner: string;
  repo: string;
  worktreeManager: WorktreeManager;
  dispatcher: Dispatcher;
  githubPoller: GitHubPoller;
  resultCollector: ResultCollector;
  ciMonitor: CIMonitor;
  stalePRReminder: StalePRReminder;
}

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

  // Database（全リポジトリ共有）
  const db = new Database("tasks.db");
  runMigrations(db);

  // 共有コンポーネント
  const octokit = new Octokit({ auth: config.githubToken });
  const queue = new TaskQueue(db);
  const slackNotifier = new SlackNotifier(config.slackWebhookUrl);
  const cronScheduler = new CronScheduler(queue);
  const statusEmitter = new StatusEmitter();

  // v3.0 共有コンポーネント
  const handoffStore = new HandoffStore(db, logger);
  const evalStore = new EvalStore(db, logger);
  const patternMemory = new PatternMemoryStore(db, logger);
  const modelRouter = new ModelRouter(patternMemory, logger, {
    explorationRate: config.explorationRate,
  });
  const feedbackLearner = new PRFeedbackLearner(db, logger);
  const validationGate = new ValidationGate(logger);
  const skillRegistry = new SkillRegistry("skills", logger);

  // マルチリポジトリ設定の読み込み
  const repos = loadReposConfig(config.reposJsonPath, {
    githubRepo: config.githubRepo,
    projectDir: config.projectDir,
    worktreeDir: config.worktreeDir,
  });

  logger.info({ repoCount: repos.length, repos: repos.map((r) => r.id) }, "Repositories loaded");

  // リポジトリごとのコンポーネントを初期化
  const repoComponents: RepoComponents[] = repos.map((repoConfig) => {
    const [owner, repo] = repoConfig.githubRepo.split("/") as [string, string];

    const worktreeManager = new WorktreeManager(
      repoConfig.worktreeDir,
      repoConfig.projectDir,
      (cmd: string) => execSync(cmd),
    );

    const dispatcher = new Dispatcher(
      worktreeManager,
      `${repoConfig.projectDir}/.claude/handoff`,
    );

    const githubPoller = new GitHubPoller(
      octokit as never, queue, owner, repo, dispatcher,
    );

    const resultCollector = new ResultCollector(
      octokit as never, slackNotifier, owner, repo,
    );

    const ciMonitor = new CIMonitor(
      octokit as never, queue, dispatcher, owner, repo, logger,
    );

    const stalePRReminder = new StalePRReminder(
      octokit as never, slackNotifier, owner, repo, logger,
    );

    logger.info({ repoId: repoConfig.id, githubRepo: repoConfig.githubRepo }, "Repo components initialized");

    return {
      repoConfig,
      owner,
      repo,
      worktreeManager,
      dispatcher,
      githubPoller,
      resultCollector,
      ciMonitor,
      stalePRReminder,
    };
  });

  // 安全機構（グローバル）
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

  // Orchestrator（マルチリポ対応）
  // 最初のリポジトリをプライマリとして使用（後方互換）
  const primary = repoComponents[0]!;
  const orchestrator = new Orchestrator({
    queue,
    dispatcher: primary.dispatcher,
    cronScheduler,
    githubPoller: primary.githubPoller,
    resultCollector: primary.resultCollector,
    ciMonitor: primary.ciMonitor,
    circuitBreaker,
    rateController,
    budgetGuard,
    slackNotifier,
    logger,
    pollIntervalMs: 30_000,
    maxConcurrent: config.maxConcurrent,
    // v3.0 新規
    statusEmitter,
    handoffStore,
    evalStore,
    patternMemory,
    modelRouter,
    feedbackLearner,
    validationGate,
    skillRegistry,
    repoComponents: repoComponents.map((rc) => ({
      repoId: rc.repoConfig.id,
      githubPoller: rc.githubPoller,
      resultCollector: rc.resultCollector,
      ciMonitor: rc.ciMonitor,
      stalePRReminder: rc.stalePRReminder,
      dispatcher: rc.dispatcher,
    })),
    dryRunDefault: config.dryRunDefault,
  });

  // Dashboard サーバー
  if (config.dashboardEnabled) {
    const dashboard = new DashboardServer(db, statusEmitter, {
      port: config.dashboardPort,
    }, logger);
    dashboard.start();
    logger.info({ port: config.dashboardPort }, "Dashboard server enabled");
  }

  // Graceful shutdown
  const shutdown = (): void => {
    logger.info("Shutting down...");
    orchestrator.stop();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  logger.info({
    repos: repos.map((r) => r.githubRepo),
    dashboardEnabled: config.dashboardEnabled,
    dryRunDefault: config.dryRunDefault,
  }, "AI Agent Orchestrator v3.0 starting");
  await orchestrator.start();
}

void main();
