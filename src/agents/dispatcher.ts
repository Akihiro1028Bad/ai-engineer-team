import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Task, AgentConfig } from "../types.js";
import type { WorktreeManager } from "./worktree-manager.js";
import { taskTypeToRole } from "./role-mapping.js";
import type { TaskType } from "../types.js";

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

export interface DispatchResult {
  status: "completed" | "retry";
  costUsd: number;
  turnsUsed: number;
  durationMs: number;
  result?: string;
  structuredOutput?: unknown;
  error?: string;
  /** エージェントが変更をコミット・プッシュしたか */
  pushed: boolean;
  /** プッシュしたブランチ名 */
  branch?: string;
}

export class Dispatcher {
  constructor(
    private readonly worktreeManager: WorktreeManager,
    private readonly handoffDir: string,
  ) {}

  async dispatch(task: Task, config: AgentConfig): Promise<DispatchResult> {
    const role = taskTypeToRole(task.taskType as TaskType);

    // 1. ブランチ作成 + worktree 準備
    const cwd = this.worktreeManager.prepare(role, task.id);
    const branch = this.worktreeManager.getBranchName(role, task.id);

    try {
      let resultMsg: ResultMessage | null = null;

      for await (const message of query({
        prompt: task.description,
        options: {
          allowedTools: [...config.allowedTools],
          permissionMode: config.permissionMode,
          maxTurns: config.maxTurns,
          maxBudgetUsd: config.maxBudgetUsd,
          model: config.model,
          cwd,
        },
      }) as AsyncIterable<{ type: string } & Record<string, unknown>>) {
        if (message.type === "result") {
          resultMsg = message as unknown as ResultMessage;
        }
      }

      if (!resultMsg) {
        return {
          status: "retry",
          costUsd: 0,
          turnsUsed: 0,
          durationMs: 0,
          error: "No result message received",
          pushed: false,
        };
      }

      if (resultMsg.subtype === "success") {
        // 2. 変更があればコミット・プッシュ
        const commitMessage = `${task.taskType}: ${task.title} (${task.id})`;
        const pushed = this.worktreeManager.commitAndPush(role, task.id, commitMessage);

        return {
          status: "completed",
          costUsd: resultMsg.total_cost_usd,
          turnsUsed: resultMsg.num_turns,
          durationMs: resultMsg.duration_ms,
          result: resultMsg.result,
          structuredOutput: resultMsg.structured_output,
          pushed,
          branch: pushed ? branch : undefined,
        };
      }

      // Error subtypes → retry
      return {
        status: "retry",
        costUsd: resultMsg.total_cost_usd,
        turnsUsed: resultMsg.num_turns,
        durationMs: resultMsg.duration_ms,
        error: `${resultMsg.subtype}: ${resultMsg.errors?.join(", ") ?? "unknown error"}`,
        pushed: false,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        status: "retry",
        costUsd: 0,
        turnsUsed: 0,
        durationMs: 0,
        error: message,
        pushed: false,
      };
    }
  }
}
