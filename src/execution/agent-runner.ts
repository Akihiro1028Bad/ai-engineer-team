import type pino from "pino";

import type { AgentConfigV3, AgentRoleV3 } from "../types.js";
import type { PlanNode } from "../types/execution-plan.js";
import type { HandoffReport } from "../types/handoff-report.js";
import type { WorktreeManager } from "../agents/worktree-manager.js";
import { getAgentConfigV3 } from "../agents/agent-config.js";
import type { StatusEmitter } from "./status-emitter.js";
import type { HandoffStore } from "./handoff-store.js";

interface ResultMessage {
  type: "result";
  subtype: string;
  result?: string;
  total_cost_usd: number;
  num_turns: number;
  duration_ms: number;
  structured_output?: unknown;
  errors?: string[];
}

export interface NodeRunResult {
  status: "completed" | "failed";
  nodeId: string;
  agentRole: AgentRoleV3;
  model: string;
  costUsd: number;
  turnsUsed: number;
  durationMs: number;
  result?: string;
  structuredOutput?: unknown;
  error?: string;
  pushed: boolean;
  branch?: string;
}

interface RunOptions {
  taskId: string;
  planId: string;
  node: PlanNode;
  /** 作業ディレクトリ（worktree パス） */
  cwd: string;
  /** 既存ブランチ（設計→実装の同一ブランチ戦略） */
  existingBranch?: string;
  /** プロンプトに追加する前段エージェントの出力 */
  contextInsert?: string;
  /** AbortSignal（タイムアウト制御） */
  signal?: AbortSignal;
}

/**
 * Agent Runner: 個別の DAG ノードを実行する。
 * Dispatcher のラッパーとして、タイムアウト・ステータスコールバック・構造化出力検証を提供。
 */
export class AgentRunner {
  constructor(
    private readonly worktreeManager: WorktreeManager,
    private readonly statusEmitter: StatusEmitter,
    private readonly logger: pino.Logger,
    private readonly handoffStore?: HandoffStore,
  ) {}

  async run(options: RunOptions): Promise<NodeRunResult> {
    const { taskId, planId, node, cwd, contextInsert, signal } = options;
    const config = getAgentConfigV3(node.agentRole);

    this.statusEmitter.emitNodeStarted(taskId, planId, node.id, node.agentRole);
    this.logger.info({ taskId, nodeId: node.id, agent: node.agentRole, model: node.model }, "Node execution started");

    // プロンプト構築
    let prompt = node.prompt;
    if (contextInsert) {
      prompt = `${contextInsert}\n\n---\n\n${prompt}`;
    }

    // タイムアウト制御
    const controller = new AbortController();
    const timeoutId = setTimeout(() => { controller.abort(); }, config.timeoutMs);

    // 外部 signal との連携
    if (signal) {
      signal.addEventListener("abort", () => { controller.abort(); }, { once: true });
    }

    try {
      const result = await this.executeAgent(node, config, prompt, cwd);

      if (result.status === "completed") {
        // コミット＆プッシュ（実装系エージェントの場合）
        if (this.shouldCommit(node.agentRole)) {
          const commitMessage = `${node.agentRole}: ${taskId} node ${node.id}`;
          const pushed = this.worktreeManager.commitAndPush(taskId, commitMessage);
          result.pushed = pushed;
        }

        // Handoff Report 自動生成・保存
        if (this.handoffStore) {
          this.saveHandoffReport(planId, node, result);
        }

        this.statusEmitter.emitNodeCompleted(taskId, planId, node.id, node.agentRole, {
          costUsd: result.costUsd,
          turnsUsed: result.turnsUsed,
        });
        this.logger.info(
          { taskId, nodeId: node.id, cost: result.costUsd, turns: result.turnsUsed },
          "Node execution completed",
        );
      } else {
        this.statusEmitter.emitNodeFailed(taskId, planId, node.id, node.agentRole, result.error ?? "unknown");
        this.logger.warn({ taskId, nodeId: node.id, error: result.error }, "Node execution failed");
      }

      return result;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const isTimeout = message.includes("abort") || message.includes("timeout");

      this.statusEmitter.emitNodeFailed(taskId, planId, node.id, node.agentRole, message);
      this.logger.error({ taskId, nodeId: node.id, error: message, isTimeout }, "Node execution error");

      return {
        status: "failed",
        nodeId: node.id,
        agentRole: node.agentRole,
        model: node.model,
        costUsd: 0,
        turnsUsed: 0,
        durationMs: 0,
        error: isTimeout ? `Timeout after ${config.timeoutMs}ms` : message,
        pushed: false,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Agent SDK を呼び出してノードを実行 */
  private async executeAgent(
    node: PlanNode,
    config: AgentConfigV3,
    prompt: string,
    cwd: string,
  ): Promise<NodeRunResult> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    let resultMsg: ResultMessage | null = null;

    try {
      for await (const message of query({
        prompt,
        options: {
          allowedTools: [...config.allowedTools],
          permissionMode: config.permissionMode,
          maxTurns: config.maxTurns,
          maxBudgetUsd: config.maxBudgetUsd,
          model: node.model,
          systemPrompt: config.systemPrompt || undefined,
          cwd,
        },
      }) as AsyncIterable<{ type: string } & Record<string, unknown>>) {
        if (message.type === "result") {
          resultMsg = message as unknown as ResultMessage;
        }
      }
    } catch {
      // Agent SDK がプロセス終了時に exit code 1 を投げることがある。
      // resultMsg が既に取得済みなら無視して続行する。
    }

    if (!resultMsg) {
      return {
        status: "failed",
        nodeId: node.id,
        agentRole: node.agentRole,
        model: node.model,
        costUsd: 0,
        turnsUsed: 0,
        durationMs: 0,
        error: "No result message received",
        pushed: false,
      };
    }

    if (resultMsg.subtype === "success") {
      return {
        status: "completed",
        nodeId: node.id,
        agentRole: node.agentRole,
        model: node.model,
        costUsd: resultMsg.total_cost_usd,
        turnsUsed: resultMsg.num_turns,
        durationMs: resultMsg.duration_ms,
        result: resultMsg.result,
        structuredOutput: resultMsg.structured_output,
        pushed: false,
      };
    }

    return {
      status: "failed",
      nodeId: node.id,
      agentRole: node.agentRole,
      model: node.model,
      costUsd: resultMsg.total_cost_usd,
      turnsUsed: resultMsg.num_turns,
      durationMs: resultMsg.duration_ms,
      error: `${resultMsg.subtype}: ${resultMsg.errors?.join(", ") ?? "unknown error"}`,
      pushed: false,
    };
  }

  /** コミットが必要なエージェントロールかどうか */
  private shouldCommit(role: AgentRoleV3): boolean {
    return ["designer", "implementer", "scribe", "reviewer", "fixer", "builder"].includes(role);
  }

  /** Handoff Report を自動生成して保存する */
  private saveHandoffReport(planId: string, node: PlanNode, result: NodeRunResult): void {
    if (!this.handoffStore) return;

    // 後続ノードは dependsOn で定義されていないため、
    // 現ノードから次のノードへの引き継ぎとして "self → dependants" の形で保存
    const report: HandoffReport = {
      id: `handoff-${planId}-${node.id}-${Date.now()}`,
      planId,
      fromNodeId: node.id,
      toNodeId: "next", // 後続ノードが実行時に取得する
      fromAgent: node.agentRole,
      toAgent: node.agentRole, // 後続ノードの role は不明なので同一で placeholder
      summary: result.result
        ? result.result.slice(0, 500)
        : `${node.agentRole} completed node ${node.id}`,
      decisions: [],
      artifacts: result.pushed
        ? [{ type: "file", content: "Changes committed and pushed" }]
        : [],
      warnings: result.error ? [result.error] : [],
      timestamp: new Date().toISOString(),
    };

    try {
      this.handoffStore.save(report);
    } catch {
      this.logger.warn({ planId, nodeId: node.id }, "Failed to save handoff report");
    }
  }
}
