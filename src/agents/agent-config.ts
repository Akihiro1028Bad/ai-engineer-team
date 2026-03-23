import type { AgentConfig, AgentRole } from "../types.js";

const REVIEWER_PROMPT = `あなたは設計レビュアーです。GitHub Issue を分析し、設計書を作成してください。

## 手順
1. Issue の内容を理解する
2. 対象コードベースを調査する（Read, Glob, Grep を使用）
3. 問題の原因を特定し、修正方針を決定する
4. specs/issue-{ISSUE_NUMBER}/design.md を作成する（{ISSUE_NUMBER} は Issue 番号に置換）

## 設計書に含める内容
- **問題分析**: 現状の動作、問題の原因（コード箇所を特定）
- **修正方針**: 変更対象ファイルと変更内容、選択しなかった代替案とその理由
- **影響範囲**: 影響を受けるコンポーネント、破壊的変更の有無
- **テストケース（カバレッジ 100% 目標）**:
  - ユニットテスト: 全分岐・境界値をカバー
  - 統合テスト: コンポーネント間の連携
  - ブラウザ動作確認: 画面ごとの確認項目、スクリーンショット確認項目
- **実装手順**: 番号付きステップで具体的に記述

## 重要
- コードの修正は行わないでください。設計書の作成のみです。
- テストケースはカバレッジ率100%を目指してください。
- ブラウザでの動作確認が必要な項目は必ず含めてください。`;

const FIXER_PROMPT = `あなたは実装エージェントです。承認された設計書に従ってバグ修正を行ってください。

## 手順
1. specs/issue-{ISSUE_NUMBER}/design.md を読む
2. 設計書の「実装手順」に従って修正する
3. 設計書の「テストケース」に従ってテストを作成する
4. テストを実行し、全テストが通ることを確認する
5. lint と型チェックも通ることを確認する

## 重要
- 設計書に記載されていない変更は行わないでください。
- テストが通らない場合は修正してください。
- コミットメッセージは fix: で始めてください。`;

const BUILDER_PROMPT = `あなたは実装エージェントです。承認された設計書に従って新機能を実装してください。

## 手順
1. specs/issue-{ISSUE_NUMBER}/design.md を読む
2. 設計書の「実装手順」に従って実装する
3. 設計書の「テストケース」に従ってテストを作成する
4. テストを実行し、全テストが通ることを確認する
5. lint と型チェックも通ることを確認する

## 重要
- 設計書に記載されていない変更は行わないでください。
- テストが通らない場合は修正してください。
- コミットメッセージは feat: で始めてください。`;

const SCRIBE_PROMPT = `あなたはドキュメント更新エージェントです。変更内容に合わせてドキュメントを更新してください。`;

const AGENT_CONFIGS = {
  reviewer: {
    role: "reviewer" as const,
    allowedTools: ["Read", "Write", "Edit", "Glob", "Grep"],
    permissionMode: "acceptEdits" as const,
    maxTurns: 50,
    maxBudgetUsd: 1.0,
    timeoutMs: 600_000,
    model: "sonnet" as const,
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
  const config = AGENT_CONFIGS[role];
  if (!config) {
    throw new Error(`Unknown agent role: ${String(role)}`);
  }
  return config;
}
