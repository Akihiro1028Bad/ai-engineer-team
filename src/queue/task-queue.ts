import type Database from "better-sqlite3";
import type { CreateTaskInput, Task, TaskStatus } from "../types.js";

interface UpdateData {
  result?: string;
  costUsd?: number;
  turnsUsed?: number;
  approvalPrUrl?: string;
  prNumber?: number;
}

interface DailyDigest {
  completed: number;
  failed: number;
  totalCostUsd: number;
  avgDurationMs: number;
  pendingApprovals: number;
}

interface TaskRow {
  id: string;
  task_type: string;
  title: string;
  description: string;
  source: string;
  priority: number;
  status: string;
  result: string | null;
  cost_usd: number;
  turns_used: number;
  retry_count: number;
  depends_on: string | null;
  parent_task_id: string | null;
  context_file: string | null;
  approval_pr_url: string | null;
  pr_number: number | null;
  ci_fix_count: number;
  repo: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    taskType: row.task_type as Task["taskType"],
    title: row.title,
    description: row.description,
    source: row.source,
    priority: row.priority,
    status: row.status as TaskStatus,
    result: row.result,
    costUsd: row.cost_usd,
    turnsUsed: row.turns_used,
    retryCount: row.retry_count,
    dependsOn: row.depends_on,
    parentTaskId: row.parent_task_id,
    contextFile: row.context_file,
    approvalPrUrl: row.approval_pr_url,
    prNumber: row.pr_number,
    ciFixCount: row.ci_fix_count,
    repo: row.repo,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

export class TaskQueue {
  private readonly stmtInsert;
  private readonly stmtGetNext;
  private readonly stmtGetById;
  private readonly stmtGetByStatus;
  private readonly stmtGetAwaitingApproval;
  private readonly stmtIsDuplicate;

  constructor(private readonly db: Database.Database) {
    this.stmtInsert = db.prepare(`
      INSERT INTO tasks (id, task_type, title, description, source, priority, depends_on, parent_task_id, context_file, repo)
      VALUES (@id, @taskType, @title, @description, @source, @priority, @dependsOn, @parentTaskId, @contextFile, @repo)
    `);

    this.stmtGetNext = db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'pending'
        AND (depends_on IS NULL
             OR depends_on IN (SELECT id FROM tasks WHERE status = 'completed'))
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
    `);

    this.stmtGetById = db.prepare("SELECT * FROM tasks WHERE id = ?");
    this.stmtGetByStatus = db.prepare("SELECT * FROM tasks WHERE status = ?");
    this.stmtGetAwaitingApproval = db.prepare("SELECT * FROM tasks WHERE status = 'awaiting_approval'");
    this.stmtIsDuplicate = db.prepare("SELECT COUNT(*) as count FROM tasks WHERE source = ?");
  }

  push(input: CreateTaskInput): void {
    this.stmtInsert.run({
      id: input.id,
      taskType: input.taskType,
      title: input.title,
      description: input.description,
      source: input.source,
      priority: input.priority,
      dependsOn: input.dependsOn,
      parentTaskId: input.parentTaskId,
      contextFile: input.contextFile ?? null,
      repo: input.repo ?? null,
    });
  }

  pushPipeline(tasks: CreateTaskInput[]): void {
    const insertAll = this.db.transaction(() => {
      for (const task of tasks) {
        this.push(task);
      }
    });
    insertAll();
  }

  getNext(): Task | null {
    const row = this.stmtGetNext.get() as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  getById(id: string): Task | undefined {
    const row = this.stmtGetById.get(id) as TaskRow | undefined;
    return row ? rowToTask(row) : undefined;
  }

  getByStatus(status: TaskStatus): Task[] {
    const rows = this.stmtGetByStatus.all(status) as TaskRow[];
    return rows.map(rowToTask);
  }

  getAwaitingApproval(): Task[] {
    const rows = this.stmtGetAwaitingApproval.all() as TaskRow[];
    return rows.map(rowToTask);
  }

  updateStatus(id: string, status: TaskStatus, data?: UpdateData): void {
    const now = new Date().toISOString();

    if (status === "in_progress") {
      this.db.prepare("UPDATE tasks SET status = ?, started_at = ? WHERE id = ?").run(status, now, id);
    } else if (status === "completed") {
      this.db
        .prepare(
          "UPDATE tasks SET status = ?, result = ?, cost_usd = ?, turns_used = ?, completed_at = ? WHERE id = ?",
        )
        .run(status, data?.result ?? null, data?.costUsd ?? 0, data?.turnsUsed ?? 0, now, id);
    } else if (status === "awaiting_approval") {
      this.db
        .prepare("UPDATE tasks SET status = ?, approval_pr_url = ?, result = ?, cost_usd = ?, turns_used = ? WHERE id = ?")
        .run(status, data?.approvalPrUrl ?? null, data?.result ?? null, data?.costUsd ?? 0, data?.turnsUsed ?? 0, id);
    } else if (status === "ci_checking") {
      this.db
        .prepare("UPDATE tasks SET status = ?, pr_number = ? WHERE id = ?")
        .run(status, data?.prNumber ?? null, id);
    } else if (status === "ci_fixing") {
      this.db
        .prepare("UPDATE tasks SET status = ?, ci_fix_count = ci_fix_count + 1 WHERE id = ?")
        .run(status, id);
    } else if (status === "failed" || status === "ci_failed") {
      this.db.prepare("UPDATE tasks SET status = ?, completed_at = ? WHERE id = ?").run(status, now, id);
    } else {
      this.db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(status, id);
    }
  }

  retryTask(id: string): void {
    const task = this.getById(id);
    if (!task) return;

    const newRetryCount = task.retryCount + 1;
    if (newRetryCount > 3) {
      this.updateStatus(id, "failed");
    } else {
      this.db
        .prepare("UPDATE tasks SET status = 'pending', retry_count = ?, started_at = NULL WHERE id = ?")
        .run(newRetryCount, id);
    }
  }

  approveTask(id: string): void {
    this.updateStatus(id, "completed");
  }

  rejectTask(id: string): void {
    const task = this.getById(id);
    this.updateStatus(id, "failed");
    if (task?.parentTaskId) {
      this.cancelPipelineSuccessors(task.parentTaskId, id);
    }
  }

  failTask(id: string, reason: string): void {
    const task = this.getById(id);
    this.updateStatus(id, "failed", { result: reason });
    if (task?.parentTaskId) {
      this.cancelPipelineSuccessors(task.parentTaskId, id);
    }
  }

  recoverStuckTasks(stuckThresholdMs: number = 60 * 60 * 1000): number {
    const cutoff = new Date(Date.now() - stuckThresholdMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE tasks SET status = 'failed', result = 'Stuck task detected (exceeded timeout threshold)'
         WHERE status IN ('in_progress', 'planning', 'validating')
           AND started_at IS NOT NULL AND started_at < ?`,
      )
      .run(cutoff);
    return result.changes;
  }

  recoverStaleApprovals(staleThresholdMs: number = 7 * 24 * 60 * 60 * 1000): number {
    const cutoff = new Date(Date.now() - staleThresholdMs).toISOString();
    const result = this.db
      .prepare(
        `UPDATE tasks SET status = 'failed', result = 'Stale approval — exceeded waiting threshold'
         WHERE status = 'awaiting_approval'
           AND started_at IS NOT NULL AND started_at < ?`,
      )
      .run(cutoff);
    return result.changes;
  }

  cancelPipelineSuccessors(parentTaskId: string, excludeId: string): void {
    this.db
      .prepare(
        "UPDATE tasks SET status = 'failed' WHERE parent_task_id = ? AND id != ? AND status IN ('pending', 'in_progress')",
      )
      .run(parentTaskId, excludeId);
  }

  recoverFromCrash(): void {
    const recover = this.db.transaction(() => {
      // Mark tasks that would exceed retry limit as failed
      this.db.exec(`
        UPDATE tasks
        SET status = 'failed'
        WHERE status IN ('in_progress', 'planning', 'validating') AND retry_count >= 3
      `);

      // Reset remaining stuck tasks → pending with retry+1
      // Note: awaiting_approval is NOT reset (it's a valid long-lived state)
      this.db.exec(`
        UPDATE tasks
        SET status = 'pending',
            retry_count = retry_count + 1,
            started_at = NULL
        WHERE status IN ('in_progress', 'planning', 'validating')
      `);
    });
    recover();
  }

  isDuplicate(source: string): boolean {
    const row = this.stmtIsDuplicate.get(source) as { count: number };
    return row.count > 0;
  }

  getDailyDigest(): DailyDigest {
    const completed = (
      this.db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'completed'").get() as {
        count: number;
      }
    ).count;

    const failed = (
      this.db.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'failed'").get() as {
        count: number;
      }
    ).count;

    const costRow = this.db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) as total FROM tasks WHERE status = 'completed'")
      .get() as { total: number };

    const pendingApprovals = (
      this.db
        .prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'awaiting_approval'")
        .get() as { count: number }
    ).count;

    return {
      completed,
      failed,
      totalCostUsd: costRow.total,
      avgDurationMs: 0,
      pendingApprovals,
    };
  }
}
