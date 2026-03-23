import { EventEmitter } from "node:events";

/** ステータスイベントの型定義 */
export interface TaskEvent {
  type: "task_started" | "task_progress" | "task_completed" | "task_failed" | "node_started" | "node_completed" | "node_failed";
  taskId: string;
  planId?: string;
  nodeId?: string;
  agentRole?: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

/**
 * リアルタイムステータス配信。
 * Dashboard (Phase 6) と Slack 通知が購読する。
 */
export class StatusEmitter extends EventEmitter {
  /** 型安全な emit */
  emitStatus(payload: TaskEvent): boolean {
    return super.emit("status", payload);
  }

  /** 型安全な listener 登録 */
  onStatus(listener: (payload: TaskEvent) => void): this {
    return super.on("status", listener);
  }

  /** タスク開始イベント */
  emitTaskStarted(taskId: string, agentRole: string, planId?: string): void {
    this.emitStatus({
      type: "task_started",
      taskId,
      planId,
      agentRole,
      message: `タスク ${taskId} の実行を開始（${agentRole}）`,
      timestamp: new Date().toISOString(),
    });
  }

  /** ノード開始イベント */
  emitNodeStarted(taskId: string, planId: string, nodeId: string, agentRole: string): void {
    this.emitStatus({
      type: "node_started",
      taskId,
      planId,
      nodeId,
      agentRole,
      message: `ノード ${nodeId}（${agentRole}）の実行を開始`,
      timestamp: new Date().toISOString(),
    });
  }

  /** ノード完了イベント */
  emitNodeCompleted(
    taskId: string,
    planId: string,
    nodeId: string,
    agentRole: string,
    data?: Record<string, unknown>,
  ): void {
    this.emitStatus({
      type: "node_completed",
      taskId,
      planId,
      nodeId,
      agentRole,
      message: `ノード ${nodeId}（${agentRole}）が完了`,
      data,
      timestamp: new Date().toISOString(),
    });
  }

  /** ノード失敗イベント */
  emitNodeFailed(taskId: string, planId: string, nodeId: string, agentRole: string, error: string): void {
    this.emitStatus({
      type: "node_failed",
      taskId,
      planId,
      nodeId,
      agentRole,
      message: `ノード ${nodeId}（${agentRole}）が失敗: ${error}`,
      data: { error },
      timestamp: new Date().toISOString(),
    });
  }

  /** タスク完了イベント */
  emitTaskCompleted(taskId: string, data?: Record<string, unknown>): void {
    this.emitStatus({
      type: "task_completed",
      taskId,
      message: `タスク ${taskId} が完了`,
      data,
      timestamp: new Date().toISOString(),
    });
  }

  /** タスク失敗イベント */
  emitTaskFailed(taskId: string, error: string): void {
    this.emitStatus({
      type: "task_failed",
      taskId,
      message: `タスク ${taskId} が失敗: ${error}`,
      data: { error },
      timestamp: new Date().toISOString(),
    });
  }

  /** 進捗イベント（ハートビート等） */
  emitProgress(taskId: string, message: string, data?: Record<string, unknown>): void {
    this.emitStatus({
      type: "task_progress",
      taskId,
      message,
      data,
      timestamp: new Date().toISOString(),
    });
  }
}
