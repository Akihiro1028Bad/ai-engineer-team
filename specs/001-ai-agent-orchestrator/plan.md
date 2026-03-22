# Implementation Plan: AI Agent Orchestrator

**Branch**: `001-ai-agent-orchestrator` | **Date**: 2026-03-22 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-ai-agent-orchestrator/spec.md`

## Summary

4つの専門AIエージェント（Reviewer, Fixer, Builder, Scribe）を Orchestrator が統括し、GitHub Issues・cron・手動入力からタスクを取り込み、Claude Agent SDK 経由で自律的に実行するシステム。タスクはSQLiteキューで依存関係付き管理され、エージェント間は Context Bridge（JSON ファイル）で結果を引き継ぐ。パイプラインタスクでは Reviewer 完了後に設計PRを作成し、人間の承認後に実装エージェントが起動するヒューマン・イン・ザ・ループ型ワークフローを採用する。

## Technical Context

**Language/Version**: TypeScript (strict mode), ES2022+ target
**Primary Dependencies**: `@anthropic-ai/claude-agent-sdk`, `better-sqlite3`, `zod`, `pino`, `@octokit/rest`
**Storage**: SQLite (WAL mode), better-sqlite3 synchronous API
**Testing**: Vitest (Node.js native test runner 互換、型安全)
**Target Platform**: Linux (WSL2 Ubuntu 24.04), Node.js v22+
**Project Type**: Long-running daemon (systemd user service)
**Performance Goals**: タスク投入→PR作成: 単体15分以内、パイプライン60分以内（人間承認待ち時間除く）
**Constraints**: Max プラン枠（5h ローリングウィンドウ）、同時実行1（Max）/2（API）、diff ≤500行/PR
**Scale/Scope**: 日次5〜30タスク、単一リポジトリ対象

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle | Status | Evidence |
|---|-----------|--------|----------|
| I | Type Safety First | ✅ PASS | TypeScript strict, Zod バリデーション全外部境界、`no-explicit-any` ESLint |
| II | Least Privilege | ✅ PASS | エージェントごとの `allowedTools` ホワイトリスト、`permissionMode: "dontAsk"`, `maxTurns`/`maxBudgetUsd` 設定 |
| III | Safety by Design | ✅ PASS | 3層防壁（Agent/Orchestrator/Git）、AbortController タイムアウト、Circuit Breaker |
| IV | Test-First Development | ✅ PASS | Vitest、インメモリSQLite、Zod スキーマバリデーションテスト、CI ゲート必須 |
| V | Simplicity & YAGNI | ✅ PASS | 単一リポジトリ固定、`as const` enum 代替、1ファイル1責務 |
| VI | Observability | ✅ PASS | pino JSON Lines ログ、`taskId`/`agentRole`/`timestamp` コンテキスト、Daily digest |
| VII | Git Isolation | ✅ PASS | エージェント専用 worktree、`agent/{name}/{taskId}` ブランチ命名、500行 diff 上限 |

**Gate Result: ALL PASS** — Phase 0 に進む。

## Project Structure

### Documentation (this feature)

```text
specs/001-ai-agent-orchestrator/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── slack-events.md  # Slack 通知イベント定義
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── index.ts                  # エントリーポイント（systemd 起動）
├── orchestrator.ts           # メインループ（ポーリング + ディスパッチ）
├── agents/
│   ├── agent-config.ts       # エージェント定義（tools, budget, timeout）
│   ├── dispatcher.ts         # Agent SDK query() ラッパー + タイムアウト
│   └── classifier.ts         # Haiku による Issue 分類
├── queue/
│   ├── task-queue.ts         # SQLite CRUD + 依存関係解決
│   ├── schema.ts             # DB スキーマ初期化（CREATE TABLE）
│   └── migrations.ts         # スキーマバージョン管理
├── sources/
│   ├── github-poller.ts      # GitHub Issue ポーリング + PR approve 監視
│   ├── cron-scheduler.ts     # cron 定期タスク
│   └── manual-cli.ts         # 手動タスク投入 CLI
├── bridges/
│   ├── context-bridge.ts     # Handoff JSON 読み書き
│   └── result-collector.ts   # PR 作成 + Slack 通知
├── safety/
│   ├── rate-controller.ts    # Max プラン枠ペース制御
│   ├── circuit-breaker.ts    # 連続失敗検出 + 自動停止
│   └── budget-guard.ts       # 日次予算上限（API 課金時）
├── notifications/
│   └── slack-notifier.ts     # Slack Webhook 送信
├── logging/
│   ├── logger.ts             # pino ロガー初期化
│   └── log-rotation.ts       # 30日ログローテーション
├── config/
│   └── env-config.ts         # 環境変数バリデーション（Zod）
└── types.ts                  # 共通型定義（Task, AgentConfig, etc.）

tests/
├── unit/
│   ├── queue/
│   │   └── task-queue.test.ts
│   ├── safety/
│   │   ├── rate-controller.test.ts
│   │   └── circuit-breaker.test.ts
│   ├── agents/
│   │   └── classifier.test.ts
│   └── notifications/
│       └── slack-notifier.test.ts
├── integration/
│   ├── orchestrator.test.ts
│   ├── github-poller.test.ts
│   └── dispatcher.test.ts
└── contract/
    └── handoff-schema.test.ts
```

**Structure Decision**: 単一プロジェクト構成。機能領域ごとにディレクトリを分割（agents/, queue/, sources/, bridges/, safety/, notifications/）。各ディレクトリは 1〜3 ファイルの小規模モジュールで構成し、Constitution V (Simplicity) に準拠。

## Complexity Tracking

> No violations detected. All design choices align with Constitution principles.

## Slack 通知タイミング設計

ユーザーからの追加要件に基づき、Slack 通知のタイミングを以下のように整理する。

### 即時通知（イベント駆動）

| イベント | 通知レベル | 内容 |
|---------|----------|------|
| タスク完了（単体） | info | タスク名、コスト、ターン数、所要時間 |
| パイプライン設計PR作成 | info | PR URL、承認依頼メッセージ |
| パイプライン最終PR作成 | info | PR URL、変更概要 |
| タスク失敗（リトライあり） | warn | タスク名、エラー概要、リトライ回数/残り |
| タスク最終失敗（リトライ上限到達） | error | タスク名、エラー詳細、人間の対応依頼 |
| 設計PR却下 | warn | PR URL、パイプラインキャンセル通知 |
| 認証エラー（OAuth 期限切れ） | error | `claude login` 再実行依頼 |
| Circuit Breaker OPEN | error | 緊急停止通知、連続失敗の詳細 |
| Circuit Breaker CLOSED（復旧） | info | 復旧通知 |
| Rate limit 接近（残り10%） | warn | 5hウィンドウの残り枠、クールダウン状況 |
| 日次予算上限到達（API課金時） | error | 消費額、全エージェント停止通知 |
| Classifier が unclear 判定 | info | Issue URL、質問投稿済みの旨 |

### 定期通知（スケジュール）

| スケジュール | 内容 |
|------------|------|
| 毎日 08:00 | Daily digest: 完了数、失敗数、コスト合計、PR数、平均所要時間、未承認PR件数・経過時間 |

### 通知しないイベント

- タスク開始（ログのみ）
- ツール呼び出し（ログのみ）
- ポーリング実行（ログのみ）
- ポーリング失敗（ログのみ、次回自動リトライ）
- Rate Controller クールダウン挿入（ログのみ）

## テスト・動作確認エビデンス規約

すべての PR には、変更内容に対応するエビデンスを添付しなければならない。

### エビデンスの種類

| カテゴリ | エビデンス形式 | 例 |
|---------|-------------|-----|
| ユニットテスト | テスト実行結果のログ出力 | `npm run test` の stdout（パス数・失敗数） |
| 型チェック | `tsc --noEmit` の実行結果 | エラーゼロの出力 |
| Lint | `npm run lint` の実行結果 | エラーゼロの出力 |
| ブラウザ動作確認 | スクリーンショット | GitHub PR 画面、Slack 通知の表示確認 |
| API 動作確認 | レスポンスのログ出力 | GitHub API 呼び出し結果、Slack Webhook 送信結果 |
| 構造化出力 | JSON サンプル | エージェントの出力結果、handoff JSON |
| パイプライン動作 | 実行ログ | Orchestrator のログ（タスク遷移、エージェント起動〜完了） |
| systemd 動作 | journalctl 出力 | サービス起動・再起動のログ |

### ブラウザ確認が必須なタスク

以下のタスクでは、Chrome DevTools 等のスクリーンショットを PR に含めること:

- **GitHub PR 自動作成**: PR が正しく作成されていることを GitHub 画面で確認
- **GitHub Issue コメント**: Classifier の質問コメントが正しく投稿されていることを確認
- **Slack 通知**: 各通知イベント（完了、失敗、承認依頼、Circuit Breaker 等）が正しい形式で表示されることを確認
- **PR approve 検出**: 設計 PR の approve 後にパイプラインが再開されることを確認

### PR 説明テンプレート

```markdown
## 変更内容
- [変更の概要]

## テスト結果
```
npm run test の出力を貼り付け
```

## 動作確認エビデンス
### [確認項目1]
[スクリーンショットまたはログ出力]

### [確認項目2]
[スクリーンショットまたはログ出力]
```
