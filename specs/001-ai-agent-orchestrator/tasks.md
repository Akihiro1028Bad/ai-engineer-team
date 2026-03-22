# Tasks: AI Agent Orchestrator

**Input**: Design documents from `/specs/001-ai-agent-orchestrator/`
**Prerequisites**: plan.md, spec.md, data-model.md, contracts/slack-events.md, research.md, test-cases.md
**Approach**: TDD（テスト駆動開発）— すべてのモジュールで「テストを先に書く → テストが RED であることを確認 → 実装 → テストが GREEN になることを確認」のサイクルを厳守する

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Single project**: `src/`, `tests/` at repository root

---

## Phase 1: Setup（プロジェクト初期化）

**Purpose**: TypeScript プロジェクトの骨格を作成し、ビルド・テスト・Lint が動く状態にする

- [x] T001 `package.json` を作成する。`name: "ai-agent-orchestrator"`, `type: "module"` を設定し、以下の dependencies を追加: `@anthropic-ai/claude-agent-sdk`, `better-sqlite3`, `zod`, `pino`, `@octokit/rest`。devDependencies: `typescript`, `vitest`, `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`, `eslint`, `@types/better-sqlite3`。scripts に `build`, `dev`, `start`, `test`, `lint`, `typecheck` を定義する → `package.json`

- [x] T002 `tsconfig.json` を作成する。`strict: true`, `target: "ES2022"`, `module: "Node16"`, `moduleResolution: "Node16"`, `outDir: "./dist"`, `rootDir: "./src"`, `declaration: true`, `sourceMap: true` を設定する → `tsconfig.json`

- [x] T003 [P] ESLint 設定ファイルを作成する。`typescript-eslint` の `strictTypeChecked` を extends し、`@typescript-eslint/no-explicit-any: "error"`, `@typescript-eslint/no-floating-promises: "error"`, `@typescript-eslint/no-unused-vars` で `_` プレフィックス許可を設定する → `eslint.config.mjs`

- [x] T004 [P] Vitest 設定ファイルを作成する。`globals: true`, `environment: "node"`, TypeScript パスエイリアスの設定、カバレッジレポーター（`text`, `lcov`）を設定し、`coverage.thresholds` で `statements: 100, branches: 100, functions: 100, lines: 100` を設定する → `vitest.config.ts`

- [x] T005 [P] `.env.example` を作成する。全環境変数をコメント付きで記載する（`RATE_CONTROL_ENABLED`, `RATE_COOLDOWN_SECONDS`, `MAX_TASKS_PER_WINDOW`, `RATE_LIMIT_WARN_THRESHOLD`, `GITHUB_TOKEN`, `GITHUB_REPO`, `PROJECT_DIR`, `WORKTREE_DIR`, `SLACK_WEBHOOK_URL`, `DAILY_BUDGET_USD`, `MAX_CONCURRENT`）。**実際の値は含めないこと** → `.env.example`

- [x] T006 [P] `.gitignore` に `node_modules/`, `dist/`, `.env`, `tasks.db`, `logs/`, `coverage/` を追加する → `.gitignore`

- [x] T007 `npm install` を実行し、依存関係をインストールする。`npm run build` でコンパイルエラーがないことを確認する。`npm run test` で Vitest が起動することを確認する（テストファイルがないため 0 件パスで OK）

- [x] T008 plan.md のディレクトリ構成に従い、空の `src/` サブディレクトリを作成する: `src/agents/`, `src/queue/`, `src/sources/`, `src/bridges/`, `src/safety/`, `src/notifications/`, `src/logging/`, `src/config/`。同様に `tests/unit/queue/`, `tests/unit/safety/`, `tests/unit/agents/`, `tests/unit/notifications/`, `tests/unit/sources/`, `tests/unit/bridges/`, `tests/unit/logging/`, `tests/unit/config/`, `tests/integration/`, `tests/contract/` を作成する

**Checkpoint**: `npm run build`, `npm run test`, `npm run lint`, `npm run typecheck` がすべてエラーなしで実行できる

---

## Phase 2: Foundational（全ユーザーストーリーの前提となる基盤）

**Purpose**: 型定義、環境変数、DB スキーマ、ロガーなど、すべてのモジュールが依存する基盤を TDD で構築する

**⚠️ CRITICAL**: この Phase が完了するまで、どのユーザーストーリーにも着手しないこと

### 2.1 共通型定義 (`src/types.ts`)

> **TDD サイクル**: テスト T009 → 実装 T010

- [ ] T009 **RED テスト作成**: `tests/unit/types.test.ts` を作成し、test-cases.md の T-TYP-001〜T-TYP-016 の全 16 テストケースを記述する。具体的には: (1) `TaskType` の有効値 4 種が `safeParse` で成功すること、(2) `TaskType` の無効値 `"deploy"`, `""`, `null` が失敗すること、(3) `TaskStatus` の有効値 5 種が成功すること、(4) `CreateTaskInput` の必須フィールド `id`, `taskType`, `title`, `description`, `source` をそれぞれ 1 つずつ欠落させて失敗すること、(5) `priority` が `0` と `11` で失敗し `1`, `5`, `10` で成功すること、(6) `AgentRole` の 4 値が成功すること、(7) `Handoff`, `Classification`, `SlackNotification` スキーマの有効/無効テスト。この時点で `npm run test` を実行し、**すべて RED（失敗）** であることを確認する → `tests/unit/types.test.ts`

- [ ] T010 **GREEN 実装**: `src/types.ts` を作成する。以下の Zod スキーマと型を定義する: `TaskType`, `TaskStatus`, `AgentRole`, `CreateTaskInput`, `Task`, `Handoff`, `Classification`, `SubTaskDef`, `SlackNotification`。data-model.md のフィールド定義に厳密に従う。`z.infer<typeof Schema>` で型を導出し、スキーマと型をペアで `export` する。`npm run test` を実行し、T009 の全テストが **GREEN（成功）** になることを確認する → `src/types.ts`

### 2.2 環境変数バリデーション (`src/config/env-config.ts`)

> **TDD サイクル**: テスト T011 → 実装 T012

- [ ] T011 **RED テスト作成**: `tests/unit/config/env-config.test.ts` を作成し、test-cases.md の T-ENV-001〜T-ENV-014 の全 14 テストケース + 追加 2 ケースを記述する。具体的には: (1) Max プラン用の全必須変数セットで成功、(2) API 課金用の全必須変数セットで成功、(3) `GITHUB_TOKEN`, `PROJECT_DIR`, `WORKTREE_DIR`, `GITHUB_REPO` を個別に欠落させてエラー、(4) `ANTHROPIC_API_KEY` と `RATE_CONTROL_ENABLED=true` の同時設定でエラー、(5) `DAILY_BUDGET_USD=-5` でエラー、(6) `MAX_CONCURRENT=0` でエラー、(7) `MAX_CONCURRENT` 未設定でデフォルト `1`、(8) `SLACK_WEBHOOK_URL` 未設定で成功、(9) `SLACK_WEBHOOK_URL="not-a-url"` でエラー、(10) `GITHUB_REPO="invalid"` でエラー、**(11) `MAX_TASKS_PER_WINDOW` 未設定でデフォルト `150`、(12) `RATE_LIMIT_WARN_THRESHOLD` 未設定でデフォルト `0.1`（10%）**。テスト内では `process.env` をモックする。`npm run test` で **RED** を確認 → `tests/unit/config/env-config.test.ts`

- [ ] T012 **GREEN 実装**: `src/config/env-config.ts` を作成する。Zod スキーマ `EnvConfig` を定義し、`loadConfig()` 関数で `process.env` をバリデーションする。`ANTHROPIC_API_KEY` と `RATE_CONTROL_ENABLED=true` の相互排他チェックを `refine()` で実装する。`GITHUB_REPO` の `owner/repo` 形式を `regex` でバリデーションする。`npm run test` で **GREEN** を確認 → `src/config/env-config.ts`

### 2.3 ロガー (`src/logging/logger.ts`)

> **TDD サイクル**: テスト T013 → 実装 T014

- [ ] T013 **RED テスト作成**: `tests/unit/logging/logger.test.ts` を作成し、test-cases.md の T-LOG-001〜T-LOG-006 の 6 テストケースを記述する。(1) `createLogger()` が pino インスタンスを返す、(2) `logger.child({ taskId: "gh-42", agentRole: "reviewer" })` で子ロガーのログ出力に `taskId` と `agentRole` が含まれる、(3) ログ出力が JSON Lines 形式（各行が有効な JSON）である。pino の出力先をメモリストリームにリダイレクトしてテストする → `tests/unit/logging/logger.test.ts`

- [ ] T014 **GREEN 実装**: `src/logging/logger.ts` を作成する。`pino` をインポートし、`createLogger(options?)` 関数を export する。ログレベルは環境変数 `LOG_LEVEL` で設定可能（デフォルト: `"info"`）。ファイル出力先は `logs/YYYY-MM-DD.jsonl` → `src/logging/logger.ts`

### 2.4 ログローテーション (`src/logging/log-rotation.ts`)

> **TDD サイクル**: テスト T015 → 実装 T016

- [ ] T015 **RED テスト作成**: `tests/unit/logging/log-rotation.test.ts` を作成し、test-cases.md の T-LR-001〜T-LR-005 の 5 テストケースを記述する。テスト用の一時ディレクトリを作成し、(1) 29 日前の `.jsonl` ファイルが保持される、(2) 31 日前の `.jsonl` ファイルが削除される、(3) 空ディレクトリでエラーなし、(4) `.txt` ファイルは削除されない、(5) ディレクトリ不在時にディレクトリが自動作成される → `tests/unit/logging/log-rotation.test.ts`

- [ ] T016 **GREEN 実装**: `src/logging/log-rotation.ts` を作成する。`rotateOldLogs(logDir: string, retentionDays: number = 30)` 関数を export する。`node:fs` でファイル一覧を取得し、`.jsonl` 拡張子かつ `retentionDays` 日より古いファイルを `unlinkSync` で削除する → `src/logging/log-rotation.ts`

### 2.5 DB スキーマ (`src/queue/schema.ts`)

> **TDD サイクル**: テスト T017 → 実装 T018

- [ ] T017 **RED テスト作成**: `tests/unit/queue/schema.test.ts` を作成し、test-cases.md の T-SCH-001〜T-SCH-011 の全 11 テストケースを記述する。`better-sqlite3` の `:memory:` DB を各テストの `beforeEach` で生成する。(1) `initSchema(db)` 後に `tasks` テーブルが存在する（`SELECT name FROM sqlite_master`）、(2) `PRAGMA journal_mode` が `wal` を返す、(3) 4 つのインデックスが存在する、(4) 二重 `initSchema()` でエラーなし、(5) 無効な `task_type` INSERT で SQLITE_CONSTRAINT、(6) 無効な `status` で CONSTRAINT、(7) `priority=0` と `priority=11` で CONSTRAINT、(8) `retry_count=4` で CONSTRAINT、(9) `priority` 未指定で `5` がデフォルト、(10) `status` 未指定で `"pending"`、(11) `created_at` が自動設定 → `tests/unit/queue/schema.test.ts`

- [ ] T018 **GREEN 実装**: `src/queue/schema.ts` を作成する。`initSchema(db: Database)` 関数を export する。`db.pragma('journal_mode = WAL')` を実行し、data-model.md の SQL スキーマ（CREATE TABLE + CREATE INDEX × 4）をそのまま `db.exec()` で実行する → `src/queue/schema.ts`

### 2.6 DB マイグレーション (`src/queue/migrations.ts`)

> **TDD サイクル**: テスト T019 → 実装 T020

- [ ] T019 **RED テスト作成**: `tests/unit/queue/migrations.test.ts` を作成し、test-cases.md の T-MIG-001〜T-MIG-003 の 3 テストケースを記述する → `tests/unit/queue/migrations.test.ts`

- [ ] T020 **GREEN 実装**: `src/queue/migrations.ts` を作成する。`schema_version` テーブルでバージョン管理し、差分マイグレーションを適用する `runMigrations(db: Database)` を export する → `src/queue/migrations.ts`

### 2.7 タスクキュー (`src/queue/task-queue.ts`)

> **TDD サイクル**: テスト T021 → 実装 T022

- [ ] T021 **RED テスト作成**: `tests/unit/queue/task-queue.test.ts` を作成し、test-cases.md の T-TQ-001〜T-TQ-029 の全 29 テストケースを記述する。`:memory:` DB + `initSchema()` を `beforeEach` で初期化する。テストケースは以下のグループに分ける: **追加**（T-TQ-001〜004）: 単体追加、依存関係付き追加、重複 ID エラー、パイプライン一括追加。**次タスク取得**（T-TQ-005〜012）: 空キュー→null、優先度順、作成日順、依存タスク未完了でスキップ、完了で取得、failed でスキップ、awaiting_approval でスキップ。**ステータス更新**（T-TQ-013〜019）: 全 7 状態遷移パス。**クラッシュ復旧**（T-TQ-020〜023）: in_progress リセット、retry 超過→failed、awaiting_approval 不変、completed 不変。**クエリ・集計**（T-TQ-024〜029）: 冪等性、フィルタ、集計、一括キャンセル、トランザクション原子性 → `tests/unit/queue/task-queue.test.ts`

- [ ] T022 **GREEN 実装**: `src/queue/task-queue.ts` を作成する。`TaskQueue` クラスを export し、以下のメソッドを実装する: `push(input: CreateTaskInput)`, `pushPipeline(tasks: CreateTaskInput[])`, `getNext(): Task | null`, `updateStatus(id, status, data?)`, `recoverFromCrash()`, `getByStatus(status)`, `getAwaitingApproval()`, `getDailyDigest()`, `cancelPipelineSuccessors(parentTaskId)`, `isDuplicate(source)`. すべてのメソッドでプリペアドステートメント（`db.prepare()`）を使用する。書き込み操作は `db.transaction()` でラップする → `src/queue/task-queue.ts`

### 2.8 エージェント設定 (`src/agents/agent-config.ts`)

> **TDD サイクル**: テスト T023 → 実装 T024

- [ ] T023 **RED テスト作成**: `tests/unit/agents/agent-config.test.ts` を作成し、test-cases.md の T-AC-001〜T-AC-007 の 7 テストケースを記述する。(1)〜(4) 各エージェント（reviewer, fixer, builder, scribe）の設定値（allowedTools, permissionMode, maxTurns, maxBudgetUsd, timeoutMs）が data-model.md の表と一致することを検証。(5) 無効ロール `"hacker"` でエラー。(6)(7) Reviewer と Scribe の allowedTools に `Bash` で始まる文字列が含まれないことを検証 → `tests/unit/agents/agent-config.test.ts`

- [ ] T024 **GREEN 実装**: `src/agents/agent-config.ts` を作成する。`AgentConfig` を `as const` オブジェクトで 4 エージェント分定義し、`getAgentConfig(role: AgentRole): AgentConfig` 関数を export する。data-model.md のエージェント設定値テーブルに完全一致させる → `src/agents/agent-config.ts`

### 2.9 Slack 通知 (`src/notifications/slack-notifier.ts`)

> **TDD サイクル**: テスト T025 → 実装 T026

- [ ] T025 **RED テスト作成**: `tests/unit/notifications/slack-notifier.test.ts` を作成し、test-cases.md の T-SN-001〜T-SN-010 の全 10 テストケースを記述する。`globalThis.fetch` をモックする。(1) info/warn/error の各レベルで HTTP POST が正しい色（緑/黄/赤）で送信される、(2) Webhook URL 未設定で送信スキップ、(3) HTTP 500 でエラーログのみ（例外を投げない）、(4) ネットワークエラーで例外を投げない、(5) Daily digest の body フォーマット、(6) fields が空でも送信成功、(7) approval_requested に PR URL 含む、(8) contracts/slack-events.md の全 12 イベントのフォーマット検証 → `tests/unit/notifications/slack-notifier.test.ts`

- [ ] T026 **GREEN 実装**: `src/notifications/slack-notifier.ts` を作成する。`SlackNotifier` クラスを export する。`constructor(webhookUrl?: string)` で URL を受け取り、`send(notification: SlackNotification)` で `fetch()` による HTTP POST を実行する。通知レベルに応じた Slack attachment color を設定する。URL 未設定時は何もしない。HTTP エラー・ネットワークエラーはログに記録し、例外を投げない → `src/notifications/slack-notifier.ts`

**Checkpoint**: `npm run test` で Phase 2 の全テスト（16+14+6+5+11+3+29+7+10 = 101 件）が GREEN。`npm run typecheck` と `npm run lint` がエラーゼロ。

---

## Phase 3: User Story 1 — 単体エージェントによるコードレビュー自動実行 (Priority: P1) MVP

**Goal**: Orchestrator を起動し、手動/cron でレビュータスクを投入すると、Reviewer エージェントが実行され、構造化結果が保存される

**Independent Test**: 手動タスク投入 → Reviewer 実行 → タスク completed → ログに記録

### テスト作成（RED）

- [ ] T027 [P] [US1] **RED テスト**: `tests/unit/agents/dispatcher.test.ts` を作成し、test-cases.md の T-DSP-001〜T-DSP-015 の全 15 テストケースを記述する。`@anthropic-ai/claude-agent-sdk` の `query` 関数をモックする。(1) success ResultMessage でタスク completed、costUsd/turnsUsed 記録、(2) 構造化出力の Zod バリデーション成功/失敗、(3) error_max_turns/error_max_budget_usd/error_during_execution の各パターンで failed/retry、(4) AbortController タイムアウト（timeoutMs=100 で 200ms のモック）、(5) query() 例外スロー、(6) AbortController クリーンアップ、(7) allowedTools と cwd が正しく渡される、(8) パイプライン review 完了後に awaiting_approval 遷移、(9) 単体 review 完了後に completed、(10) dependsOn あり/なしで handoff 挿入有無。`npm run test` で **RED** を確認 → `tests/unit/agents/dispatcher.test.ts`

- [ ] T028 [P] [US1] **RED テスト**: `tests/unit/bridges/context-bridge.test.ts` を作成し、test-cases.md の T-CB-001〜T-CB-006 の 6 テストケースを記述する。テスト用一時ディレクトリを使う。(1) Handoff JSON 書き込み→ファイル存在、(2) 読み込み→パース成功、(3) 不在ファイル→null、(4) 壊れた JSON→バリデーション失敗+ログ、(5) ディレクトリ不在→自動作成、(6) プロンプト挿入テキスト生成 → `tests/unit/bridges/context-bridge.test.ts`

- [ ] T029 [P] [US1] **RED テスト**: `tests/unit/sources/cron-scheduler.test.ts` を作成し、test-cases.md の T-CRN-001〜T-CRN-005 の 5 テストケースを記述する。(1) 03:00 で review タスク生成、(2) 月曜 09:00 で document タスク生成、(3) 15:00 で生成なし、(4) ID が `cron-{type}-{MMDD}` 形式、(5) 同日重複で冪等スキップ → `tests/unit/sources/cron-scheduler.test.ts`

- [ ] T030 [P] [US1] **RED テスト**: `tests/unit/sources/manual-cli.test.ts` を作成し、test-cases.md の T-CLI-001〜T-CLI-006 の 6 テストケースを記述する。(1) 必須引数で成功、(2) --type 未指定でエラー、(3) 無効 type でエラー、(4) --priority 設定、(5) ID 形式 `manual-{連番}`、(6) --depends-on 設定 → `tests/unit/sources/manual-cli.test.ts`

- [ ] T031 [P] [US1] **RED テスト**: `tests/unit/safety/rate-controller.test.ts` を作成し、test-cases.md の T-RC2-001〜T-RC2-008 の 8 テストケースを記述する。(1) enabled=false でスルー、(2) クールダウン挿入、(3) クールダウン不要、(4) ウィンドウ上限到達、(5) 5h リセット、(6) カウント増加、(7) Rate limit 接近通知、(8) lastTaskTime 更新。時間依存のテストは `vi.useFakeTimers()` を使用する → `tests/unit/safety/rate-controller.test.ts`

- [ ] T032 [P] [US1] **RED テスト**: `tests/unit/safety/circuit-breaker.test.ts` を作成し、test-cases.md の T-CB2-001〜T-CB2-010 の 10 テストケースを記述する。(1) 初期 CLOSED、(2) 成功でリセット、(3) 失敗でカウント増加、(4) 5 回連続で OPEN、(5) OPEN で拒否、(6) 1h 後 HALF_OPEN、(7) HALF_OPEN 成功→CLOSED、(8) HALF_OPEN 失敗→OPEN、(9) 成功挟み、(10) remainingMs → `tests/unit/safety/circuit-breaker.test.ts`

- [ ] T033 [P] [US1] **RED テスト**: `tests/unit/safety/budget-guard.test.ts` を作成し、test-cases.md の T-BG-001〜T-BG-006 の 6 テストケースを記述する → `tests/unit/safety/budget-guard.test.ts`

### 実装（GREEN）

- [ ] T034 [US1] **GREEN 実装**: `src/bridges/context-bridge.ts` を作成する。`writeHandoff(handoff: Handoff, dir: string)` と `readHandoff(taskId: string, agent: string, dir: string): Handoff | null` と `buildPromptInsert(handoff: Handoff): string` を export する。`node:fs` でファイル読み書きし、Zod でバリデーション。T028 が GREEN になることを確認 → `src/bridges/context-bridge.ts`

- [ ] T035 [US1] **GREEN 実装**: `src/safety/rate-controller.ts` を作成する。`RateController` クラスを export する。`constructor(enabled, cooldownMs, maxTasksPerWindow)` で設定を受け取り、`waitIfNeeded(): Promise<void>` で クールダウン挿入 + ウィンドウ上限チェックを行う。`SlackNotifier` への依存を注入する。T031 が GREEN になることを確認 → `src/safety/rate-controller.ts`

- [ ] T036 [US1] **GREEN 実装**: `src/safety/circuit-breaker.ts` を作成する。`CircuitBreaker` クラスを export する。状態（CLOSED/OPEN/HALF_OPEN）を管理し、`recordSuccess()`, `recordFailure()`, `canExecute(): boolean`, `getRemainingMs(): number` メソッドを提供する。T032 が GREEN になることを確認 → `src/safety/circuit-breaker.ts`

- [ ] T037 [US1] **GREEN 実装**: `src/safety/budget-guard.ts` を作成する。`BudgetGuard` クラスを export する。`canExecute(): boolean` と `recordCost(usd: number)` を提供する。T033 が GREEN になることを確認 → `src/safety/budget-guard.ts`

- [ ] T037a [P] [US1] **RED テスト**: `tests/unit/agents/worktree-manager.test.ts` を作成する。(1) worktree が存在しない場合に `git worktree add` で作成される、(2) タスク用ブランチ `agent/{role}/{taskId}` が作成される、(3) 既存の worktree がある場合は再利用（新ブランチのみ作成）、(4) 前回タスクの残骸ブランチが存在する場合はクリーンアップ後に新ブランチ作成、(5) タスク完了後に worktree 内の未コミット変更がない場合はブランチ削除。`child_process.execSync` をモックする → `tests/unit/agents/worktree-manager.test.ts`

- [ ] T037b [US1] **GREEN 実装**: `src/agents/worktree-manager.ts` を作成する。`WorktreeManager` クラスを export する。`prepare(role: AgentRole, taskId: string): string` で worktree パスを返す（存在確認→ブランチ作成→パス返却）。`cleanup(role: AgentRole, taskId: string)` でブランチ削除。`child_process.execSync` で `git worktree add/remove`, `git branch -D` を実行する。T037a が GREEN になることを確認 → `src/agents/worktree-manager.ts`

- [ ] T038 [US1] **GREEN 実装**: `src/agents/dispatcher.ts` を作成する。`Dispatcher` クラスを export する。`dispatch(task: Task, config: AgentConfig): Promise<DispatchResult>` メソッドで Agent SDK `query()` を呼び出す。`AbortController` + `setTimeout` でタイムアウト、`finally` で `clearTimeout`。ResultMessage の subtype で分岐し、success 時は `structured_output` を Zod バリデーション。パイプライン review 完了時は `awaiting_approval` に遷移。T027 が GREEN になることを確認 → `src/agents/dispatcher.ts`

- [ ] T039 [US1] **GREEN 実装**: `src/sources/cron-scheduler.ts` を作成する。`CronScheduler` クラスを export する。`checkAndCreateTasks(now: Date, queue: TaskQueue)` で時刻に応じたタスク生成と冪等チェック。T029 が GREEN になることを確認 → `src/sources/cron-scheduler.ts`

- [ ] T040 [US1] **GREEN 実装**: `src/sources/manual-cli.ts` を作成する。`process.argv` をパースし、`--type`, `--title`, `--description`, `--priority`, `--depends-on` を受け取り、`TaskQueue.push()` でキューに投入する。T030 が GREEN になることを確認 → `src/sources/manual-cli.ts`

- [ ] T040a [US1] `package.json` の `scripts` に `"task:add": "node dist/src/sources/manual-cli.js"` を追加する。`npm run task:add -- --type review --title "test" --description "test"` で実行できることを確認する → `package.json`

- [ ] T041 [US1] **GREEN 実装**: `src/orchestrator.ts` を作成する。`Orchestrator` クラスを export する。`start()` でメインループを開始し、(1) `CronScheduler.checkAndCreateTasks()`, (2) `TaskQueue.getNext()`, (3) 安全チェック（CircuitBreaker, RateController, BudgetGuard）, (4) **Semaphore で同時実行数を `MAX_CONCURRENT` に制限**（`Promise` ベースの簡易 Semaphore を実装）, (5) `Dispatcher.dispatch()`, (6) 結果に応じたステータス更新。`stop()` で graceful shutdown（実行中タスクの完了を待機）。起動時に `TaskQueue.recoverFromCrash()` を呼ぶ → `src/orchestrator.ts`

- [ ] T042 [US1] **GREEN 実装**: `src/index.ts` を作成する。`loadConfig()` → DB 初期化 → `Orchestrator` 生成 → `orchestrator.start()`。`SIGTERM`/`SIGINT` で `orchestrator.stop()` → `src/index.ts`

### 統合テスト

- [ ] T043 [US1] **統合テスト**: `tests/integration/orchestrator.test.ts` を作成し、test-cases.md の T-ORC-001〜T-ORC-002, T-ORC-007〜T-ORC-010 を記述する。Agent SDK と Slack をモックし、(1) 空キューで 1 サイクル、(2) review タスク投入→Reviewer 実行→completed、(3) 起動時クラッシュ復旧、(4) Semaphore 同時実行制限、(5) SIGTERM graceful shutdown。**モックされた Orchestrator の 1 サイクルが正常動作すること**を確認 → `tests/integration/orchestrator.test.ts`

- [ ] T044 [US1] `tests/unit/index.test.ts` を作成し、test-cases.md の T-IDX-001〜T-IDX-005 の 5 テストケースを記述・実装する → `tests/unit/index.test.ts`

**Checkpoint**: US1 完了。手動タスク投入 → Reviewer 実行（モック）→ タスク completed。全テスト GREEN。

---

## Phase 4: User Story 2 — 複数エージェントのパイプライン連携 (Priority: P2)

**Goal**: GitHub Issue → Classifier 分類 → Reviewer → 設計PR → 人間承認 → Fixer → 最終PR → Slack 通知

**Independent Test**: `ai-task` + `bug` ラベル Issue → パイプライン全フロー（承認ゲート含む）

### テスト作成（RED）

- [ ] T045 [P] [US2] **RED テスト**: `tests/unit/agents/classifier.test.ts` を作成し、test-cases.md の T-CLS-001〜T-CLS-010 の全 10 テストケース + 追加 1 ケースを記述する。Agent SDK `query()` と `octokit.issues.createComment()` をモックする。(1) bug ラベル→fix(single)、(2) feature→pipeline、(3) docs→document、(4) ラベルなし→Haiku で本文分析、(5) 空 body→unclear、(6) 短 body→unclear、(7) API エラー→unclear、(8) 不正 JSON→unclear、(9) pipeline の依存関係、(10) model="haiku"、**(11) unclear 判定時に `octokit.issues.createComment()` が質問テキスト付きで呼ばれる** → `tests/unit/agents/classifier.test.ts`

- [ ] T046 [P] [US2] **RED テスト**: `tests/unit/sources/github-poller.test.ts` を作成し、test-cases.md の T-GHP-001〜T-GHP-013 の全 13 テストケースを記述する。`@octokit/rest` をモックする。**Issue ポーリング**: (1) ai-task Issue 検出、(2) ラベルなし無視、(3) 処理済み重複無視、(4) 複数一括、(5) 5xx エラー、(6) 403 レート制限、(7) ネットワークエラー。**PR approve 監視**: (8) approved→後続 pending、(9) changes_requested→変更なし、(10) closed→failed、(11) awaiting_approval なし→スキップ、(12) 複数待機→個別確認、(13) PR API エラー → `tests/unit/sources/github-poller.test.ts`

- [ ] T047 [P] [US2] **RED テスト**: `tests/unit/bridges/result-collector.test.ts` を作成し、test-cases.md の T-RC-001〜T-RC-008 の 8 テストケースを記述する。Octokit と SlackNotifier をモック。(1) 設計 PR 作成→approval_requested 通知、(2) 最終 PR→pipeline_pr_created、(3) 単体 PR→task_completed、(4) diff 500 行以下→成功、(5) 600 行→拒否、(6) PR API エラー、(7) エビデンス含有、(8) Slack 未設定→スキップ → `tests/unit/bridges/result-collector.test.ts`

- [ ] T048 [P] [US2] **RED テスト**: `tests/contract/handoff-schema.test.ts` を作成し、test-cases.md の T-CTR-001〜T-CTR-007 の全 7 テストケースを記述する。(1) Reviewer handoff スキーマ、(2) Fixer、(3) Builder、(4) Scribe、(5) Slack 全 12 イベント、(6) Classification single、(7) Classification pipeline → `tests/contract/handoff-schema.test.ts`

### 実装（GREEN）

- [ ] T049 [US2] **GREEN 実装**: `src/agents/classifier.ts` を作成する。`Classifier` クラスを export する。`classify(issue: { title, body, labels })` メソッドで (1) ラベルベース判定（bug→fix, feature→pipeline, docs→document）、(2) **ラベルで判定できない場合は Haiku サブエージェントに Issue のタイトルと本文を渡し、タスク種別と複雑度を判定させる**（FR-002 対応）、(3) Zod バリデーション、(4) **unclear 判定時は GitHub Issue にコメントで質問を自動投稿する**（FR-004 対応: `octokit.issues.createComment()` を呼び出す）。Agent SDK `query()` に `model: "haiku"`, `maxTurns: 1` を設定。T045 が GREEN になることを確認 → `src/agents/classifier.ts`

- [ ] T050 [US2] **GREEN 実装**: `src/sources/github-poller.ts` を作成する。`GitHubPoller` クラスを export する。`pollIssues()` で `ai-task` ラベル Issue を取得し、`isDuplicate()` チェック後に Classifier → キュー投入。`pollApprovals()` で `awaiting_approval` タスクの PR レビューステータスを確認し、approve/reject/close に応じて状態遷移。API エラーはログのみで例外を投げない。T046 が GREEN になることを確認 → `src/sources/github-poller.ts`

- [ ] T051 [US2] **GREEN 実装**: `src/bridges/result-collector.ts` を作成する。`ResultCollector` クラスを export する。`createDesignPR(task, handoff)` で設計 PR 作成→Slack approval_requested、`createFinalPR(tasks)` で最終 PR→Slack pipeline_pr_created、`createSinglePR(task)` で単体 PR→task_completed。diff サイズチェック（500 行上限）。PR body にエビデンス（テスト結果ログ）を含める。T047 が GREEN になることを確認 → `src/bridges/result-collector.ts`

- [ ] T052 [US2] **GREEN 実装**: T048 の contract テストに対応する Zod スキーマ（Reviewer/Fixer/Builder/Scribe の各 Handoff data スキーマ）を `src/types.ts` に追加する。T048 が GREEN になることを確認 → `src/types.ts`

### 統合テスト

- [ ] T053 [US2] **統合テスト**: `tests/integration/github-poller.test.ts` を作成する。Octokit と Agent SDK をモックし、(1) Issue 検出→分類→キュー投入→エージェント実行のエンドツーエンド、(2) PR approve→後続タスク起動のフロー。test-cases.md の T-ORC-003, T-ORC-011 に対応 → `tests/integration/github-poller.test.ts`

- [ ] T054 [US2] **統合テスト**: `tests/integration/dispatcher.test.ts` を作成する。Agent SDK モック + DB でパイプライン全フロー（Reviewer→awaiting_approval→approve→Fixer→completed）を検証。test-cases.md の T-ORC-003 に対応 → `tests/integration/dispatcher.test.ts`

- [ ] T055 [US2] **GREEN 実装**: `src/orchestrator.ts` を更新し、メインループに `GitHubPoller.pollIssues()` と `GitHubPoller.pollApprovals()` を統合する。ポーリング間隔 5 分で実行する。既存の US1 テストが引き続き GREEN であることを確認する

**Checkpoint**: US2 完了。GitHub Issue → 分類 → パイプライン → 設計PR → 承認→ Fixer → 最終PR。全テスト GREEN。

---

## Phase 5: User Story 3 — 4エージェントフルチームによる新機能実装 (Priority: P3)

**Goal**: `feature` Issue → review → 設計PR承認 → build → document → 最終PR

**Independent Test**: feature Issue → 3 ステップパイプライン全フロー

### テスト作成 & 実装

- [ ] T056 [P] [US3] **RED テスト**: `tests/integration/full-pipeline.test.ts` を作成する。Agent SDK, Octokit, Slack をモックし、(1) feature Issue → Classifier が review→build→document の 3 ステップに分解、(2) Reviewer 完了→設計PR→approve→Builder→Scribe→最終PR、(3) Builder の diff が 500 行超過→分割要求。test-cases.md の T-ORC-003 の完全版 → `tests/integration/full-pipeline.test.ts`

- [ ] T057 [US3] `src/agents/classifier.ts` の `classify()` を更新し、`feature`/`enhancement` ラベルで `review → build → document` の 3 ステップパイプラインを生成するようにする。T045 の T-CLS-002 テストケースが GREEN になることを確認

- [ ] T058 [US3] `src/agents/dispatcher.ts` を更新し、Builder と Scribe のエージェント実行をサポートする。Builder の `cwd` は `WORKTREE_DIR/builder`、Scribe は `WORKTREE_DIR/scribe` を使用する。`getAgentConfig()` で正しい設定が適用されることを確認

- [ ] T059 [US3] `src/bridges/result-collector.ts` を更新し、3 エージェント以上のパイプライン最終PR作成をサポートする。全エージェントの変更を含む PR を作成する。T056 が GREEN になることを確認

**Checkpoint**: US3 完了。feature Issue → review → build → document → PR。全テスト GREEN。

---

## Phase 6: User Story 4 — 安全な24時間無人運用 (Priority: P4)

**Goal**: systemd 常駐化、Circuit Breaker/Rate Controller の本番統合、Daily digest

### テスト作成 & 実装

- [ ] T060 [P] [US4] **RED テスト → GREEN 実装**: Daily digest 集計テストを `tests/unit/queue/task-queue.test.ts` に追加する（T-TQ-027 がまだ通っていなければ修正）。`getDailyDigest()` が完了数・失敗数・コスト合計・PR 数・平均所要時間・未承認PR件数を正しく返すことを検証

- [ ] T061 [P] [US4] **RED テスト → GREEN 実装**: `src/orchestrator.ts` に Daily digest 送信を追加する。毎日 08:00 に `getDailyDigest()` → `SlackNotifier.send(daily_digest)` を呼び出す。`vi.useFakeTimers()` でテスト。test-cases.md の T-ORC-013 に対応

- [ ] T062 [P] [US4] **RED テスト → GREEN 実装**: `src/orchestrator.ts` の安全機構統合テストを追加する。(1) Circuit Breaker OPEN 中はタスクを取り出さない（T-ORC-004）、(2) Rate Controller クールダウン中は sleep 後に実行（T-ORC-005）、(3) Budget Guard 停止中はタスクを取り出さない（T-ORC-006）。各安全機構の `canExecute()` をモック/スパイし、Orchestrator のメインループが正しく制御されることを検証

- [ ] T063 [US4] `ai-engineer.service` systemd ユニットファイルを作成する。以下の設定を記述する: `[Unit] Description=AI Engineering Team Orchestrator, After=network.target`, `[Service] Type=simple, WorkingDirectory=/home/user/ai-engineer, EnvironmentFile=/home/user/ai-engineer/.env, ExecStart=/usr/bin/node /home/user/ai-engineer/dist/src/index.js, Restart=always, RestartSec=30`, `[Install] WantedBy=default.target`。設計書 `AI_Engineering_Team_設計書_v2.1.md` セクション 12.5 を参照 → `ai-engineer.service`

- [ ] T064 [US4] `src/orchestrator.ts` の `start()` にログローテーション呼び出しを追加する。**起動時**に `rotateOldLogs()` を実行し、さらに**毎日 00:00 に定期実行**するスケジュールをメインループに追加する（FR-027 の 30 日保持 + 自動削除を長時間稼働中も保証する）

**Checkpoint**: US4 完了。安全機構が Orchestrator に統合され、systemd で常駐化可能。全テスト GREEN。

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: コード品質改善、最終統合テスト、ドキュメント

- [ ] T065 [P] `npm run typecheck` を実行し、型エラーがゼロであることを確認する。エラーがあれば修正する

- [ ] T066 [P] `npm run lint` を実行し、ESLint エラーがゼロであることを確認する。エラーがあれば修正する

- [ ] T067 [P] `npm run test -- --coverage` を実行し、カバレッジが statements/branches/functions/lines すべて 100% であることを確認する。未カバーの行があれば追加テストを作成する

- [ ] T068 全テストの実行ログをファイルに保存する: `npm run test -- --reporter=verbose 2>&1 | tee test-results.log`。このファイルを PR のエビデンスとして添付する

- [ ] T069 `quickstart.md` の手順に従って、開発環境での手動動作確認を実施する。(1) `npm run build` 成功、(2) `npm run dev` で Orchestrator 起動、(3) 手動タスク投入でログ出力を確認。確認結果のスクリーンショットまたはログを保存する

- [ ] T070 PR を作成する。PR 説明に以下を含める: (1) 変更内容のサマリ、(2) `test-results.log` の全文または要約、(3) カバレッジレポート（100%）、(4) 動作確認のスクリーンショット/ログ

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories
- **User Stories (Phase 3-6)**: All depend on Foundational phase completion
  - US1 (Phase 3): Can start after Phase 2
  - US2 (Phase 4): Depends on US1 completion (Dispatcher, Context Bridge を利用)
  - US3 (Phase 5): Depends on US2 completion (Classifier, GitHub Poller を利用)
  - US4 (Phase 6): Can start after Phase 2 (独立した安全機構)、ただし統合は US1 以降
- **Polish (Phase 7)**: Depends on all user stories completion

### Within Each Phase (TDD Cycle)

1. **RED**: テストを先に書く → `npm run test` で全テスト FAIL
2. **GREEN**: 実装 → `npm run test` で全テスト PASS
3. **REFACTOR**: コード品質改善（必要な場合のみ）→ テストが引き続き PASS

### Parallel Opportunities

**Phase 2 内の並列**:
- T009/T010 (types) と T011/T012 (env-config) と T013/T014 (logger) は並列可能
- T017/T018 (schema) は types に依存
- T021/T022 (task-queue) は schema に依存

**Phase 3 内の並列**:
- T027〜T033 のテスト作成はすべて並列可能（異なるファイル）
- T034〜T040 の実装は一部並列可能（context-bridge, rate-controller, circuit-breaker, budget-guard は独立）
- T038 (dispatcher) は T034 (context-bridge) に依存

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (TDD で全基盤モジュール)
3. Complete Phase 3: User Story 1 (TDD で単体 Reviewer)
4. **STOP and VALIDATE**: 手動タスク投入 → Reviewer 実行 → completed
5. PR 作成 → レビュー → 承認後に US2 へ

### Incremental Delivery

1. Phase 1 + 2 → 基盤完成 → PR
2. Phase 3 (US1) → MVP → PR
3. Phase 4 (US2) → パイプライン → PR
4. Phase 5 (US3) → フルチーム → PR
5. Phase 6 (US4) → 本番運用 → PR
6. Phase 7 → 品質仕上げ → Final PR

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- **TDD 厳守**: RED → GREEN → REFACTOR。テストが先、実装が後
- **1 タスク = 1 ファイル**: 迷ったらファイル単位で区切る
- テスト内の外部依存（Agent SDK, GitHub API, Slack, ファイルシステム）はすべてモック/スタブ化する
- `better-sqlite3` のテストでは必ず `:memory:` DB を使い、テスト間の状態汚染を防ぐ
- 各 Phase の Checkpoint で `npm run test && npm run typecheck && npm run lint` を実行して全パスを確認する
- Commit after each task or logical group (RED+GREEN ペア)
