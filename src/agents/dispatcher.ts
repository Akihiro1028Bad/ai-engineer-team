import { join } from "node:path";
import type { Task, AgentConfig } from "../types.js";

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
  status: "completed" | "retry" | "awaiting_approval";
  costUsd: number;
  turnsUsed: number;
  durationMs: number;
  result?: string;
  structuredOutput?: unknown;
  error?: string;
}

export class Dispatcher {
  constructor(
    private readonly worktreeDir: string,
    private readonly handoffDir: string,
  ) {}

  async dispatch(task: Task, config: AgentConfig): Promise<DispatchResult> {
    const cwd = join(this.worktreeDir, config.role);

    try {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

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
        };
      }

      if (resultMsg.subtype === "success") {
        return {
          status: "completed",
          costUsd: resultMsg.total_cost_usd,
          turnsUsed: resultMsg.num_turns,
          durationMs: resultMsg.duration_ms,
          result: resultMsg.result,
          structuredOutput: resultMsg.structured_output,
        };
      }

      // Error subtypes → retry
      return {
        status: "retry",
        costUsd: resultMsg.total_cost_usd,
        turnsUsed: resultMsg.num_turns,
        durationMs: resultMsg.duration_ms,
        error: `${resultMsg.subtype}: ${resultMsg.errors?.join(", ") ?? "unknown error"}`,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return {
        status: "retry",
        costUsd: 0,
        turnsUsed: 0,
        durationMs: 0,
        error: message,
      };
    }
  }
}
