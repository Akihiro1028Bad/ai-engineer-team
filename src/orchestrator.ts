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
import type { AgentRunner } from "./execution/agent-runner.js";
import type { EvalStore } from "./feedback/eval-store.js";
import type { PatternMemoryStore } from "./feedback/pattern-memory.js";
import type { ModelRouter } from "./feedback/model-router.js";
import type { PRFeedbackLearner } from "./feedback/pr-feedback-learner.js";
import type { ValidationGate } from "./quality/validation-gate.js";
import type { GeneratorCriticLoop } from "./quality/generator-critic-loop.js";
import type { SkillRegistry } from "./toolforge/skill-registry.js";
import type { GapDetector } from "./toolforge/gap-detector.js";
import type { ToolSynthesizer } from "./toolforge/tool-synthesizer.js";
import type { SandboxValidator } from "./toolforge/sandbox-validator.js";
import type { PerAgentCircuitBreaker } from "./safety/per-agent-circuit-breaker.js";
import { AnalyzerAgent } from "./planning/analyzer-agent.js";
import { PlannerAgent } from "./planning/planner-agent.js";
import { DAGScheduler } from "./planning/dag-scheduler.js";
import { CostEstimator } from "./planning/cost-estimator.js";
import { DryRunPreview } from "./planning/dry-run.js";
import type pino from "pino";
import type { AgentConfig, TaskType } from "./types.js";
import type { ExecutionPlan } from "./types/execution-plan.js";

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
  agentRunner?: AgentRunner;
  evalStore?: EvalStore;
  patternMemory?: PatternMemoryStore;
  modelRouter?: ModelRouter;
  feedbackLearner?: PRFeedbackLearner;
  validationGate?: ValidationGate;
  criticLoop?: GeneratorCriticLoop;
  skillRegistry?: SkillRegistry;
  repoComponents?: RepoRef[];
  dryRunDefault?: boolean;
  /** v3.0 Planning レイヤーを有効化するか（false: v2.1 互換モード） */
  enableV3Planning?: boolean;
  // Per-Agent Circuit Breaker
  perAgentCircuitBreaker?: PerAgentCircuitBreaker;
  // ToolForge
  gapDetector?: GapDetector;
  toolSynthesizer?: ToolSynthesizer;
  sandboxValidator?: SandboxValidator;
  toolforgeEnabled?: boolean;
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

  // v3.0 Planning コンポーネント（遅延初期化）
  private analyzerAgent?: AnalyzerAgent;
  private plannerAgent?: PlannerAgent;
  private dagScheduler?: DAGScheduler;
  private costEstimator?: CostEstimator;
  private dryRunPreview?: DryRunPreview;

  constructor(private readonly deps: OrchestratorDeps) {
    if (deps.enableV3Planning) {
      this.analyzerAgent = new AnalyzerAgent(deps.logger);
      this.plannerAgent = new PlannerAgent(deps.logger);
      this.dagScheduler = new DAGScheduler();
      this.costEstimator = new CostEstimator();

      // DryRunPreview は GitHub 接続が必要
      const primaryPoller = deps.repoComponents?.[0]?.githubPoller;
      if (primaryPoller) {
        // Octokit を直接参照できないので、後で初期化
      }
    }
  }

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

        try {
          await repo.ciMonitor.checkPendingPRs();
        } catch (error: unknown) {
          logger.warn({ repoId: repo.repoId, error }, "Repo CI monitor error");
        }

        if (this.tickCount % STALE_PR_CHECK_INTERVAL === 0) {
          try {
            await repo.stalePRReminder.checkStalePRs();
          } catch { /* non-critical */ }
        }
      }
    } else {
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

    // タスクディスパッチ
    while (this.activeTasks < maxConcurrent) {
      const task = queue.getNext();
      if (!task) break;

      await rateController.waitIfNeeded();

      queue.updateStatus(task.id, "in_progress");
      this.activeTasks += 1;

      // v3.0 Planning フロー or v2.1 互換フロー
      if (this.deps.enableV3Planning && this.isV3Eligible(task.taskType)) {
        logger.info({ taskId: task.id }, "Dispatching via v3.0 planning flow");
        this.deps.statusEmitter?.emitTaskStarted(task.id, "planner");

        const poller = this.findPollerForTask(task.id);
        if (poller) void poller.reactToIssue(task.id, "eyes");

        void this.executeV3Flow(task.id).finally(() => {
          this.activeTasks -= 1;
        });
      } else {
        const role = taskTypeToRole(task.taskType as TaskType);
        const config = getAgentConfig(role);

        logger.info({ taskId: task.id, agent: config.role }, "Dispatching via v2.1 flow");
        this.deps.statusEmitter?.emitTaskStarted(task.id, config.role);

        const poller = this.findPollerForTask(task.id);
        if (poller) void poller.reactToIssue(task.id, "eyes");

        void this.executeV2Task(task.id, config).finally(() => {
          this.activeTasks -= 1;
        });
      }

      if (maxConcurrent === 1) break;
    }

    // ToolForge: 失敗パターンからツールギャップを検出（低頻度）
    if (this.deps.toolforgeEnabled && this.deps.gapDetector && this.tickCount % 100 === 0) {
      try {
        const gaps = this.deps.gapDetector.detectFromFailures();
        if (gaps.length > 0 && this.deps.toolSynthesizer && this.deps.sandboxValidator && this.deps.skillRegistry) {
          for (const gap of gaps.slice(0, 1)) { // 一度に1つだけ生成
            logger.info({ gap: gap.suggestedToolName }, "ToolForge: generating skill for gap");
            const tool = await this.deps.toolSynthesizer.synthesize(gap);
            if (tool) {
              const toolDir = this.deps.toolSynthesizer.writeToDisk(tool);
              const validation = this.deps.sandboxValidator.validate(toolDir);
              if (validation.passed) {
                this.deps.skillRegistry.register({
                  name: tool.name,
                  description: tool.description,
                  version: 1,
                  createdBy: "toolforge",
                  safetyLevel: tool.safetyLevel,
                  usageCount: 0,
                  successRate: 0,
                  approvalStatus: tool.safetyLevel === "read_only" ? "approved" : "pending_review",
                  tags: [gap.category],
                  createdAt: new Date().toISOString(),
                });
                logger.info({ tool: tool.name }, "ToolForge: skill registered");
              } else {
                logger.warn({ tool: tool.name, checks: validation.checks.filter((c) => !c.passed) }, "ToolForge: skill validation failed");
              }
            }
          }
        }
      } catch (error: unknown) {
        logger.warn({ error }, "ToolForge check failed");
      }
    }

    // Skill Registry evolution（低頻度）
    if (this.deps.skillRegistry && this.tickCount % 500 === 0) {
      const { promoted, deprecated } = this.deps.skillRegistry.evolve();
      if (promoted.length > 0 || deprecated.length > 0) {
        logger.info({ promoted, deprecated }, "Skill lifecycle evolution");
      }
    }
  }

  // ========================================
  // v3.0 Planning フロー
  // ========================================

  /** v3.0 フロー: Analyzer → Planner → DAG → バッチ実行 */
  private async executeV3Flow(taskId: string): Promise<void> {
    const { queue, logger } = this.deps;
    const task = queue.getById(taskId);
    if (!task) return;

    const issueMatch = /^gh-(\d+)/.exec(taskId);
    const issueNumber = issueMatch ? Number(issueMatch[1]) : 0;

    // 作業ディレクトリ（プライマリリポ）
    const cwd = this.deps.repoComponents?.[0]
      ? `/tmp/v3-analysis-${taskId}`  // TODO: 実際の worktree パス
      : ".";

    try {
      // Step 1: Analyzer（Haiku, ~$0.05）
      queue.updateStatus(taskId, "planning");
      this.deps.statusEmitter?.emitProgress(taskId, "コードベースを分析中...");

      const analysisReport = await this.analyzerAgent!.analyze({
        issueNumber,
        title: task.title,
        body: task.description,
        labels: [],
        cwd,
      });

      logger.info({
        taskId,
        files: analysisReport.affectedFiles.length,
        complexity: analysisReport.estimatedComplexity,
      }, "Analysis complete");

      // Step 2: Planner（Opus, ~$0.80）
      this.deps.statusEmitter?.emitProgress(taskId, "実行計画を生成中...");

      const patternContext = this.deps.patternMemory?.buildPlannerContext(
        task.taskType, undefined,
      );

      const plan = await this.plannerAgent!.plan({
        taskId,
        issueNumber,
        title: task.title,
        body: task.description,
        labels: [],
        analysisReport,
        patternContext: patternContext || undefined,
        cwd,
      });

      logger.info({
        taskId,
        nodes: plan.nodes.length,
        estimatedCost: plan.totalEstimatedCostUsd,
        riskLevel: plan.riskLevel,
      }, "Execution plan generated");

      // Step 2.5: コスト/時間見積を表示
      const estimate = this.costEstimator!.estimate(plan);
      this.deps.statusEmitter?.emitProgress(taskId, this.costEstimator!.formatSummary(estimate));

      // Step 2.6: Dry Run モード
      if (this.deps.dryRunDefault) {
        logger.info({ taskId }, "Dry run mode — plan generated but not executed");
        // TODO: DryRunPreview で Issue にコメント投稿
        queue.updateStatus(taskId, "awaiting_approval", {
          result: `Dry Run: ${plan.nodes.length} nodes, $${estimate.totalCostUsd.toFixed(2)}`,
        });
        this.deps.statusEmitter?.emitTaskCompleted(taskId, { dryRun: true });
        return;
      }

      // Step 3: DAG スケジューリング
      const schedule = this.dagScheduler!.schedule(plan);
      logger.info({
        taskId,
        batches: schedule.batches.length,
        criticalPath: schedule.criticalPath,
      }, "DAG scheduled");

      // Step 4: バッチ順に実行
      await this.executePlanBatches(taskId, plan, schedule);

    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      logger.error({ taskId, error: message }, "v3.0 flow failed");

      this.deps.evalStore?.record({
        taskId,
        agentRole: "analyzer",
        model: "haiku",
        costUsd: 0,
        durationMs: 0,
        turnsUsed: 0,
        success: false,
        failureCategory: "crash",
        issueLabels: [],
      });

      queue.retryTask(taskId);
      this.deps.statusEmitter?.emitTaskFailed(taskId, message);
      this.deps.circuitBreaker.recordFailure();
    }
  }

  /** DAG のバッチを順次実行する */
  private async executePlanBatches(
    taskId: string,
    plan: ExecutionPlan,
    schedule: { batches: { nodes: ExecutionPlan["nodes"]; order: number }[] },
  ): Promise<void> {
    const { queue, logger } = this.deps;

    for (const batch of schedule.batches) {
      logger.info({ taskId, batchOrder: batch.order, nodeCount: batch.nodes.length }, "Executing batch");
      this.deps.statusEmitter?.emitProgress(
        taskId,
        `バッチ ${batch.order + 1}/${schedule.batches.length} を実行中（${batch.nodes.length} ノード）`,
      );

      // バッチ内のノードを実行（現時点は順次、将来は並列可能）
      for (const node of batch.nodes) {
        if (!this.running) return;

        // AgentRunner が利用可能なら v3.0 実行、なければ v2.1 Dispatcher にフォールバック
        if (this.deps.agentRunner) {
          const result = await this.deps.agentRunner.run({
            taskId,
            planId: plan.taskId,
            node,
            cwd: ".", // TODO: worktree パス
          });

          // Eval 記録
          this.deps.evalStore?.record({
            taskId,
            planId: plan.taskId,
            nodeId: node.id,
            agentRole: node.agentRole,
            model: node.model,
            costUsd: result.costUsd,
            durationMs: result.durationMs,
            turnsUsed: result.turnsUsed,
            success: result.status === "completed",
            failureCategory: result.status !== "completed" ? "unknown" : undefined,
            issueLabels: [],
          });

          // Validation Gate
          if (this.deps.validationGate && result.status === "completed") {
            const validation = this.deps.validationGate.validate({
              nodeId: node.id,
              planId: plan.taskId,
              structuredOutput: result.structuredOutput,
            });

            if (!validation.passed) {
              logger.warn({ taskId, nodeId: node.id }, "Validation gate failed");
              // 検証失敗 → リトライ（maxRetries まで）
              // 現時点では警告のみで続行
            }
          }

          if (result.status === "failed") {
            logger.error({ taskId, nodeId: node.id, error: result.error }, "Node failed");
            queue.retryTask(taskId);
            this.deps.statusEmitter?.emitTaskFailed(taskId, result.error ?? "Node failed");
            this.deps.circuitBreaker.recordFailure();
            return;
          }

          this.deps.budgetGuard.recordCost(result.costUsd);
        } else {
          // フォールバック: v2.1 Dispatcher で実行
          logger.info({ taskId, nodeId: node.id }, "Falling back to v2.1 dispatcher for node");
          // v2.1 フローに委譲するため、ここでは skip
        }
      }
    }

    // 全バッチ完了
    queue.updateStatus(taskId, "completed", {
      result: `v3.0 plan executed: ${plan.nodes.length} nodes completed`,
    });
    this.deps.statusEmitter?.emitTaskCompleted(taskId, { planNodes: plan.nodes.length });
    this.deps.circuitBreaker.recordSuccess();

    this.tasksSincePatternUpdate++;
    if (this.tasksSincePatternUpdate >= PATTERN_UPDATE_INTERVAL) {
      this.deps.patternMemory?.updatePatterns();
      this.tasksSincePatternUpdate = 0;
    }

    logger.info({ taskId, nodes: plan.nodes.length }, "v3.0 plan execution complete");

    // 🚀 完了リアクション
    const poller = this.findPollerForTask(taskId);
    if (poller) void poller.reactToIssue(taskId, "rocket");
  }

  /** v3.0 フロー対象か判定（新タスクタイプ or review の初回） */
  private isV3Eligible(taskType: string): boolean {
    // v3.0 タスクタイプ（analyze, design, implement, critique）
    if (["analyze", "design", "implement", "critique"].includes(taskType)) return true;
    // review タスクが依存なし（パイプラインの先頭）の場合も v3.0 対象
    // 現時点: review/fix/build/document は v2.1 フロー維持
    return false;
  }

  // ========================================
  // v2.1 互換フロー
  // ========================================

  private async executeV2Task(taskId: string, config: AgentConfig): Promise<void> {
    const { queue, dispatcher, circuitBreaker, budgetGuard, slackNotifier, logger } = this.deps;
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

    this.tasksSincePatternUpdate++;
    if (this.tasksSincePatternUpdate >= PATTERN_UPDATE_INTERVAL) {
      this.deps.patternMemory?.updatePatterns();
      this.tasksSincePatternUpdate = 0;
    }

    if (result.status === "completed") {
      circuitBreaker.recordSuccess();
      budgetGuard.recordCost(result.costUsd);

      // Validation Gate
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

          logger.info({ taskId, prNum, branch: result.branch }, "Implementation pushed, CI monitoring started");
          this.deps.statusEmitter?.emitTaskCompleted(taskId, { prNum, branch: result.branch });
          return;
        }
      }

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
      if (poller) void poller.reactToIssue(taskId, "rocket");
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

  // ========================================
  // ヘルパー
  // ========================================

  /** タスク ID からリポジトリの GitHubPoller を特定する */
  private findPollerForTask(_taskId: string): GitHubPoller | undefined {
    if (this.deps.repoComponents && this.deps.repoComponents.length > 0) {
      // TODO: タスクの repo フィールドで特定
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
