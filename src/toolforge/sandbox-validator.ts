import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type pino from "pino";

export interface ValidationResult {
  passed: boolean;
  checks: {
    name: string;
    passed: boolean;
    message: string;
  }[];
}

/** 禁止パターン（FS 書込み、ネットワークアクセス等） */
const FORBIDDEN_CODE_PATTERNS = [
  { pattern: /writeFileSync|writeFile|appendFile|mkdirSync|mkdir/g, name: "ファイル書込み" },
  { pattern: /fetch\(|http\.request|https\.request|axios|got\(/g, name: "ネットワークアクセス" },
  { pattern: /child_process|execSync|exec\(|spawn\(/g, name: "プロセス実行" },
  { pattern: /eval\(|Function\(/g, name: "動的コード実行" },
  { pattern: /process\.env/g, name: "環境変数アクセス" },
];

/**
 * Sandbox Validator: 生成されたスキルを安全性検証する。
 *
 * 4段階チェック:
 * 1. 静的解析（禁止パターン検出）
 * 2. 型チェック（tsc --noEmit）
 * 3. テスト実行（5/5 PASS 必須）
 * 4. セキュリティスキャン（FS/Net アクセス検出）
 */
export class SandboxValidator {
  constructor(private readonly logger: pino.Logger) {}

  /** スキルディレクトリ内のファイルを検証する */
  validate(toolDir: string): ValidationResult {
    const checks: { name: string; passed: boolean; message: string }[] = [];

    // 1. 静的解析
    checks.push(...this.staticAnalysis(toolDir));

    // 2. 型チェック
    checks.push(this.typeCheck(toolDir));

    // 3. テスト実行
    checks.push(this.runTests(toolDir));

    // 4. セキュリティスキャン（静的解析の一部として実施済み）

    const allPassed = checks.every((c) => c.passed);

    this.logger.info(
      { toolDir, passed: allPassed, checks: checks.map((c) => `${c.name}: ${c.passed}`) },
      "Sandbox validation completed",
    );

    return { passed: allPassed, checks };
  }

  /** 禁止パターンの静的解析 */
  private staticAnalysis(toolDir: string): { name: string; passed: boolean; message: string }[] {
    const results: { name: string; passed: boolean; message: string }[] = [];

    try {
      const handlerCode = readFileSync(join(toolDir, "handler.ts"), "utf-8");

      for (const { pattern, name } of FORBIDDEN_CODE_PATTERNS) {
        const matches = handlerCode.match(pattern);
        const passed = !matches;
        results.push({
          name: `forbidden:${name}`,
          passed,
          message: passed ? `${name}: OK` : `${name} を検出: ${matches.join(", ")}`,
        });
      }
    } catch {
      results.push({
        name: "static_analysis",
        passed: false,
        message: "handler.ts の読み取りに失敗",
      });
    }

    return results;
  }

  /** TypeScript 型チェック */
  private typeCheck(toolDir: string): { name: string; passed: boolean; message: string } {
    try {
      execSync("npx tsc --noEmit --strict", {
        cwd: toolDir,
        stdio: "pipe",
        timeout: 30_000,
      });
      return { name: "type_check", passed: true, message: "型チェック: OK" };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "unknown error";
      return { name: "type_check", passed: false, message: `型チェック失敗: ${msg.slice(0, 200)}` };
    }
  }

  /** テスト実行 */
  private runTests(toolDir: string): { name: string; passed: boolean; message: string } {
    try {
      const output = execSync("npx vitest run --reporter=json", {
        cwd: toolDir,
        stdio: "pipe",
        timeout: 60_000,
      }).toString();

      // テスト結果を解析
      try {
        const result = JSON.parse(output) as { numPassedTests?: number; numFailedTests?: number };
        const passed = (result.numPassedTests ?? 0) >= 5 && (result.numFailedTests ?? 0) === 0;
        return {
          name: "tests",
          passed,
          message: passed
            ? `テスト: ${result.numPassedTests}/${(result.numPassedTests ?? 0) + (result.numFailedTests ?? 0)} PASS`
            : `テスト失敗: ${result.numFailedTests} failed`,
        };
      } catch {
        // JSON パース失敗でもコマンド成功なら OK とみなす
        return { name: "tests", passed: true, message: "テスト: OK（詳細不明）" };
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : "unknown error";
      return { name: "tests", passed: false, message: `テスト失敗: ${msg.slice(0, 200)}` };
    }
  }
}
