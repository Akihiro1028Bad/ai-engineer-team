import type { ValidationCheck } from "../types/validation.js";

/** diff に含まれてはいけないパターン */
const FORBIDDEN_PATTERNS = [
  { pattern: /(?:ANTHROPIC_API_KEY|GITHUB_TOKEN|SECRET|PASSWORD|PRIVATE_KEY)\s*=\s*['"]\S+/i, name: "秘密情報の漏洩" },
  { pattern: /\.env\b/, name: ".env ファイルの追加" },
  { pattern: /credentials?\.json/i, name: "認証情報ファイルの追加" },
  { pattern: /-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----/, name: "秘密鍵の漏洩" },
];

/** 保護されたファイルパターン（削除禁止） */
const PROTECTED_FILE_PATTERNS = [
  /^\.github\/workflows\//,
  /^\.gitignore$/,
  /^LICENSE$/,
  /^package-lock\.json$/,
];

/** diff サイズ制限 */
const MAX_DIFF_LINES_PER_NODE = 500;
const MAX_DIFF_LINES_PER_PR = 1000;

export interface SafetyCheckInput {
  diff: string;
  diffLines: number;
  deletedFiles: string[];
  /** PR 全体の diff 行数（ノード単位ではなく累計） */
  totalPrDiffLines?: number;
}

/**
 * 静的安全チェック: 秘密情報漏洩、保護ファイル削除、diff サイズ制限、バイナリファイル検出。
 * AI 呼び出し不要（ルールベース）。
 */
export function runSafetyChecks(input: SafetyCheckInput): ValidationCheck[] {
  const checks: ValidationCheck[] = [];

  // 秘密情報チェック
  for (const { pattern, name } of FORBIDDEN_PATTERNS) {
    const found = pattern.test(input.diff);
    checks.push({
      name: `forbidden_pattern:${name}`,
      passed: !found,
      severity: found ? "error" : "info",
      message: found ? `差分に禁止パターンを検出: ${name}` : `${name}: OK`,
    });
  }

  // 保護ファイル削除チェック
  for (const file of input.deletedFiles) {
    const isProtected = PROTECTED_FILE_PATTERNS.some((p) => p.test(file));
    if (isProtected) {
      checks.push({
        name: `protected_file_deletion:${file}`,
        passed: false,
        severity: "error",
        message: `保護されたファイルの削除を検出: ${file}`,
      });
    }
  }

  // ノード単位 diff サイズ
  checks.push({
    name: "diff_size_per_node",
    passed: input.diffLines <= MAX_DIFF_LINES_PER_NODE,
    severity: input.diffLines > MAX_DIFF_LINES_PER_NODE ? "error" : "info",
    message: `diff 行数: ${input.diffLines}/${MAX_DIFF_LINES_PER_NODE}`,
  });

  // PR 全体 diff サイズ
  if (input.totalPrDiffLines !== undefined) {
    checks.push({
      name: "diff_size_per_pr",
      passed: input.totalPrDiffLines <= MAX_DIFF_LINES_PER_PR,
      severity: input.totalPrDiffLines > MAX_DIFF_LINES_PER_PR ? "error" : "info",
      message: `PR 累計 diff 行数: ${input.totalPrDiffLines}/${MAX_DIFF_LINES_PER_PR}`,
    });
  }

  // バイナリファイル検出
  const binaryPatterns = /Binary files? .* differ/;
  const hasBinary = binaryPatterns.test(input.diff);
  checks.push({
    name: "binary_file_detection",
    passed: !hasBinary,
    severity: hasBinary ? "warning" : "info",
    message: hasBinary ? "バイナリファイルの変更を検出" : "バイナリファイル: なし",
  });

  return checks;
}
