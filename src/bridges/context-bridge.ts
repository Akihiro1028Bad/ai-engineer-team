import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { HandoffSchema } from "../types.js";
import type { Handoff } from "../types.js";

function handoffPath(taskId: string, agent: string, dir: string): string {
  return join(dir, `${taskId}_${agent}.json`);
}

export function writeHandoff(handoff: Handoff, dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const filePath = handoffPath(handoff.taskId, handoff.agent, dir);
  writeFileSync(filePath, JSON.stringify(handoff, null, 2), "utf-8");
}

export function readHandoff(taskId: string, agent: string, dir: string): Handoff | null {
  const filePath = handoffPath(taskId, agent, dir);

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw: unknown = JSON.parse(readFileSync(filePath, "utf-8"));
    const result = HandoffSchema.safeParse(raw);
    if (!result.success) {
      return null;
    }
    return result.data;
  } catch {
    return null;
  }
}

export function buildPromptInsert(handoff: Handoff): string {
  return [
    `## 前のエージェント (${handoff.agent}) からの引き継ぎ情報`,
    `タスクID: ${handoff.taskId}`,
    `時刻: ${handoff.timestamp}`,
    "",
    JSON.stringify(handoff.data, null, 2),
  ].join("\n");
}
