# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

4つの専門AIエージェント（Reviewer, Fixer, Builder, Scribe）を24時間稼働のWindows PC + WSL2上で動かし、ソフトウェア開発タスクを自律的に処理するシステム。Orchestrator がエージェントを統括し、GitHub Issues・cron・手動入力からタスクを取り込んで実行する。

設計書: `AI_Engineering_Team_設計書_v2.1.md`

## 技術スタック

- **言語:** TypeScript（strict モード）
- **ランタイム:** Node.js v22+
- **エージェント実行:** Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- **タスクキュー:** SQLite（`better-sqlite3`）
- **バリデーション:** Zod（構造化出力のスキーマ定義・型生成）
- **Git戦略:** worktree によるエージェント間の完全分離
- **常駐化:** systemd user service（WSL2）

## アーキテクチャ

```
GitHub Issues / cron / 手動入力
        ↓
Orchestrator (TypeScript + Node.js)
  ├── Classifier (Claude Haiku) → タスク分類・分解
  ├── Task Queue (SQLite) → 依存関係付きキュー管理
  ├── Rate Controller → Max プラン枠消費のペース制御
  └── Dispatcher → エージェント起動・タイムアウト・結果回収
        ↓
  Agent SDK query() → 各エージェント（独立 worktree で実行）
        ↓
  Context Bridge (.claude/handoff/*.json) → エージェント間の結果引き継ぎ
        ↓
  Result Collector → PR作成・Slack通知
```

## ビルド・実行コマンド

```bash
npm install          # 依存関係インストール
npm run build        # TypeScript コンパイル（tsc）
npm run start        # Orchestrator 起動
npm run dev          # 開発モード（ts-node / tsx）
npm run lint         # ESLint
npm run typecheck    # 型チェックのみ（tsc --noEmit）
npm run test         # テスト実行
```

## ディレクトリ構成

```
~/ai-engineer/                # 本リポジトリ（Orchestrator）
├── src/
│   ├── index.ts              # エントリーポイント
│   ├── orchestrator.ts       # メインループ
│   ├── agents/               # エージェント定義（Reviewer, Fixer, Builder, Scribe）
│   ├── queue/                # タスクキュー（SQLite + better-sqlite3）
│   ├── rate-controller.ts    # Rate Controller
│   └── types.ts              # 共通型定義（Task, AgentConfig 等）
├── package.json
├── tsconfig.json
├── .env                      # 環境変数（git管理外）
├── tasks.db                  # タスクDB（自動生成）
└── logs/                     # 構造化ログ（JSON Lines）

~/my-project/                 # 対象リポジトリ
├── .claude/
│   ├── CLAUDE.md
│   └── handoff/              # Context Bridge ファイル
└── src/

~/worktrees/                  # エージェント専用 worktree
├── reviewer/
├── fixer/
├── builder/
└── scribe/
```

## エージェント設計

| エージェント | 役割 | 許可ツール | 予算 | ターン上限 | タイムアウト |
|------------|------|-----------|------|----------|------------|
| Reviewer | コードレビュー（読み取り専用） | Read, Glob, Grep | $0.50 | 15 | 10分 |
| Fixer | バグ修正・テスト実行 | Read, Edit, Glob, Grep, Bash(test系) | $1.00 | 30 | 30分 |
| Builder | 新機能実装 | Read, Edit, Glob, Grep, Bash(npm/git系) | $2.00 | 50 | 40分 |
| Scribe | ドキュメント生成・更新 | Read, Edit, Glob, Grep | $0.50 | 20 | 10分 |

各エージェントは最小権限の原則に従い、`allowedTools` でツールをホワイトリスト制御する。Bash コマンドはプレフィックスマッチ（例: `Bash(npm test *)`）で細かく制限する。

## Agent SDK の使い方

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "src/ 配下をレビューしてください",
  options: {
    allowedTools: ["Read", "Glob", "Grep"],
    permissionMode: "dontAsk",  // 読み取り専用：許可ツール以外はすべて拒否
    maxTurns: 15,
    maxBudgetUsd: 0.50,
    model: "sonnet",
    cwd: "/home/user/worktrees/reviewer",
    // 構造化出力
    outputFormat: {
      type: "json_schema",
      schema: reviewResultSchema,
    },
  },
})) {
  if (message.type === "result" && message.structured_output) {
    // Zod でバリデーション
  }
}
```

サブエージェントは `agents` オプションで定義する。Classifier は `model: "haiku"` でコストを抑える。

## 安全設計（3層防壁）

1. **Agent レベル:** `maxTurns`, `maxBudgetUsd`, `allowedTools`, `AbortController`（タイムアウト）
2. **Orchestrator レベル:** Rate Controller（Max プラン時）、日次予算上限（API課金時）、Circuit Breaker（連続5回失敗で1時間停止）
3. **Git レベル:** worktree 分離、ブランチ保護（main は PR + CI 必須）、diff サイズ上限（500行）

## 認証

- **Max プラン:** `claude login`（OAuth）を使用。`ANTHROPIC_API_KEY` を設定しないこと（設定すると意図せず従量課金になる）
- **API 従量課金:** `ANTHROPIC_API_KEY` 環境変数を設定
- 同時に両方を設定しない

## Git 規約

- Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`
- 1コミット = 1つの論理的変更
- すべての変更は PR 経由（main への直接 push 禁止）
- ブランチ命名: `agent/{agent_name}/{task_id}`（例: `agent/fixer/gh-42-1`）
- diff サイズ上限: 500行/PR

## 環境変数（.env）

主要な変数: `RATE_CONTROL_ENABLED`, `RATE_COOLDOWN_SECONDS`, `GITHUB_TOKEN`, `GITHUB_REPO`, `PROJECT_DIR`, `WORKTREE_DIR`, `SLACK_WEBHOOK_URL`, `DAILY_BUDGET_USD`, `MAX_CONCURRENT`。詳細は設計書セクション12.4を参照。
