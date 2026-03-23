import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Task, AgentConfig, TaskType } from "../types.js";
import type { WorktreeManager } from "./worktree-manager.js";
import { taskTypeToRole } from "./role-mapping.js";

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
  pushed: boolean;
  branch?: string;
  /** Reviewer が作成した設計書のパス */
  designFilePath?: string;
}

/** Issue 番号を taskId から抽出する (gh-{N}-0 → N) */
function extractIssueNumber(taskId: string): string | null {
  const match = /^gh-(\d+)-/.exec(taskId);
  return match ? match[1]! : null;
}

export class Dispatcher {
  constructor(
    private readonly worktreeManager: WorktreeManager,
    private readonly _handoffDir: string,
  ) {}

  async dispatch(task: Task, config: AgentConfig, existingBranch?: string): Promise<DispatchResult> {
    const role = taskTypeToRole(task.taskType as TaskType);

    // 既存ブランチが指定されていればそのブランチを使う（設計→実装の同一ブランチ）
    let cwd: string;
    let branch: string;
    if (existingBranch) {
      // Reviewer の worktree 上で既存ブランチに切り替え
      cwd = this.worktreeManager.prepareExistingBranch(role, existingBranch);
      branch = existingBranch;
    } else {
      cwd = this.worktreeManager.prepare(role, task.id);
      branch = this.worktreeManager.getBranchName(role, task.id);
    }

    // Fixer/Builder の場合: design.md を読んでプロンプトに追加
    let prompt = task.description;
    const issueNumber = extractIssueNumber(task.id);

    if (task.taskType !== "review" && issueNumber) {
      // 設計書パスを探索（単一スコープ or 複数スコープ）
      const candidates = [
        join(cwd, `specs/issue-${issueNumber}/design.md`),
      ];
      // task description からスコープパスを抽出
      const scopeMatch = /specs\/issue-\d+\/([^/]+)\/design\.md/.exec(task.description);
      if (scopeMatch) {
        candidates.unshift(join(cwd, `specs/issue-${issueNumber}/${scopeMatch[1]}/design.md`));
      }

      for (const designPath of candidates) {
        if (!existsSync(designPath)) continue;
        const designContent = readFileSync(designPath, "utf-8");
        prompt = [
          task.description,
          "",
          "## 承認済み設計書",
          "",
          designContent,
        ].join("\n");
        break;
      }
    }

    // Reviewer の場合: Issue 番号をプロンプトに埋め込む
    if (task.taskType === "review" && issueNumber && config.systemPrompt) {
      // systemPrompt 内の {ISSUE_NUMBER} を実際の番号に置換
      prompt = [
        `Issue番号: #${issueNumber}`,
        `設計書の出力先: specs/issue-${issueNumber}/design.md`,
        "",
        prompt,
      ].join("\n");
    }

    const systemPrompt = issueNumber
      ? config.systemPrompt.replaceAll("{ISSUE_NUMBER}", issueNumber)
      : config.systemPrompt;

    try {
      let resultMsg: ResultMessage | null = null;

      for await (const message of query({
        prompt,
        options: {
          allowedTools: [...config.allowedTools],
          permissionMode: config.permissionMode,
          maxTurns: config.maxTurns,
          maxBudgetUsd: config.maxBudgetUsd,
          model: config.model,
          systemPrompt: systemPrompt || undefined,
          cwd,
        },
      }) as AsyncIterable<{ type: string } & Record<string, unknown>>) {
        if (message.type === "result") {
          resultMsg = message as unknown as ResultMessage;
        }
      }

      if (!resultMsg) {
        return {
          status: "retry", costUsd: 0, turnsUsed: 0, durationMs: 0,
          error: "No result message received", pushed: false,
        };
      }

      if (resultMsg.subtype === "success") {
        // Reviewer の場合: design.md の存在を検証（単一スコープ + マルチスコープ両対応）
        let designFilePath: string | undefined;
        if (task.taskType === "review" && issueNumber) {
          // task description からスコープパスを抽出（マルチスコープ対応）
          const scopeMatch = /specs\/issue-\d+\/([^/]+)\/design\.md/.exec(task.description);
          const designCandidates = scopeMatch
            ? [
                `specs/issue-${issueNumber}/${scopeMatch[1]}/design.md`,
                `specs/issue-${issueNumber}/design.md`,
              ]
            : [`specs/issue-${issueNumber}/design.md`];

          for (const candidate of designCandidates) {
            if (existsSync(join(cwd, candidate))) {
              designFilePath = candidate;
              break;
            }
          }
        }

        const commitMessage = task.taskType === "review"
          ? `design: ${task.title} (#${issueNumber ?? task.id})`
          : `${task.taskType}: ${task.title} (#${issueNumber ?? task.id})`;
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
          designFilePath,
        };
      }

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
        status: "retry", costUsd: 0, turnsUsed: 0, durationMs: 0,
        error: message, pushed: false,
      };
    }
  }
}
