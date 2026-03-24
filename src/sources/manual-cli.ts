import { TaskTypeSchema } from "../types.js";
import type { TaskQueue } from "../queue/task-queue.js";

let counter = 0;

interface ParseResult {
  success: boolean;
  error?: string;
}

function parseArgs(args: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg.startsWith("--") && i + 1 < args.length) {
      map.set(arg.slice(2), args[i + 1] ?? "");
      i++;
    }
  }
  return map;
}

export function parseAndPush(args: string[], queue: TaskQueue): ParseResult {
  const parsed = parseArgs(args);

  const type = parsed.get("type");
  const title = parsed.get("title");
  const description = parsed.get("description");

  if (!type) return { success: false, error: "--type is required" };
  if (!title) return { success: false, error: "--title is required" };
  if (!description) return { success: false, error: "--description is required" };

  const typeResult = TaskTypeSchema.safeParse(type);
  if (!typeResult.success) {
    return { success: false, error: `Invalid task type: ${type}` };
  }

  const priority = parsed.get("priority") ? Number(parsed.get("priority")) : 5;
  const dependsOn = parsed.get("depends-on") ?? null;
  const repo = parsed.get("repo") ?? null;

  counter += 1;
  const id = `manual-${counter}`;

  queue.push({
    id,
    taskType: typeResult.data,
    title,
    description,
    source: "manual",
    priority,
    dependsOn,
    parentTaskId: null,
    repo,
  });

  return { success: true };
}
