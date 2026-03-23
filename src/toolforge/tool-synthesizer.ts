import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type pino from "pino";

import type { ToolGap } from "./gap-detector.js";

export interface SynthesizedTool {
  name: string;
  description: string;
  handlerCode: string;
  schemaCode: string;
  testCode: string;
  skillMd: string;
  safetyLevel: "read_only" | "write_local" | "write_external";
}

/**
 * Tool Synthesizer: Sonnet でスキル（ツール）を自動生成する。
 * 生成物: handler.ts, schema.ts, tests.ts, SKILL.md
 */
export class ToolSynthesizer {
  constructor(
    private readonly skillsDir: string,
    private readonly logger: pino.Logger,
  ) {}

  /** ToolGap からスキルを生成する */
  async synthesize(gap: ToolGap): Promise<SynthesizedTool | null> {
    try {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      let resultText: string | undefined;

      for await (const message of query({
        prompt: [
          "以下のツールギャップを解決するスキル（ツール）を生成してください。",
          "",
          `## ギャップ情報`,
          `- 名前: ${gap.suggestedToolName}`,
          `- 説明: ${gap.description}`,
          `- カテゴリ: ${gap.category}`,
          `- 発生回数: ${gap.occurrences}`,
          "",
          "## 生成ルール",
          "以下の4ファイルを生成してください。各ファイルは ```typescript で囲んでください。",
          "",
          "### 1. handler.ts",
          "- TypeScript で実装",
          "- export function handle(input: Input): Output",
          "- 外部ネットワークアクセス禁止",
          "- ファイルシステムアクセスは読み取りのみ",
          "",
          "### 2. schema.ts",
          "- Zod でスキーマ定義",
          "- Input と Output の型を export",
          "",
          "### 3. tests.ts",
          "- vitest を使用",
          "- 最低5つのテストケース",
          "",
          "### 4. SKILL.md",
          "```markdown",
          "---",
          "name: ツール名",
          "description: 1行の説明",
          "---",
          "使用方法と例",
          "```",
          "",
          "最後に safetyLevel を判定してください: read_only / write_local / write_external",
        ].join("\n"),
        options: {
          model: "sonnet",
          maxTurns: 10,
          maxBudgetUsd: 0.50,
          allowedTools: [],
          permissionMode: "dontAsk",
        },
      }) as AsyncIterable<{ type: string; result?: string }>) {
        if (message.type === "result") {
          resultText = message.result;
        }
      }

      if (!resultText) {
        this.logger.warn({ gap: gap.suggestedToolName }, "Tool synthesizer returned no result");
        return null;
      }

      return this.parseOutput(gap, resultText);
    } catch (error: unknown) {
      this.logger.error({ gap: gap.suggestedToolName, error }, "Tool synthesis failed");
      return null;
    }
  }

  /** 生成されたファイルをスキルディレクトリに書き込む */
  writeToDisk(tool: SynthesizedTool): string {
    const toolDir = join(this.skillsDir, "tools", tool.name);
    mkdirSync(toolDir, { recursive: true });

    writeFileSync(join(toolDir, "handler.ts"), tool.handlerCode, "utf-8");
    writeFileSync(join(toolDir, "schema.ts"), tool.schemaCode, "utf-8");
    writeFileSync(join(toolDir, "tests.ts"), tool.testCode, "utf-8");
    writeFileSync(join(toolDir, "SKILL.md"), tool.skillMd, "utf-8");
    writeFileSync(join(toolDir, "metadata.json"), JSON.stringify({
      name: tool.name,
      description: tool.description,
      safetyLevel: tool.safetyLevel,
      version: 1,
      createdBy: "toolforge",
      createdAt: new Date().toISOString(),
      usageCount: 0,
      successRate: 0,
      approvalStatus: tool.safetyLevel === "read_only" ? "approved" : "pending_review",
    }, null, 2), "utf-8");

    this.logger.info({ tool: tool.name, dir: toolDir }, "Tool written to disk");
    return toolDir;
  }

  /** Sonnet の出力からファイルを抽出する */
  private parseOutput(gap: ToolGap, output: string): SynthesizedTool | null {
    // ```typescript ブロックを抽出
    const codeBlocks = [...output.matchAll(/```(?:typescript|ts)\n([\s\S]*?)```/g)].map((m) => m[1]!);
    const mdBlocks = [...output.matchAll(/```markdown\n([\s\S]*?)```/g)].map((m) => m[1]!);

    if (codeBlocks.length < 3) {
      this.logger.warn({ gap: gap.suggestedToolName, blocks: codeBlocks.length }, "Insufficient code blocks");
      return null;
    }

    // safetyLevel を検出
    let safetyLevel: "read_only" | "write_local" | "write_external" = "read_only";
    if (/write_external/.test(output)) safetyLevel = "write_external";
    else if (/write_local/.test(output)) safetyLevel = "write_local";

    return {
      name: gap.suggestedToolName,
      description: gap.description,
      handlerCode: codeBlocks[0]!,
      schemaCode: codeBlocks[1]!,
      testCode: codeBlocks[2]!,
      skillMd: mdBlocks[0] ?? `---\nname: ${gap.suggestedToolName}\ndescription: ${gap.description}\n---\n`,
      safetyLevel,
    };
  }
}
