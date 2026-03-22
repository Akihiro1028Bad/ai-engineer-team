import type Database from "better-sqlite3";
import type { CreateTaskInput, Task, TaskStatus } from "../types.js";

interface UpdateData {
  result?: string;
  costUsd?: number;
  turnsUsed?: number;
  approvalPrUrl?: string;
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
      INSERT INTO tasks (id, task_type, title, description, source, priority, depends_on, parent_task_id)
      VALUES (@id, @taskType, @title, @description, @source, @priority, @dependsOn, @parentTaskId)
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
        .prepare("UPDATE tasks SET status = ?, approval_pr_url = ? WHERE id = ?")
        .run(status, data?.approvalPrUrl ?? null, id);
    } else if (status === "failed") {
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

  cancelPipelineSuccessors(parentTaskId: string, excludeId: string): void {
    this.db
      .prepare(
        "UPDATE tasks SET status = 'failed' WHERE parent_task_id = ? AND id != ? AND status IN ('pending', 'in_progress')",
      )
      .run(parentTaskId, excludeId);
  }

  recoverFromCrash(): void {
    const recover = this.db.transaction(() => {
      // First: mark tasks that would exceed retry limit as failed directly
      this.db.exec(`
        UPDATE tasks
        SET status = 'failed'
        WHERE status = 'in_progress' AND retry_count >= 3
      `);

      // Then: reset remaining in_progress → pending with retry+1
      this.db.exec(`
        UPDATE tasks
        SET status = 'pending',
            retry_count = retry_count + 1,
            started_at = NULL
        WHERE status = 'in_progress'
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
