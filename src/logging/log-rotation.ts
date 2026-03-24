import { readdirSync, statSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export function rotateOldLogs(logDir: string, retentionDays: number = 30): void {
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
    return;
  }

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const files = readdirSync(logDir);

  for (const file of files) {
    if (!file.endsWith(".jsonl")) {
      continue;
    }

    const filePath = join(logDir, file);
    const stat = statSync(filePath);

    if (stat.mtimeMs < cutoff) {
      unlinkSync(filePath);
    }
  }
}
