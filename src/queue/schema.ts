import type Database from "better-sqlite3";

export function initSchema(db: Database.Database): void {
  // Note: WAL and foreign_keys are set in runMigrations() before transactions
  // When called directly (e.g., tests), set them here too
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
  } catch {
    // May fail inside a transaction — that's OK, caller handles it
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      task_type TEXT NOT NULL CHECK(task_type IN ('review','fix','build','document')),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      source TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 5 CHECK(priority BETWEEN 1 AND 10),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','in_progress','completed','failed','awaiting_approval','ci_checking','ci_passed','ci_fixing','ci_failed','planning','validating')),
      pr_number INTEGER,
      ci_fix_count INTEGER NOT NULL DEFAULT 0,
      result TEXT,
      cost_usd REAL NOT NULL DEFAULT 0,
      turns_used INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count <= 3),
      depends_on TEXT REFERENCES tasks(id),
      parent_task_id TEXT REFERENCES tasks(id),
      context_file TEXT,
      approval_pr_url TEXT,
      repo TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
    CREATE INDEX IF NOT EXISTS idx_tasks_depends_on ON tasks(depends_on);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
  `);
}
