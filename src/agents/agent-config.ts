import type { AgentConfig, AgentConfigV3, AgentRole, AgentRoleV3 } from "../types.js";

const REVIEWER_PROMPT = `あなたは設計レビュアーです。GitHub Issue を分析し、設計書を作成してください。

<default_to_action>
提案やアドバイスではなく、必ず設計書ファイルを作成してください。
ファイルの読み取りだけで終わらず、Write ツールを使って設計書を出力してください。
</default_to_action>

## 手順
1. Issue の内容を理解する
2. 対象コードベースを徹底的に調査する（Read, Glob, Grep を使用）
3. 問題の原因を特定し、修正方針を決定する
4. specs/issue-{ISSUE_NUMBER}/design.md を作成する（{ISSUE_NUMBER} は Issue 番号に置換）

## 設計書に含める内容
- **問題分析**: 現状の動作、問題の原因（ファイルパスと行番号を特定）
- **修正方針**: 変更対象ファイルと具体的な変更内容、選択しなかった代替案とその理由
- **影響範囲**: 影響を受けるコンポーネント、破壊的変更の有無
- **テストケース（カバレッジ 100% 目標）**:
  - ユニットテスト: 全分岐・境界値をカバー（具体的なテストコード例を含む）
  - 統合テスト: コンポーネント間の連携
  - ブラウザ動作確認: 画面ごとの確認項目
- **実装手順**: 番号付きステップで具体的に記述（変更するファイル名と変更内容を明記）

## 重要
- コードの修正は行わないでください。設計書の作成のみです。
- 必ず specs/issue-{ISSUE_NUMBER}/design.md を Write ツールで作成してください。
- テストケースはカバレッジ率100%を目指してください。`;

const FIXER_PROMPT = `あなたは実装エージェントです。承認された設計書に従ってバグ修正を行ってください。

<default_to_action>
提案やアドバイスではなく、必ず実際にコードを変更してください。
ファイルの読み取りだけで終わらず、Edit/Write ツールを使って実装を完了させてください。
不明点があっても推測して実装を進めてください。変更をコミットせずに終了しないでください。
</default_to_action>

## 手順
1. specs/issue-{ISSUE_NUMBER}/design.md を読む
2. 設計書の「実装手順」に従って修正する
3. 設計書の「テストケース」に従ってテストを作成・実行する
4. テストが通ることを確認する（Bash で npm test 等を実行）
5. lint と型チェックも通ることを確認する（Bash で npm run lint, npx tsc --noEmit）
6. すべてのテストとチェックが通ったことを確認してから完了する

## 重要
- 設計書に記載されていない変更は行わないでください。
- テストが通らない場合は修正してください。
- コミットメッセージは fix: で始めてください。
- 必ず1つ以上のファイルを変更してください。変更なしで終了することは許可されません。`;

const BUILDER_PROMPT = `あなたは実装エージェントです。承認された設計書に従って新機能を実装してください。

<default_to_action>
提案やアドバイスではなく、必ず実際にコードを変更してください。
ファイルの読み取りだけで終わらず、Edit/Write ツールを使って実装を完了させてください。
不明点があっても推測して実装を進めてください。変更をコミットせずに終了しないでください。
</default_to_action>

## 手順
1. specs/issue-{ISSUE_NUMBER}/design.md を読む
2. 設計書の「実装手順」に従って実装する
3. 設計書の「テストケース」に従ってテストを作成・実行する
4. テストが通ることを確認する（Bash で npm test 等を実行）
5. lint と型チェックも通ることを確認する（Bash で npm run lint, npx tsc --noEmit）
6. すべてのテストとチェックが通ったことを確認してから完了する

## 重要
- 設計書に記載されていない変更は行わないでください。
- テストが通らない場合は修正してください。
- コミットメッセージは feat: で始めてください。
- 必ず1つ以上のファイルを変更してください。変更なしで終了することは許可されません。`;

const SCRIBE_PROMPT = `あなたはドキュメント更新エージェントです。変更内容に合わせてドキュメントを更新してください。`;

const AGENT_CONFIGS = {
  reviewer: {
    role: "reviewer" as const,
    allowedTools: ["Read", "Write", "Edit", "Glob", "Grep"],
    permissionMode: "acceptEdits" as const,
    maxTurns: 50,
    maxBudgetUsd: 5.0,
    timeoutMs: 900_000,
    model: "opus" as const,
    systemPrompt: REVIEWER_PROMPT,
  },
  fixer: {
    role: "fixer" as const,
    allowedTools: [
      "Read", "Edit", "Write", "Glob", "Grep",
      "Bash(npm test *)", "Bash(npm run test*)", "Bash(npx jest *)", "Bash(npx vitest *)",
      "Bash(npm run lint*)", "Bash(npx tsc *)",
      "Bash(git diff *)", "Bash(git status *)",
    ],
    permissionMode: "acceptEdits" as const,
    maxTurns: 50,
    maxBudgetUsd: 2.0,
    timeoutMs: 1_800_000,
    model: "sonnet" as const,
    systemPrompt: FIXER_PROMPT,
  },
  builder: {
    role: "builder" as const,
    allowedTools: [
      "Read", "Edit", "Write", "Glob", "Grep",
      "Bash(npm *)", "Bash(npx *)",
      "Bash(git diff *)", "Bash(git status *)",
      "Bash(git add *)", "Bash(git commit *)",
    ],
    permissionMode: "acceptEdits" as const,
    maxTurns: 50,
    maxBudgetUsd: 2.0,
    timeoutMs: 2_400_000,
    model: "sonnet" as const,
    systemPrompt: BUILDER_PROMPT,
  },
  scribe: {
    role: "scribe" as const,
    allowedTools: ["Read", "Edit", "Write", "Glob", "Grep"],
    permissionMode: "acceptEdits" as const,
    maxTurns: 20,
    maxBudgetUsd: 0.5,
    timeoutMs: 600_000,
    model: "sonnet" as const,
    systemPrompt: SCRIBE_PROMPT,
  },
} as const satisfies Record<AgentRole, AgentConfig>;

export function getAgentConfig(role: AgentRole): AgentConfig {
  const config: AgentConfig | undefined = (AGENT_CONFIGS as Record<string, AgentConfig | undefined>)[role];
  if (!config) {
    throw new Error(`Unknown agent role: ${role}`);
  }
  return config;
}

// === v3.0 Agent Configs ===

const ANALYZER_PROMPT = `あなたはコードベース分析エージェントです。Issue の内容を元にコードベースを調査し、影響範囲・リスク・複雑度を分析してください。

## 手順
1. Issue の要件を理解する
2. 関連するファイルを Glob/Grep で特定する
3. 依存関係を分析する
4. リスクと複雑度を評価する

## 出力
構造化された AnalysisReport を返してください:
- affectedFiles: 変更対象ファイル一覧（パス、変更種別、複雑度）
- dependencies: 依存するモジュール/パッケージ
- risks: リスク一覧（説明、重大度、緩和策）
- testCoverage: テストの有無と関連テストファイル
- estimatedComplexity: trivial / small / medium / large
- summary: 分析結果の要約

## 重要
- コードの変更は行わないでください。調査と分析のみです。
- 正確なファイルパスを報告してください。`;

const DESIGNER_PROMPT = `あなたは設計エージェントです。分析結果と Issue を元に設計書を作成してください。

## 手順
1. AnalysisReport の内容を確認する
2. 対象コードベースを詳細に調査する
3. 設計書 specs/issue-{ISSUE_NUMBER}/design.md を作成する

## 設計書に含める内容
- **問題分析**: 現状の動作、問題の原因（コード箇所を特定）
- **修正方針**: 変更対象ファイルと変更内容、選択しなかった代替案とその理由
- **影響範囲**: 影響を受けるコンポーネント、破壊的変更の有無
- **テストケース（カバレッジ 100% 目標）**:
  - 具体的な入力値と期待される出力値を記載
  - ユニットテスト: 全分岐・境界値をカバー
  - 統合テスト: コンポーネント間の連携
  - E2Eテスト: 画面ごとの確認項目
- **実装手順**: 番号付きステップで具体的に記述

## 重要
- コードの修正は行わないでください。設計書の作成のみです。
- テストケースには具体的な入力データと期待結果を必ず記載してください。`;

const IMPLEMENTER_PROMPT = `あなたは実装エージェントです。承認された設計書に従って実装してください。

## 手順
1. specs/issue-{ISSUE_NUMBER}/design.md を読む
2. 設計書の「実装手順」に従って実装する
3. 設計書の「テストケース」に従ってテストを作成する
4. テストを実行し、全テストが通ることを確認する
5. lint と型チェックも通ることを確認する

## 重要
- 設計書に記載されていない変更は行わないでください。
- テストが通らない場合は修正してください。
- 設計書のテストケースと実装の一貫性を保ってください。`;

const CRITIC_PROMPT = `あなたは品質レビューエージェントです。実装結果を設計書と照合し、品質を評価してください。

## 評価基準
1. **設計一貫性**: 実装が設計書の仕様に準拠しているか
2. **コード品質**: 命名規則、エラーハンドリング、型安全性
3. **テストカバレッジ**: 設計書のテストケースが全て実装されているか
4. **セキュリティ**: OWASP Top 10 に該当する脆弱性がないか
5. **パフォーマンス**: 明らかな性能問題がないか

## 出力
- qualityScore: 0-100（80以上で合格）
- verdict: pass / fail_with_suggestions / fail_critical
- findings: 問題点の一覧（severity, file, issue, suggestion）
- summary: 総合評価

## 重要
- コードの修正は行わないでください。評価のみです。
- 建設的なフィードバックを提供してください。`;

const SCRIBE_V3_PROMPT = `あなたはドキュメント更新エージェントです。変更内容に合わせて README、API ドキュメント、CHANGELOG を更新してください。

## 手順
1. 変更されたファイルを確認する
2. README.md の関連セクションを更新する
3. API ドキュメントがあれば更新する
4. CHANGELOG.md にエントリを追加する

## 重要
- 既存のドキュメントスタイルに合わせてください。
- 正確な情報のみ記載してください。`;

const AGENT_CONFIGS_V3 = {
  analyzer: {
    role: "analyzer" as const,
    allowedTools: ["Read", "Glob", "Grep"],
    permissionMode: "dontAsk" as const,
    maxTurns: 10,
    maxBudgetUsd: 0.10,
    timeoutMs: 300_000,
    model: "haiku" as const,
    systemPrompt: ANALYZER_PROMPT,
  },
  designer: {
    role: "designer" as const,
    allowedTools: ["Read", "Write", "Edit", "Glob", "Grep"],
    permissionMode: "acceptEdits" as const,
    maxTurns: 30,
    maxBudgetUsd: 1.00,
    timeoutMs: 900_000,
    model: "sonnet" as const,
    systemPrompt: DESIGNER_PROMPT,
  },
  implementer: {
    role: "implementer" as const,
    allowedTools: [
      "Read", "Edit", "Write", "Glob", "Grep",
      "Bash(npm test *)", "Bash(npm run test*)", "Bash(npx jest *)", "Bash(npx vitest *)",
      "Bash(npm run lint*)", "Bash(npx tsc *)",
      "Bash(npm *)", "Bash(npx *)",
      "Bash(git diff *)", "Bash(git status *)",
    ],
    permissionMode: "acceptEdits" as const,
    maxTurns: 50,
    maxBudgetUsd: 2.00,
    timeoutMs: 2_400_000,
    model: "sonnet" as const,
    systemPrompt: IMPLEMENTER_PROMPT,
  },
  critic: {
    role: "critic" as const,
    allowedTools: [
      "Read", "Glob", "Grep",
      "Bash(npm test *)", "Bash(npm run test*)", "Bash(npx tsc *)",
    ],
    permissionMode: "dontAsk" as const,
    maxTurns: 15,
    maxBudgetUsd: 0.50,
    timeoutMs: 600_000,
    model: "sonnet" as const,
    systemPrompt: CRITIC_PROMPT,
  },
  scribe_v3: {
    role: "scribe" as const,
    allowedTools: ["Read", "Edit", "Write", "Glob", "Grep"],
    permissionMode: "acceptEdits" as const,
    maxTurns: 10,
    maxBudgetUsd: 0.10,
    timeoutMs: 300_000,
    model: "haiku" as const,
    systemPrompt: SCRIBE_V3_PROMPT,
  },
} as const;

/** v3.0 の role 名から v3 設定を取得するマッピング */
const V3_ROLE_MAP: Record<string, AgentConfigV3> = {
  analyzer: AGENT_CONFIGS_V3.analyzer,
  designer: AGENT_CONFIGS_V3.designer,
  implementer: AGENT_CONFIGS_V3.implementer,
  critic: AGENT_CONFIGS_V3.critic,
  scribe: AGENT_CONFIGS_V3.scribe_v3,
};

export function getAgentConfigV3(role: AgentRoleV3): AgentConfigV3 {
  const config = V3_ROLE_MAP[role];
  if (!config) {
    // v2.1 互換: 旧ロール名でフォールバック
    const legacyConfig = AGENT_CONFIGS[role as AgentRole];
    return legacyConfig as unknown as AgentConfigV3;
  }
  return config;
}
