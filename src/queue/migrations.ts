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
];

export function runMigrations(db: Database.Database): void {
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
