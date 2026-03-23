import type pino from "pino";

import type { ValidationResult, ValidationCheck } from "../types/validation.js";
import { runSafetyChecks } from "./safety-checks.js";

interface ValidationInput {
  nodeId: string;
  planId: string;
  /** エージェントの構造化出力 */
  structuredOutput?: unknown;
  /** エージェントのテキスト出力 (result フィールド) */
  result?: string;
  /** 期待される Zod スキーマの safeParse 関数 */
  schemaParse?: (data: unknown) => { success: boolean; error?: { message: string } };
  /** diff テキスト */
  diff?: string;
  diffLines?: number;
  deletedFiles?: string[];
  totalPrDiffLines?: number;
}

/**
 * Validation Gate: 全ノード間ハンドオフに適用される軽量検証。
 * 4段階チェック:
 * 1. スキーマ検証（Zod safeParse）
 * 2. 完全性チェック（出力が空でないか）
 * 3. 一貫性チェック（将来的に Haiku で意味的チェック）
 * 4. 安全性チェック（ルールベース）
 */
export class ValidationGate {
  constructor(private readonly logger: pino.Logger) {}

  /** ノード出力を検証する */
  validate(input: ValidationInput): ValidationResult {
    const checks: ValidationCheck[] = [];

    // 1. スキーマ検証
    if (input.schemaParse && input.structuredOutput) {
      const result = input.schemaParse(input.structuredOutput);
      checks.push({
        name: "schema_validation",
        passed: result.success,
        severity: result.success ? "info" : "error",
        message: result.success ? "スキーマ検証: OK" : `スキーマ検証失敗: ${result.error?.message ?? "unknown"}`,
      });
    }

    // 2. 完全性チェック（構造化出力 or テキスト結果のいずれかがあれば OK）
    const hasStructuredOutput = input.structuredOutput !== null && input.structuredOutput !== undefined;
    const hasTextResult = typeof input.result === "string" && input.result.length > 0;
    const hasOutput = hasStructuredOutput || hasTextResult;
    checks.push({
      name: "completeness",
      passed: hasOutput,
      severity: hasOutput ? "info" : "error",
      message: hasOutput ? "出力の完全性: OK" : "出力が空です",
    });

    // 3. 安全性チェック（diff がある場合）
    if (input.diff) {
      const safetyChecks = runSafetyChecks({
        diff: input.diff,
        diffLines: input.diffLines ?? 0,
        deletedFiles: input.deletedFiles ?? [],
        totalPrDiffLines: input.totalPrDiffLines,
      });
      checks.push(...safetyChecks);
    }

    // 全体の合否判定
    const hasErrors = checks.some((c) => !c.passed && c.severity === "error");
    const errorCount = checks.filter((c) => !c.passed && c.severity === "error").length;
    const warningCount = checks.filter((c) => !c.passed && c.severity === "warning").length;

    // 信頼度: エラー 0 = 1.0、エラーあり = (通過数/全数)
    const totalChecks = checks.length;
    const passedChecks = checks.filter((c) => c.passed).length;
    const confidence = totalChecks > 0 ? passedChecks / totalChecks : 0;

    const result: ValidationResult = {
      nodeId: input.nodeId,
      planId: input.planId,
      passed: !hasErrors,
      checks,
      confidence,
      timestamp: new Date().toISOString(),
    };

    this.logger.info(
      { nodeId: input.nodeId, passed: result.passed, errors: errorCount, warnings: warningCount, confidence },
      "Validation gate result",
    );

    return result;
  }
}
