import type Database from "better-sqlite3";
import { initSchema } from "./schema.js";

interface Migration {
  version: number;
  description: string;
  up: (db: Database.Database) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Initial schema",
    up: (db) => {
      initSchema(db);
    },
  },
  {
    version: 2,
    description: "v3.0: Execution plans, eval records, pattern memory",
    up: (db) => {
      // tasks テーブルに v3.0 カラム追加
      db.exec(`
        ALTER TABLE tasks ADD COLUMN execution_plan_id TEXT DEFAULT NULL;
        ALTER TABLE tasks ADD COLUMN dag_node_id TEXT DEFAULT NULL;
        ALTER TABLE tasks ADD COLUMN validation_status TEXT DEFAULT NULL;
        ALTER TABLE tasks ADD COLUMN model_used TEXT DEFAULT NULL;
      `);
      // repo column is now part of the base schema (initSchema);
      // add it only if missing (for databases created before repo was in base schema)
      try {
        db.exec(`ALTER TABLE tasks ADD COLUMN repo TEXT DEFAULT NULL;`);
      } catch {
        // Column already exists — ignore
      }

      // Execution Plans テーブル
      db.exec(`
        CREATE TABLE IF NOT EXISTS execution_plans (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          issue_number INTEGER,
          repo TEXT,
          plan_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft',
          estimated_cost_usd REAL DEFAULT 0,
          estimated_duration_ms INTEGER DEFAULT 0,
          actual_cost_usd REAL DEFAULT 0,
          risk_level TEXT DEFAULT 'low',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_plans_task ON execution_plans(task_id);
        CREATE INDEX IF NOT EXISTS idx_plans_status ON execution_plans(status);
      `);

      // Eval Records テーブル
      db.exec(`
        CREATE TABLE IF NOT EXISTS eval_records (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          plan_id TEXT,
          node_id TEXT,
          repo TEXT,
          agent_role TEXT NOT NULL,
          model TEXT NOT NULL,
          cost_usd REAL NOT NULL DEFAULT 0,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          turns_used INTEGER NOT NULL DEFAULT 0,
          success INTEGER NOT NULL DEFAULT 0,
          quality_score REAL,
          diff_lines INTEGER,
          file_count INTEGER,
          failure_category TEXT,
          issue_labels TEXT DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_eval_agent ON eval_records(agent_role);
        CREATE INDEX IF NOT EXISTS idx_eval_task ON eval_records(task_id);
        CREATE INDEX IF NOT EXISTS idx_eval_repo ON eval_records(repo);
        CREATE INDEX IF NOT EXISTS idx_eval_success ON eval_records(success);
      `);

      // Pattern Memory テーブル
      db.exec(`
        CREATE TABLE IF NOT EXISTS pattern_memory (
          id TEXT PRIMARY KEY,
          repo TEXT,
          agent_role TEXT NOT NULL,
          model TEXT NOT NULL,
          task_type TEXT NOT NULL,
          success_rate REAL NOT NULL DEFAULT 0,
          avg_cost_usd REAL NOT NULL DEFAULT 0,
          avg_duration_ms REAL NOT NULL DEFAULT 0,
          avg_quality_score REAL,
          sample_count INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_pattern_role ON pattern_memory(agent_role, task_type);
        CREATE INDEX IF NOT EXISTS idx_pattern_repo ON pattern_memory(repo);
      `);

      // Feedback Learnings テーブル
      db.exec(`
        CREATE TABLE IF NOT EXISTS feedback_learnings (
          id TEXT PRIMARY KEY,
          repo TEXT,
          pr_number INTEGER NOT NULL,
          feedback_type TEXT NOT NULL,
          feedback_content TEXT NOT NULL,
          agent_role TEXT NOT NULL,
          resolution TEXT NOT NULL DEFAULT 'applied',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_feedback_repo ON feedback_learnings(repo);
        CREATE INDEX IF NOT EXISTS idx_feedback_type ON feedback_learnings(feedback_type);
      `);

      // Handoff Reports テーブル
      db.exec(`
        CREATE TABLE IF NOT EXISTS handoff_reports (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL,
          from_node_id TEXT NOT NULL,
          to_node_id TEXT NOT NULL,
          from_agent TEXT NOT NULL,
          to_agent TEXT NOT NULL,
          summary TEXT NOT NULL,
          report_json TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_handoff_plan ON handoff_reports(plan_id);
      `);
    },
  },
  {
    version: 3,
    description: "v3.0: Add planning/validating status, repo column to tasks CHECK constraint",
    up: (db) => {
      // SQLite does not support ALTER TABLE ... ALTER CONSTRAINT.
      // Recreate the tasks table with the updated CHECK constraint.
      db.exec(`
        CREATE TABLE IF NOT EXISTS tasks_new (
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
          depends_on TEXT REFERENCES tasks_new(id),
          parent_task_id TEXT REFERENCES tasks_new(id),
          context_file TEXT,
          approval_pr_url TEXT,
          execution_plan_id TEXT,
          dag_node_id TEXT,
          validation_status TEXT,
          model_used TEXT,
          repo TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          started_at TEXT,
          completed_at TEXT
        );

        INSERT INTO tasks_new SELECT
          id, task_type, title, description, source, priority, status,
          pr_number, ci_fix_count, result, cost_usd, turns_used, retry_count,
          depends_on, parent_task_id, context_file, approval_pr_url,
          execution_plan_id, dag_node_id, validation_status, model_used, repo,
          created_at, started_at, completed_at
        FROM tasks;

        DROP TABLE tasks;
        ALTER TABLE tasks_new RENAME TO tasks;

        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
        CREATE INDEX IF NOT EXISTS idx_tasks_depends_on ON tasks(depends_on);
        CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
      `);
    },
  },
];

export function runMigrations(db: Database.Database): void {
  // WAL must be set outside any transaction
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const currentRow = db
    .prepare("SELECT MAX(version) as version FROM schema_version")
    .get() as { version: number | null };
  const currentVersion = currentRow.version ?? 0;

  const pending = MIGRATIONS.filter((m) => m.version > currentVersion);

  for (const migration of pending) {
    const applyMigration = db.transaction(() => {
      migration.up(db);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(migration.version);
    });
    applyMigration();
  }
}
