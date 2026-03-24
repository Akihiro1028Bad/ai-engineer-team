# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

5層コンポジットアーキテクチャの自律型 AI エンジニアリングチーム。5つのコアエージェント（Analyzer, Designer, Implementer, Critic, Scribe）+ 補助エージェント（Classifier, Optimizer, Tool Synthesizer）を24時間稼働のWindows PC + WSL2上で動かし、ソフトウェア開発タスクを自律的に処理するシステム。Orchestrator が DAG ベースの実行計画に基づきエージェントを統括し、GitHub Issues・cron・手動入力からタスクを取り込んで実行する。複数リポジトリ同時対応。

設計書: `AI_Engineering_Team_設計書_v3.0.md`

## 技術スタック

- **言語:** TypeScript（strict モード）
- **ランタイム:** Node.js v22+
- **エージェント実行:** Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- **タスクキュー:** SQLite（`better-sqlite3`）
- **バリデーション:** Zod（構造化出力のスキーマ定義・型生成）
- **Git戦略:** worktree によるエージェント間の完全分離
- **常駐化:** systemd user service（WSL2）

## アーキテクチャ（5層コンポジット）

```
Layer 5: FEEDBACK LOOP    — EvalStore, PatternMemory, ModelRouter, PromptOptimizer
Layer 4: QUALITY GATE     — ValidationGate (Haiku), Generator-Critic Loop (Sonnet)
Layer 3: EXECUTION        — AgentRunner → 5 agents (worktree 分離)
Layer 2: PLANNING         — Analyzer (Haiku) → Planner (Opus) → DAG Scheduler
Layer 1: INTAKE           — ClassifierV3 (Haiku) → IssueDiscussion → AutoTriage → TaskQueue
```

```
GitHub Issues / cron / 手動入力
        ↓
L1: Intake
  ├── ClassifierV3 (Haiku, $0.01) → 分類・信頼度・トリアージ
  ├── Issue Discussion → 不明確な Issue に質問（最大3往復）
  ├── Auto-Triage → ラベル・優先度・サイズ自動判定
  ├── Related Issues → 類似 Issue 検出・リンク
  └── Task Queue (SQLite) → 依存関係付きキュー管理
        ↓
L2: Planning
  ├── Analyzer Agent (Haiku, $0.05) → コードベース調査・影響範囲分析
  ├── Planner Agent (Opus, $0.80) → ExecutionPlan (DAG) 生成
  ├── Cost Estimator → コスト/時間事前見積
  └── Dry Run Preview → 計画プレビュー（Issue コメント）
        ↓
L3: Execution
  ├── DAG Scheduler → トポロジカルソート・並列バッチ分割
  ├── AgentRunner → ノード単位で Agent SDK 実行
  ├── HandoffStore (SQLite) → エージェント間引き継ぎレポート
  └── PR Review Responder → レビューコメント自動対応
        ↓
L4: Quality Gate
  ├── Validation Gate (Haiku) → スキーマ・安全性チェック
  └── Generator-Critic Loop → 高リスク変更の品質検証（最大3回）
        ↓
L5: Feedback Loop
  ├── EvalStore → 全実行結果記録
  ├── PatternMemory → 成功/失敗パターン学習
  ├── ModelRouter → Epsilon-Greedy 適応モデル選択
  └── PR Feedback Learner → レビューフィードバック学習

Cross-cutting:
  ├── ToolForge → 自律的スキル生成（Gap検出→合成→検証→登録）
  ├── Per-Agent Circuit Breaker → agentRole×taskType 別障害隔離
  ├── Dashboard (Express + SSE) → リアルタイム Web UI
  └── Multi-Repo → repos.json で複数リポジトリ同時管理
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
~/ai-engineer/                        # 本リポジトリ（Orchestrator）
├── src/
│   ├── index.ts                      # エントリーポイント（マルチリポ対応）
│   ├── orchestrator.ts               # メインループ（v3.0 + v2.1 互換）
│   ├── types.ts                      # 共通型定義
│   ├── types/                        # v3.0 型定義
│   │   ├── execution-plan.ts         # ExecutionPlan, PlanNode, AnalysisReport
│   │   ├── validation.ts             # ValidationResult, CriticReview
│   │   ├── eval.ts                   # EvalRecord, PatternMemory, FeedbackLearning
│   │   └── handoff-report.ts         # HandoffReport
│   ├── intake/                       # L1: Intake
│   │   ├── classifier.ts             # ClassifierV3 (Haiku)
│   │   ├── issue-discussion.ts       # Issue 質問ループ
│   │   ├── auto-triage.ts            # 自動トリアージ
│   │   └── related-issues.ts         # 類似 Issue 検出
│   ├── planning/                     # L2: Planning
│   │   ├── analyzer-agent.ts         # Analyzer (Haiku)
│   │   ├── planner-agent.ts          # Planner (Opus)
│   │   ├── dag-scheduler.ts          # DAG スケジューラ
│   │   ├── cost-estimator.ts         # コスト/時間見積
│   │   └── dry-run.ts               # Dry Run プレビュー
│   ├── execution/                    # L3: Execution
│   │   ├── agent-runner.ts           # ノード実行ランナー
│   │   ├── status-emitter.ts         # リアルタイムイベント
│   │   ├── pr-review-responder.ts    # PR コメント自動対応
│   │   ├── handoff-store.ts          # 引き継ぎレポート保存
│   │   └── merge-conflict-resolver.ts # コンフリクト自動解決
│   ├── quality/                      # L4: Quality Gate
│   │   ├── validation-gate.ts        # ハンドオフ検証
│   │   ├── generator-critic-loop.ts  # Generator-Critic Loop
│   │   ├── risk-classifier.ts        # リスク判定
│   │   └── safety-checks.ts          # 安全性チェック
│   ├── feedback/                     # L5: Feedback Loop
│   │   ├── eval-store.ts             # 実行結果記録
│   │   ├── pattern-memory.ts         # パターン学習
│   │   ├── model-router.ts           # 適応モデル選択
│   │   ├── pr-feedback-learner.ts    # PR フィードバック学習
│   │   └── prompt-optimizer.ts       # プロンプト最適化
│   ├── toolforge/                    # ToolForge
│   │   ├── gap-detector.ts           # ギャップ検出
│   │   ├── tool-synthesizer.ts       # スキル生成
│   │   ├── sandbox-validator.ts      # サンドボックス検証
│   │   ├── skill-registry.ts         # スキルレジストリ
│   │   └── skill-executor.ts         # スキル実行
│   ├── agents/                       # エージェント定義
│   ├── queue/                        # タスクキュー
│   ├── safety/                       # 安全機構（CB, Rate, Budget）
│   ├── bridges/                      # Result Collector
│   ├── sources/                      # GitHub Poller, Cron, CI Monitor
│   ├── dashboard/                    # Dashboard API サーバー
│   ├── config/                       # 設定（env, repos）
│   ├── logging/                      # pino ロガー
│   └── notifications/                # Slack 通知
├── dashboard/dist/                   # Dashboard SPA（HTML）
├── skills/                           # ToolForge スキルライブラリ
├── repos.json                        # マルチリポジトリ設定（任意）
├── tasks.db                          # SQLite DB（自動生成）
└── logs/                             # 構造化ログ（JSON Lines）
```

## エージェント設計

### v3.0 コアエージェント

| エージェント | 役割 | モデル | 許可ツール | 予算 | ターン | タイムアウト |
|------------|------|--------|-----------|------|--------|------------|
| Analyzer | コードベース調査・影響分析 | Haiku | Read, Glob, Grep | $0.10 | 10 | 5分 |
| Designer | 設計書作成 | Sonnet | Read, Write, Edit, Glob, Grep | $1.00 | 30 | 15分 |
| Implementer | 実装・テスト作成 | Sonnet | Read, Edit, Write, Bash, Glob, Grep | $2.00 | 50 | 40分 |
| Critic | 品質レビュー | Sonnet | Read, Bash(test/tsc), Glob, Grep | $0.50 | 15 | 10分 |
| Scribe | ドキュメント更新 | Haiku | Read, Edit, Write, Glob, Grep | $0.10 | 10 | 5分 |

### 補助エージェント

| エージェント | 役割 | モデル |
|------------|------|--------|
| Classifier | Issue 分類・トリアージ | Haiku ($0.01/task) |
| Optimizer | 月次プロンプト最適化 | Opus |
| Tool Synthesizer | 自律的スキル生成 | Sonnet |

### v2.1 互換エージェント（後方互換で残存）

| エージェント | 役割 | モデル | 予算 |
|------------|------|--------|------|
| Reviewer | 設計レビュー | Opus | $5.00 |
| Fixer | バグ修正 | Sonnet | $2.00 |
| Builder | 新機能実装 | Sonnet | $2.00 |

各エージェントは最小権限の原則に従い、`allowedTools` でツールをホワイトリスト制御する。

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

## コーディング規約

### TypeScript 全般

- **strict モード必須:** `tsconfig.json` で `"strict": true` を有効化。`any` の使用は原則禁止（`unknown` + 型ガードで代替）
- **型推論を活かす:** 変数宣言で自明な型注釈は書かない。関数の戻り値型は明示する（公開API・エクスポート関数）
- **`interface` vs `type`:** オブジェクト形状の定義には `interface` を使用。ユニオン型・交差型・ユーティリティ型には `type` を使用
- **`const` アサーション:** リテラル定数やルックアップテーブルには `as const` を活用し、型の拡大（widening）を防ぐ
- **`readonly` の活用:** 変更されないプロパティ・配列には `readonly` / `ReadonlyArray<T>` を付与する
- **`enum` は使わない:** `as const` オブジェクト + `typeof` で代替する（Tree-shaking・型安全性の観点）
- **Non-null アサーション (`!`) は禁止:** 代わりに型ガードまたは Optional chaining (`?.`) + Nullish coalescing (`??`) を使用
- **型キャスト (`as`) の使用は最小限に:** 型を嘘でねじ曲げるキャストは避け、型ガード関数や `satisfies` 演算子で型を検証する

```typescript
// Good: as const でリテラル型を保持
const AgentRole = {
  Reviewer: "reviewer",
  Fixer: "fixer",
  Builder: "builder",
  Scribe: "scribe",
} as const;
type AgentRole = (typeof AgentRole)[keyof typeof AgentRole];

// Good: satisfies で型を検証しつつ推論を保持
const config = {
  maxTurns: 15,
  model: "sonnet",
} satisfies Partial<AgentConfig>;
```

### 命名規則

| 対象 | 規則 | 例 |
|------|------|-----|
| 変数・関数・メソッド | camelCase | `taskQueue`, `dispatchAgent()` |
| 定数（モジュールレベル） | UPPER_SNAKE_CASE | `MAX_CONCURRENT`, `DEFAULT_TIMEOUT_MS` |
| 型・インターフェース・クラス | PascalCase | `TaskStatus`, `AgentConfig` |
| ファイル名 | kebab-case | `rate-controller.ts`, `task-queue.ts` |
| 未使用引数 | `_` プレフィックス | `_event`, `_index` |
| boolean 変数 | `is` / `has` / `should` プレフィックス | `isRunning`, `hasPermission` |

### 関数・モジュール設計

- **1ファイル1責務:** ファイルが 300 行を超えたら分割を検討する
- **純粋関数を優先:** 副作用を持つ関数は明確に分離し、名前で示す（`saveTask`, `sendNotification`）
- **早期リターン:** ネストを浅く保つ。ガード節で異常系を先に処理する
- **引数は 3 つまで:** 4 つ以上になる場合はオプションオブジェクトパターンを使う

```typescript
// Good: オプションオブジェクトパターン
interface DispatchOptions {
  agent: AgentRole;
  taskId: string;
  timeout?: number;
  maxRetries?: number;
}
function dispatch(options: DispatchOptions): Promise<AgentResult> { ... }
```

### 非同期処理

- **`async/await` を使用:** `.then()` チェーンは使わない
- **`Promise` の放置禁止:** `await` するか、明示的に `void` で捨てる（ESLint `@typescript-eslint/no-floating-promises`）
- **`Promise.all` の活用:** 独立した非同期処理は並列実行する
- **`AbortController` でのタイムアウト:** 長時間処理には必ずキャンセル機構を組み込む

```typescript
// Good: 並列実行 + タイムアウト
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
try {
  const [reviewResult, buildResult] = await Promise.all([
    runReviewer(task, { signal: controller.signal }),
    runBuilder(task, { signal: controller.signal }),
  ]);
} finally {
  clearTimeout(timeout);
}
```

### エラーハンドリング

- **カスタムエラークラスを使用:** エラー種別を判別可能にする。`cause` チェーンでラップする
- **境界でのみ `try/catch`:** 内部関数では例外をそのまま伝播させる
- **`unknown` 型の `catch`:** `catch (error)` は `unknown` 型。型ガードで検査してからアクセスする
- **Result パターンの検討:** 失敗が頻繁に起こる処理（パース・バリデーション）は `{ success, data, error }` パターンを使用

```typescript
// Good: カスタムエラー + cause チェーン
class AgentError extends Error {
  constructor(
    message: string,
    readonly agentRole: AgentRole,
    readonly taskId: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentError";
  }
}

// Good: catch で unknown を検査
try {
  await dispatch(options);
} catch (error: unknown) {
  if (error instanceof AgentError) {
    logger.error({ agentRole: error.agentRole, taskId: error.taskId }, error.message);
  } else {
    throw new AgentError("Unexpected dispatch failure", role, taskId, { cause: error });
  }
}
```

### Zod スキーマ規約

- **スキーマ名は PascalCase:** 型名と同名にし、`z.infer<typeof Schema>` で型を導出する
- **スキーマと型をセットで export:** 常にスキーマ定義と推論型をペアにする
- **`safeParse` を優先:** `parse` は例外を投げるため、バリデーション失敗が想定される箇所では `safeParse` を使用
- **Branded Types の活用:** TaskId, AgentRole など、同じプリミティブ型でも意味が異なる値には `.brand()` で名目的型付けを行う

```typescript
// Good: スキーマと型のペア定義
const TaskResult = z.object({
  taskId: z.string().brand<"TaskId">(),
  status: z.enum(["success", "failure", "timeout"]),
  output: z.string().optional(),
  durationMs: z.number().nonnegative(),
});
type TaskResult = z.infer<typeof TaskResult>;

// Good: safeParse でバリデーション
const result = TaskResult.safeParse(rawOutput);
if (!result.success) {
  logger.warn({ issues: result.error.issues }, "Invalid agent output");
  return { status: "failure", reason: "validation_error" };
}
const validated = result.data;
```

### ESLint 設定方針

`typescript-eslint` の `strictTypeChecked` をベースに、以下を有効化:

- `@typescript-eslint/no-explicit-any`: `error` — `any` の使用を禁止
- `@typescript-eslint/no-floating-promises`: `error` — Promise の放置を禁止
- `@typescript-eslint/no-misused-promises`: `error` — Promise の誤用を禁止
- `@typescript-eslint/no-unused-vars`: `error`（`_` プレフィックスは許可）
- `@typescript-eslint/explicit-function-return-type`: `warn`（エクスポート関数で推奨）
- `@typescript-eslint/naming-convention`: 上記の命名規則テーブルに準拠
- `@typescript-eslint/no-unsafe-*` 系: すべて `error` — 型安全性を担保

### import 規約

- **Node.js 組み込みモジュール:** `node:` プレフィックスを付ける（例: `import { readFile } from "node:fs/promises"`）
- **import 順序:** ① Node.js 組み込み → ② 外部パッケージ → ③ プロジェクト内部（各グループ間に空行）
- **`type` import を分離:** 型のみの import は `import type { ... }` を使用する
- **デフォルト export は使わない:** 名前付き export のみ使用（リファクタリング・検索性の向上）

```typescript
// Good: import の順序と type import の分離
import { setTimeout } from "node:timers/promises";

import Database from "better-sqlite3";
import { z } from "zod";

import type { AgentConfig, TaskStatus } from "./types.js";
import { TaskQueue } from "./queue/task-queue.js";
import { RateController } from "./rate-controller.js";
```

### ログ規約

- **構造化ログ（JSON Lines）:** `pino` 等を使用し、人間向けメッセージではなく構造化データで出力する
- **ログレベル:** `debug`（開発時のみ）、`info`（正常系イベント）、`warn`（回復可能な異常）、`error`（要対応の異常）
- **コンテキスト情報を付与:** `taskId`, `agentRole`, `durationMs` などをフィールドとして含める

## Active Technologies
- TypeScript (strict mode), ES2022+ targe + `@anthropic-ai/claude-agent-sdk`, `better-sqlite3`, `zod`, `pino`, `@octokit/rest` (001-ai-agent-orchestrator)
- SQLite (WAL mode), better-sqlite3 synchronous API (001-ai-agent-orchestrator)

## Recent Changes
- 001-ai-agent-orchestrator: Added TypeScript (strict mode), ES2022+ targe + `@anthropic-ai/claude-agent-sdk`, `better-sqlite3`, `zod`, `pino`, `@octokit/rest`
