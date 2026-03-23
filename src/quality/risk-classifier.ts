import type { RiskLevel } from "../types/execution-plan.js";

/** セキュリティ関連ファイルのパターン */
const SECURITY_PATTERNS = [
  /auth/i,
  /permission/i,
  /credential/i,
  /security/i,
  /crypto/i,
  /token/i,
  /session/i,
  /password/i,
  /\.env/,
  /secret/i,
];

export interface RiskAssessment {
  level: RiskLevel;
  requiresCriticLoop: boolean;
  reasons: string[];
}

/**
 * タスク出力のリスクレベルを判定する。
 * 高リスクの場合は Generator-Critic Loop をトリガーする。
 */
export function assessRisk(input: {
  diffLines: number;
  changedFiles: string[];
  confidence?: number;
  qualityScore?: number;
}): RiskAssessment {
  const reasons: string[] = [];

  // diff サイズ
  if (input.diffLines > 300) {
    reasons.push(`大規模 diff（${input.diffLines} 行）`);
  } else if (input.diffLines > 100) {
    reasons.push(`中規模 diff（${input.diffLines} 行）`);
  }

  // セキュリティ関連ファイル
  const securityFiles = input.changedFiles.filter((f) =>
    SECURITY_PATTERNS.some((p) => p.test(f)),
  );
  if (securityFiles.length > 0) {
    reasons.push(`セキュリティ関連ファイルの変更: ${securityFiles.join(", ")}`);
  }

  // 信頼度スコア
  if (input.confidence !== undefined && input.confidence < 0.7) {
    reasons.push(`低信頼度（${(input.confidence * 100).toFixed(0)}%）`);
  }

  // 品質スコア
  if (input.qualityScore !== undefined && input.qualityScore < 80) {
    reasons.push(`品質スコア低（${input.qualityScore}/100）`);
  }

  // リスクレベル判定
  let level: RiskLevel;
  if (securityFiles.length > 0 || input.diffLines > 300 || (input.confidence !== undefined && input.confidence < 0.5)) {
    level = "high";
  } else if (input.diffLines > 100 || reasons.length >= 2) {
    level = "medium";
  } else {
    level = "low";
  }

  // Critic Loop は medium 以上でトリガー
  const requiresCriticLoop = level !== "low";

  return { level, requiresCriticLoop, reasons };
}
