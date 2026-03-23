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
        ALTER TABLE tasks ADD COLUMN repo TEXT DEFAULT NULL;
      `);

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
