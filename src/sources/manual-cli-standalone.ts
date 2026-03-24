import "dotenv/config";
import Database from "better-sqlite3";
import { runMigrations } from "../queue/migrations.js";
import { TaskQueue } from "../queue/task-queue.js";
import { parseAndPush } from "./manual-cli.js";

const db = new Database("tasks.db");
runMigrations(db);
const queue = new TaskQueue(db);

const args = process.argv.slice(2);
const result = parseAndPush(args, queue);

if (result.success) {
  console.log("Task added successfully.");
  // Show all pending tasks
  const pending = queue.getByStatus("pending");
  console.log(`Pending tasks: ${pending.length}`);
  for (const t of pending) {
    console.log(`  - ${t.id}: [${t.taskType}] ${t.title} (priority: ${t.priority})`);
  }
} else {
  console.error("Failed:", result.error);
  process.exit(1);
}
