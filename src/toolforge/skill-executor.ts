import { execSync } from "node:child_process";
import { join, resolve } from "node:path";

import type pino from "pino";

import type { SkillRegistry } from "./skill-registry.js";

export interface ExecutionResult {
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

/** サンドボックス実行のタイムアウト */
const EXECUTION_TIMEOUT_MS = 30_000;

/**
 * Skill Executor: 生成されたスキルをサンドボックス内で実行する。
 * サブプロセス + 制限 PATH + タイムアウトで安全性を確保。
 */
export class SkillExecutor {
  constructor(
    private readonly skillsDir: string,
    private readonly registry: SkillRegistry,
    private readonly logger: pino.Logger,
  ) {}

  /** スキルを実行する */
  execute(skillName: string, input: unknown): ExecutionResult {
    const skill = this.registry.get(skillName);
    if (!skill) {
      return { success: false, output: "", error: `Skill not found: ${skillName}`, durationMs: 0 };
    }

    if (skill.approvalStatus !== "approved") {
      return { success: false, output: "", error: `Skill not approved: ${skillName} (status: ${skill.approvalStatus})`, durationMs: 0 };
    }

    const toolDir = resolve(join(this.skillsDir, "tools", skillName));
    const handlerPath = join(toolDir, "handler.ts");
    const startTime = Date.now();

    try {
      // サンドボックス環境でスキルを実行
      const inputJson = JSON.stringify(input);
      const script = `
        const { handle } = require("${handlerPath.replace(/\\/g, "/")}");
        const input = ${inputJson};
        const result = handle(input);
        console.log(JSON.stringify(result));
      `;

      const output = execSync(`node -e '${script.replace(/'/g, "\\'")}'`, {
        cwd: toolDir,
        timeout: EXECUTION_TIMEOUT_MS,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          // 最小限の環境変数のみ
          PATH: "/usr/bin:/bin:/usr/local/bin",
          NODE_PATH: join(toolDir, "node_modules"),
          HOME: "/tmp",
        },
      }).toString().trim();

      const durationMs = Date.now() - startTime;

      // 成功を記録
      this.registry.recordUsage(skillName, true);

      this.logger.info({ skill: skillName, durationMs }, "Skill executed successfully");
      return { success: true, output, durationMs };
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      const message = error instanceof Error ? error.message : "Unknown error";
      const isTimeout = message.includes("TIMEOUT") || message.includes("killed");

      // 失敗を記録
      this.registry.recordUsage(skillName, false);

      this.logger.warn({ skill: skillName, error: message, isTimeout, durationMs }, "Skill execution failed");
      return {
        success: false,
        output: "",
        error: isTimeout ? `Timeout after ${EXECUTION_TIMEOUT_MS}ms` : message,
        durationMs,
      };
    }
  }
}
