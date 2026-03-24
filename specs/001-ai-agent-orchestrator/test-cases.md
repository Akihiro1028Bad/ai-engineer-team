# Test Cases: AI Agent Orchestrator

**目標**: 全モジュールのステートメントカバレッジ 100%
**フレームワーク**: Vitest + インメモリ SQLite (`:memory:`)
**方針**: 外部依存（Agent SDK, GitHub API, Slack Webhook）はすべてモック化。境界値・異常系を網羅。

---

## 1. `src/types.ts` — 共通型定義

### 1.1 Zod スキーマバリデーション

| # | テストケース | 入力 | 期待結果 |
|---|------------|------|---------|
| T-TYP-001 | TaskType の有効値を受け入れる | `"review"`, `"fix"`, `"build"`, `"document"` | すべて safeParse 成功 |
| T-TYP-002 | TaskType の無効値を拒否する | `"deploy"`, `""`, `null` | safeParse 失敗、適切なエラーメッセージ |
| T-TYP-003 | TaskStatus の全有効値を受け入れる | `"pending"`, `"in_progress"`, `"completed"`, `"failed"`, `"awaiting_approval"` | すべて成功 |
| T-TYP-004 | TaskStatus の無効値を拒否する | `"cancelled"`, `"unknown"` | safeParse 失敗 |
| T-TYP-005 | CreateTaskInput の必須フィールド検証 | `id`, `taskType`, `title`, `description`, `source` を欠落 | 各フィールド欠落ごとに失敗 |
| T-TYP-006 | CreateTaskInput のオプションフィールド | `priority`, `dependsOn`, `parentTaskId` 省略 | デフォルト値適用で成功 |
| T-TYP-007 | Task の priority 範囲 | `0`, `1`, `5`, `10`, `11` | 1-10 のみ成功、0 と 11 は失敗 |
| T-TYP-008 | AgentRole の全値を受け入れる | `"reviewer"`, `"fixer"`, `"builder"`, `"scribe"` | すべて成功 |
| T-TYP-009 | Handoff スキーマのバリデーション | 有効な handoff JSON | taskId, agent, timestamp, data すべて検証成功 |
| T-TYP-010 | Handoff スキーマで data が空オブジェクト | `{ data: {} }` | 成功（data は任意構造） |
| T-TYP-011 | Classification スキーマ — single | `{ complexity: "single", taskType: "review" }` | 成功 |
| T-TYP-012 | Classification スキーマ — pipeline | `{ complexity: "pipeline", subTasks: [...] }` | 成功 |
| T-TYP-013 | Classification スキーマ — unclear | `{ complexity: "unclear", question: "..." }` | 成功 |
| T-TYP-014 | Classification — pipeline で subTasks が空配列 | `{ complexity: "pipeline", subTasks: [] }` | 失敗（1つ以上必要） |
| T-TYP-015 | SlackNotification スキーマ | 有効な通知オブジェクト | level, event, title, body 検証成功 |
| T-TYP-016 | SlackNotification の level 無効値 | `level: "critical"` | 失敗 |

---

## 2. `src/config/env-config.ts` — 環境変数バリデーション

| # | テストケース | 入力 | 期待結果 |
|---|------------|------|---------|
| T-ENV-001 | 全必須変数が揃っている（Max プラン） | RATE_CONTROL_ENABLED=true, GITHUB_TOKEN, GITHUB_REPO, PROJECT_DIR, WORKTREE_DIR | 成功 |
| T-ENV-002 | 全必須変数が揃っている（API 課金） | ANTHROPIC_API_KEY, RATE_CONTROL_ENABLED=false, DAILY_BUDGET_USD | 成功 |
| T-ENV-003 | GITHUB_TOKEN が未設定 | GITHUB_TOKEN 欠落 | エラー: "GITHUB_TOKEN is required" |
| T-ENV-004 | PROJECT_DIR が未設定 | PROJECT_DIR 欠落 | エラー: "PROJECT_DIR is required" |
| T-ENV-005 | WORKTREE_DIR が未設定 | WORKTREE_DIR 欠落 | エラー: "WORKTREE_DIR is required" |
| T-ENV-006 | GITHUB_REPO が未設定 | GITHUB_REPO 欠落 | エラー |
| T-ENV-007 | Max プランと API Key の同時設定 | ANTHROPIC_API_KEY + RATE_CONTROL_ENABLED=true | エラー: "ANTHROPIC_API_KEY と Max プランを同時に設定できません" |
| T-ENV-008 | DAILY_BUDGET_USD が負の値 | `-5.0` | エラー: 正の数値が必要 |
| T-ENV-009 | MAX_CONCURRENT が 0 | `0` | エラー: 1以上が必要 |
| T-ENV-010 | MAX_CONCURRENT のデフォルト値 | 未設定 | デフォルト `1` が適用 |
| T-ENV-011 | RATE_COOLDOWN_SECONDS のデフォルト値 | 未設定 | デフォルト `60` が適用 |
| T-ENV-012 | SLACK_WEBHOOK_URL が未設定（任意） | 欠落 | 成功（Slack 通知は無効化） |
| T-ENV-013 | SLACK_WEBHOOK_URL が不正な URL | `"not-a-url"` | エラー: 有効な URL が必要 |
| T-ENV-014 | GITHUB_REPO の形式検証 | `"org/repo"` → 成功、`"invalid"` → 失敗 | `owner/repo` 形式のみ受け入れ |

---

## 3. `src/queue/schema.ts` — DB スキーマ初期化

| # | テストケース | 入力 | 期待結果 |
|---|------------|------|---------|
| T-SCH-001 | 新規 DB でテーブル作成 | 空の `:memory:` DB | tasks テーブルが存在 |
| T-SCH-002 | WAL モードが有効化される | スキーマ初期化後 | `PRAGMA journal_mode` = `wal` |
| T-SCH-003 | インデックスが作成される | スキーマ初期化後 | `idx_tasks_status`, `idx_tasks_priority`, `idx_tasks_depends_on`, `idx_tasks_parent` が存在 |
| T-SCH-004 | 二重初期化しても安全 | 2回連続 `initSchema()` | エラーなし（IF NOT EXISTS） |
| T-SCH-005 | CHECK 制約 — 無効な task_type | `INSERT ... task_type='invalid'` | SQLITE_CONSTRAINT エラー |
| T-SCH-006 | CHECK 制約 — 無効な status | `INSERT ... status='cancelled'` | SQLITE_CONSTRAINT エラー |
| T-SCH-007 | CHECK 制約 — priority 範囲外 | `priority=0`, `priority=11` | SQLITE_CONSTRAINT エラー |
| T-SCH-008 | CHECK 制約 — retry_count 上限 | `retry_count=4` | SQLITE_CONSTRAINT エラー |
| T-SCH-009 | デフォルト値 — priority | INSERT 時に priority 未指定 | `5` が適用 |
| T-SCH-010 | デフォルト値 — status | INSERT 時に status 未指定 | `"pending"` が適用 |
| T-SCH-011 | デフォルト値 — created_at | INSERT 時に created_at 未指定 | 現在時刻が ISO 形式で設定 |

---

## 4. `src/queue/task-queue.ts` — タスクキュー CRUD

### 4.1 タスク追加

| # | テストケース | 入力 | 期待結果 |
|---|------------|------|---------|
| T-TQ-001 | 単体タスクを追加 | 有効な CreateTaskInput | DB に挿入、status=pending |
| T-TQ-002 | 依存関係付きタスクを追加 | `dependsOn: "gh-42-0"` | 依存先タスクが存在すれば成功 |
| T-TQ-003 | 重複 ID のタスク追加 | 同一 ID で 2 回追加 | 2 回目でエラー（PK 重複） |
| T-TQ-004 | パイプラインサブタスクを一括追加 | 3 つのサブタスク（review→fix→document） | 全タスク追加、依存関係正しく設定 |

### 4.2 次タスク取得

| # | テストケース | 入力 | 期待結果 |
|---|------------|------|---------|
| T-TQ-005 | pending タスクがない場合 | 空のキュー | `null` を返す |
| T-TQ-006 | 単一 pending タスクの取得 | 1 タスク（pending） | そのタスクを返す |
| T-TQ-007 | 優先度順の取得 | priority=3 と priority=1 | priority=1 が先に返る |
| T-TQ-008 | 同一優先度は作成順 | 同一 priority で 2 タスク | created_at が古い方が先 |
| T-TQ-009 | 依存タスクが未完了の場合はスキップ | タスク B が A に依存、A は pending | B は取得されない |
| T-TQ-010 | 依存タスクが完了の場合は取得 | タスク B が A に依存、A は completed | B が取得される |
| T-TQ-011 | 依存タスクが failed の場合はスキップ | タスク B が A に依存、A は failed | B は取得されない |
| T-TQ-012 | awaiting_approval の後続はスキップ | タスク A が awaiting_approval、B が A に依存 | B は取得されない |

### 4.3 ステータス更新

| # | テストケース | 入力 | 期待結果 |
|---|------------|------|---------|
| T-TQ-013 | pending → in_progress | `updateStatus(id, "in_progress")` | status 更新、startedAt 設定 |
| T-TQ-014 | in_progress → completed | 結果データ付き | status, result, costUsd, turnsUsed, completedAt 更新 |
| T-TQ-015 | in_progress → awaiting_approval | approvalPrUrl 付き | status, approvalPrUrl 更新 |
| T-TQ-016 | in_progress → pending（リトライ） | retryCount < 3 | status=pending, retryCount+1, startedAt=null |
| T-TQ-017 | in_progress → failed（リトライ上限） | retryCount >= 3 | status=failed |
| T-TQ-018 | awaiting_approval → completed（承認後の後続タスク起動） | approve 検出 | 後続タスクを pending に遷移 |
| T-TQ-019 | awaiting_approval → failed（却下） | reject 検出 | 後続タスク全体を failed に遷移 |

### 4.4 クラッシュ復旧

| # | テストケース | 入力 | 期待結果 |
|---|------------|------|---------|
| T-TQ-020 | in_progress タスクを pending にリセット | 2 つの in_progress タスク | 全て pending、retryCount+1 |
| T-TQ-021 | リセット後に retryCount > 3 のタスクを failed に | retryCount=3 のタスクをリセット | retryCount=4 → failed に遷移 |
| T-TQ-022 | awaiting_approval タスクはリセットしない | awaiting_approval のタスク | 変更なし |
| T-TQ-023 | completed/failed タスクはリセットしない | completed と failed のタスク | 変更なし |

### 4.5 クエリ・集計

| # | テストケース | 入力 | 期待結果 |
|---|------------|------|---------|
| T-TQ-024 | 冪等性チェック — Issue ID で重複検出 | source=`github_issue:42` で 2 回追加 | 2 回目は `false` を返す（追加しない） |
| T-TQ-025 | タスク一覧取得（ステータスフィルタ） | status=pending | pending のみ返す |
| T-TQ-026 | awaiting_approval のタスク一覧取得 | PR URL 付きタスク | approvalPrUrl を含むタスク一覧 |
| T-TQ-027 | Daily digest 用集計 | 完了3件、失敗1件 | 正しい集計値 |
| T-TQ-028 | パイプラインの後続タスク一括キャンセル | parentTaskId で後続取得 | 全後続タスクを failed に更新 |
| T-TQ-029 | トランザクション — 複数操作の原子性 | 一括追加中にエラー | 全操作がロールバック |

---

## 5. `src/queue/migrations.ts` — スキーマバージョン管理

| # | テストケース | 入力 | 期待結果 |
|---|------------|------|---------|
| T-MIG-001 | 初回マイグレーション実行 | バージョンテーブルなし | テーブル作成、バージョン=1 |
| T-MIG-002 | マイグレーション済みの場合はスキップ | 最新バージョン | 何もしない |
| T-MIG-003 | 中間バージョンからの差分適用 | バージョン=1 → 最新 | 差分マイグレーションのみ実行 |

---

## 6. `src/agents/agent-config.ts` — エージェント定義

| # | テストケース | 入力 | 期待結果 |
|---|------------|------|---------|
| T-AC-001 | Reviewer の設定値が正しい | `getAgentConfig("reviewer")` | allowedTools=[Read,Glob,Grep], permissionMode="dontAsk", maxTurns=15, maxBudgetUsd=0.50, timeoutMs=600000 |
| T-AC-002 | Fixer の設定値が正しい | `getAgentConfig("fixer")` | maxTurns=30, maxBudgetUsd=1.00, Bash(npm test *) を含む |
| T-AC-003 | Builder の設定値が正しい | `getAgentConfig("builder")` | maxTurns=50, maxBudgetUsd=2.00, Bash(git commit *) を含む |
| T-AC-004 | Scribe の設定値が正しい | `getAgentConfig("scribe")` | allowedTools に Bash を含まない, permissionMode="acceptEdits" |
| T-AC-005 | 無効なロール | `getAgentConfig("hacker")` | エラー: 不明なエージェントロール |
| T-AC-006 | Reviewer に Bash が含まれないことを検証 | Reviewer の allowedTools | `Bash` で始まるツールが 0 件 |
| T-AC-007 | Scribe に Bash が含まれないことを検証 | Scribe の allowedTools | `Bash` で始まるツールが 0 件 |

---

## 7. `src/agents/dispatcher.ts` — Agent SDK query() ラッパー

| # | テストケース | 入力 | 期待結果 |
|---|------------|------|---------|
| T-DSP-001 | 正常実行 — success 結果 | モック query() → success ResultMessage | タスク completed、costUsd/turnsUsed/durationMs 記録 |
| T-DSP-002 | 構造化出力の Zod バリデーション成功 | 有効な structured_output | バリデーション通過、result に保存 |
| T-DSP-003 | 構造化出力の Zod バリデーション失敗 | 不正な structured_output | タスク failed、バリデーションエラーをログ |
| T-DSP-004 | error_max_turns | モック → error_max_turns | タスク failed/retry、エラーメッセージ記録 |
| T-DSP-005 | error_max_budget_usd | モック → error_max_budget_usd | タスク failed/retry |
| T-DSP-006 | error_during_execution | モック → error_during_execution | タスク failed/retry |
| T-DSP-007 | AbortController タイムアウト | timeoutMs=100、モックが 200ms | AbortError 発生、タスク failed/retry |
| T-DSP-008 | query() が例外をスロー | モック → throw Error | catch で処理、タスク failed/retry |
| T-DSP-009 | AbortController のクリーンアップ | 正常終了 | clearTimeout が呼ばれる |
| T-DSP-010 | query() に allowedTools が正しく渡される | Reviewer タスク | options.allowedTools = ["Read","Glob","Grep"] |
| T-DSP-011 | query() に cwd（worktree パス）が正しく渡される | Fixer タスク | options.cwd = WORKTREE_DIR/fixer |
| T-DSP-012 | パイプラインタスク — Reviewer 完了後に設計PR作成 | pipeline の review タスク完了 | awaiting_approval に遷移、PR 作成呼び出し |
| T-DSP-013 | 単体タスク — 完了後に最終PR作成 | single の review タスク完了 | completed に遷移、PR 作成なし |
| T-DSP-014 | Context Bridge 読み込み — 依存タスクの handoff | dependsOn あり | プロンプトに handoff JSON が挿入される |
| T-DSP-015 | Context Bridge 読み込み — 依存なし | dependsOn なし | プロンプトに handoff 挿入なし |

---

## 8. `src/agents/classifier.ts` — Issue 分類

| # | テストケース | 入力 | 期待結果 |
|---|------------|------|---------|
| T-CLS-001 | bug ラベル → fix タスク（single） | Issue(labels=["bug","ai-task"]) | `{ complexity: "single", taskType: "fix" }` |
| T-CLS-002 | feature ラベル → pipeline（review→build→document） | Issue(labels=["feature","ai-task"]) | `{ complexity: "pipeline", subTasks: [review, build, document] }` |
| T-CLS-003 | docs ラベル → document タスク | Issue(labels=["documentation","ai-task"]) | `{ complexity: "single", taskType: "document" }` |
| T-CLS-004 | ラベルなし → Haiku で本文から判定 | Issue(labels=["ai-task"], body="バグ修正") | Haiku モックの分類結果を返す |
| T-CLS-005 | 空の Issue 本文 → unclear | Issue(body="") | `{ complexity: "unclear", question: "..." }` |
| T-CLS-006 | 極端に短い Issue → unclear | Issue(body="fix") | `{ complexity: "unclear", question: "..." }` |
| T-CLS-007 | Haiku API エラー | モック → throw Error | エラーハンドリング、unclear として処理 |
| T-CLS-008 | Haiku の出力が不正 JSON | モック → 不正レスポンス | Zod バリデーション失敗、unclear として処理 |
| T-CLS-009 | pipeline のサブタスク依存関係が正しい | feature Issue | subTasks[1].dependsOnIndex=0, subTasks[2].dependsOnIndex=1 |
| T-CLS-010 | model="haiku" が設定される | Classifier の query() 呼び出し | options.model = "haiku" |

---

## 9. `src/sources/github-poller.ts` — GitHub ポーリング

### 9.1 Issue ポーリング

| # | テストケース | 入力 | 期待結果 |
|---|------------|------|---------|
| T-GHP-001 | ai-task ラベル付き Issue を検出 | モック: Issue#42 (ai-task) | タスクキューに投入 |
| T-GHP-002 | ai-task ラベルなしは無視 | モック: Issue#43 (bug のみ) | キューに投入しない |
| T-GHP-003 | 既に処理済み Issue は無視 | source=`github_issue:42` が DB に存在 | 重複投入しない |
| T-GHP-004 | 複数 Issue を一括検出 | モック: 3 件の ai-task Issue | 3 件ともキューに投入 |
| T-GHP-005 | GitHub API 5xx エラー | モック → 500 | ログ記録のみ、例外を投げない |
| T-GHP-006 | GitHub API レート制限 (403) | モック → 403 with rate limit header | ログ記録のみ |
| T-GHP-007 | GitHub API ネットワークエラー | モック → ECONNREFUSED | ログ記録のみ |

### 9.2 PR approve 監視

| # | テストケース | 入力 | 期待結果 |
|---|------------|------|---------|
| T-GHP-008 | PR approved 検出 | モック: PR#123 状態=approved | 後続タスクを pending に遷移 |
| T-GHP-009 | PR changes_requested 検出 | モック: PR#123 状態=changes_requested | 状態変更なし（awaiting_approval のまま） |
| T-GHP-010 | PR closed（マージなし）検出 | モック: PR#123 state=closed, merged=false | パイプライン後続を failed に |
| T-GHP-011 | awaiting_approval タスクがない場合 | 空リスト | PR チェックをスキップ |
| T-GHP-012 | 複数の awaiting_approval タスク | 2 件の待機タスク | それぞれの PR を個別に確認 |
| T-GHP-013 | PR API エラー | モック → 500 | ログ記録のみ、次回リトライ |

---

## 10. `src/sources/cron-scheduler.ts` — 定期タスク

| # | テストケース | 入力 | 期待結果 |
|---|------------|------|---------|
| T-CRN-001 | 夜間レビュータスクの生成 | 03:00 トリガー | review タスクがキューに投入（source=`cron:nightly_review`） |
| T-CRN-002 | 週次ドキュメント同期タスクの生成 | 月曜 09:00 トリガー | document タスクがキューに投入 |
| T-CRN-003 | スケジュール外の時刻 | 15:00 | タスクを生成しない |
| T-CRN-004 | cron タスクの ID 形式 | 生成されたタスク | `cron-{type}-{MMDD}` 形式 |
| T-CRN-005 | 同日に重複生成しない | 03:00 に 2 回トリガー | 2 回目は冪等チェックでスキップ |

---

## 11. `src/sources/manual-cli.ts` — 手動タスク投入

| # | テストケース | 入力 | 期待結果 |
|---|------------|------|---------|
| T-CLI-001 | 必須引数で正常投入 | `--type review --title "test" --description "desc"` | タスク追加成功 |
| T-CLI-002 | type 未指定 | `--title "test"` | エラー: --type は必須 |
| T-CLI-003 | 無効な type | `--type deploy` | エラー: 無効な TaskType |
| T-CLI-004 | priority 指定 | `--priority 1` | priority=1 で追加 |
| T-CLI-005 | ID 形式 | 自動生成 | `manual-{連番}` 形式 |
| T-CLI-006 | dependsOn 指定 | `--depends-on gh-42-0` | 依存関係付きで追加 |

---

## 12. `src/bridges/context-bridge.ts` — Handoff JSON

| # | テストケース | 入力 | 期待結果 |
|---|------------|------|---------|
| T-CB-001 | Handoff JSON 書き込み | 有効な Handoff オブジェクト | ファイルが `{taskId}_{agent}.json` で作成 |
| T-CB-002 | Handoff JSON 読み込み | 既存のファイル | パース成功、Zod バリデーション通過 |
| T-CB-003 | 存在しないファイルの読み込み | 不在パス | `null` を返す |
| T-CB-004 | 不正な JSON ファイルの読み込み | 壊れた JSON | Zod バリデーション失敗、エラーログ出力 |
| T-CB-005 | handoff ディレクトリが存在しない場合 | `.claude/handoff/` なし | ディレクトリを自動作成してから書き込み |
| T-CB-006 | プロンプト挿入用テキスト生成 | Handoff データ | taskId, timestamp, JSON データを含む文字列 |

---

## 13. `src/bridges/result-collector.ts` — PR 作成 + 通知

| # | テストケース | 入力 | 期待結果 |
|---|------------|------|---------|
| T-RC-001 | 設計 PR 作成（パイプライン Reviewer 完了後） | review タスク完了 | GitHub API で PR 作成、Slack に approval_requested 通知 |
| T-RC-002 | 最終 PR 作成（パイプライン全体完了後） | 最終タスク完了 | GitHub API で PR 作成、Slack に pipeline_pr_created 通知 |
| T-RC-003 | 単体タスク完了の PR 作成 | single タスク完了 | GitHub API で PR 作成、Slack に task_completed 通知 |
| T-RC-004 | diff サイズ 500 行以下 | 変更 300 行 | PR 作成成功 |
| T-RC-005 | diff サイズ 500 行超過 | 変更 600 行 | PR 作成拒否、分割要求ログ、Slack 通知 |
| T-RC-006 | GitHub API PR 作成エラー | モック → 422 | エラーログ、タスクを failed にしない（リトライ可能） |
| T-RC-007 | PR 説明にエビデンスが含まれる | テスト結果付き | PR body にテスト実行結果ログを含む |
| T-RC-008 | Slack Webhook URL 未設定時 | env.SLACK_WEBHOOK_URL=undefined | 通知をスキップ、ログのみ |

---

## 14. `src/safety/rate-controller.ts` — レート制御

| # | テストケース | 入力 | 期待結果 |
|---|------------|------|---------|
| T-RC2-001 | enabled=false でスルー | API 課金モード | `waitIfNeeded()` が即座に返る |
| T-RC2-002 | クールダウン挿入 | 前回タスクから 30 秒後に呼び出し（cooldown=60s） | 30 秒 sleep |
| T-RC2-003 | クールダウン不要 | 前回タスクから 90 秒後（cooldown=60s） | 即座に返る |
| T-RC2-004 | ウィンドウ上限到達 | tasksInWindow=150（max=150） | ウィンドウリセットまで待機 |
| T-RC2-005 | 5h ウィンドウのリセット | windowStart が 5h 以上前 | tasksInWindow=0 にリセット |
| T-RC2-006 | タスク実行後にカウント増加 | `waitIfNeeded()` 呼び出し | tasksInWindow が +1 |
| T-RC2-007 | Rate limit 接近通知（残り 10%） | tasksInWindow=135（max=150） | Slack に rate_limit_approaching 通知 |
| T-RC2-008 | lastTaskTime の更新 | `waitIfNeeded()` 完了 | lastTaskTime が現在時刻に更新 |

---

## 15. `src/safety/circuit-breaker.ts` — サーキットブレーカー

| # | テストケース | 入力 | 期待結果 |
|---|------------|------|---------|
| T-CB2-001 | 初期状態は CLOSED | インスタンス生成直後 | state=CLOSED |
| T-CB2-002 | 成功でカウンタリセット | recordSuccess() | consecutiveFailures=0 |
| T-CB2-003 | 失敗でカウンタ増加 | recordFailure() 1 回 | consecutiveFailures=1, state=CLOSED |
| T-CB2-004 | 5 回連続失敗で OPEN | recordFailure() 5 回 | state=OPEN, Slack に circuit_breaker_open 通知 |
| T-CB2-005 | OPEN 状態でタスク実行拒否 | `canExecute()` | `false` を返す |
| T-CB2-006 | 1 時間後に HALF_OPEN | OPEN から 1h 経過 | state=HALF_OPEN |
| T-CB2-007 | HALF_OPEN で成功 → CLOSED | recordSuccess() | state=CLOSED, Slack に circuit_breaker_closed 通知 |
| T-CB2-008 | HALF_OPEN で失敗 → OPEN | recordFailure() | state=OPEN, 再度 1h 停止 |
| T-CB2-009 | 成功の間に失敗が挟まる | 成功→失敗→成功 | consecutiveFailures=0（連続ではない） |
| T-CB2-010 | OPEN 中の remainingMs 計算 | OPEN 遷移から 30 分後 | remainingMs ≈ 30 分 |

---

## 16. `src/safety/budget-guard.ts` — 日次予算ガード

| # | テストケース | 入力 | 期待結果 |
|---|------------|------|---------|
| T-BG-001 | API 課金モードで予算内 | dailySpent=5.00, limit=10.00 | `canExecute()` = true |
| T-BG-002 | API 課金モードで予算超過 | dailySpent=10.50, limit=10.00 | `canExecute()` = false, Slack に daily_budget_reached 通知 |
| T-BG-003 | Max プランでは無効 | RATE_CONTROL_ENABLED=true | `canExecute()` = true（常に許可） |
| T-BG-004 | コスト記録 | `recordCost(0.38)` | dailySpent に加算 |
| T-BG-005 | 日次リセット | 日付が変わった後の呼び出し | dailySpent=0 にリセット |
| T-BG-006 | 予算上限ちょうど | dailySpent=10.00, limit=10.00 | `canExecute()` = false（上限以上で停止） |

---

## 17. `src/notifications/slack-notifier.ts` — Slack 通知

| # | テストケース | 入力 | 期待結果 |
|---|------------|------|---------|
| T-SN-001 | info レベル通知 | task_completed イベント | HTTP POST 成功、緑色フォーマット |
| T-SN-002 | warn レベル通知 | task_failed_retrying | HTTP POST 成功、黄色フォーマット |
| T-SN-003 | error レベル通知 | circuit_breaker_open | HTTP POST 成功、赤色フォーマット |
| T-SN-004 | Webhook URL 未設定 | url=undefined | 送信スキップ、ログに記録 |
| T-SN-005 | HTTP POST 失敗 | モック → 500 | エラーログ、例外を投げない |
| T-SN-006 | ネットワークエラー | モック → ECONNREFUSED | エラーログ、例外を投げない |
| T-SN-007 | Daily digest フォーマット | 集計データ | 正しい Markdown 形式の body |
| T-SN-008 | fields が空の場合 | `fields: {}` | fields セクションなしで送信 |
| T-SN-009 | 承認依頼に PR URL を含む | approval_requested | body に PR URL が含まれる |
| T-SN-010 | 全 12 種のイベントフォーマット | 各イベント種別 | それぞれ正しいタイトル・body・color |

---

## 18. `src/logging/logger.ts` — ロガー初期化

| # | テストケース | 入力 | 期待結果 |
|---|------------|------|---------|
| T-LOG-001 | ロガー生成 | `createLogger()` | pino インスタンスが返る |
| T-LOG-002 | 子ロガーでコンテキスト付与 | `logger.child({ taskId, agentRole })` | ログ出力に taskId, agentRole を含む |
| T-LOG-003 | ログレベル debug | `logger.debug(...)` | NODE_ENV=development で出力 |
| T-LOG-004 | ログレベル info | `logger.info(...)` | 常に出力 |
| T-LOG-005 | ファイル出力先 | `logs/YYYY-MM-DD.jsonl` | 正しいパスに書き込み |
| T-LOG-006 | JSON Lines 形式 | ログ出力 | 各行が有効な JSON |

---

## 19. `src/logging/log-rotation.ts` — ログローテーション

| # | テストケース | 入力 | 期待結果 |
|---|------------|------|---------|
| T-LR-001 | 30 日以内のログは保持 | 29 日前のファイル | 削除されない |
| T-LR-002 | 30 日超のログは削除 | 31 日前のファイル | 削除される |
| T-LR-003 | ログディレクトリが空 | ファイルなし | エラーなし |
| T-LR-004 | .jsonl 以外のファイルは無視 | `notes.txt` | 削除されない |
| T-LR-005 | ログディレクトリが存在しない | パスなし | ディレクトリを自動作成 |

---

## 20. `src/orchestrator.ts` — メインループ（統合テスト）

| # | テストケース | 入力 | 期待結果 |
|---|------------|------|---------|
| T-ORC-001 | メインループ 1 サイクル — タスクなし | 空キュー | ポーリングのみ、エージェント起動なし |
| T-ORC-002 | メインループ — 単体 review タスク | pending の review タスク | Reviewer 起動 → completed |
| T-ORC-003 | メインループ — パイプライン（review→fix） | pipeline タスク | Reviewer → awaiting_approval → (approve モック) → Fixer → completed |
| T-ORC-004 | メインループ — Circuit Breaker OPEN 中 | CB state=OPEN | タスクを取り出さない |
| T-ORC-005 | メインループ — Rate Controller クールダウン | cooldown 中 | sleep 後にタスク実行 |
| T-ORC-006 | メインループ — Budget Guard 停止中 | dailySpent > limit | タスクを取り出さない |
| T-ORC-007 | 起動時のクラッシュ復旧 | in_progress タスクあり | pending にリセットされてから通常ループ開始 |
| T-ORC-008 | Semaphore — 同時実行数制限 | MAX_CONCURRENT=1 で 2 タスク | 1 つずつ逐次実行 |
| T-ORC-009 | Semaphore — MAX_CONCURRENT=2 | 2 タスク同時 | 並行実行 |
| T-ORC-010 | SIGTERM 受信 — graceful shutdown | SIGTERM シグナル | 実行中タスクの完了を待ってから終了 |
| T-ORC-011 | GitHub Issue ポーリング統合 | モック Issue | Issue → Classifier → キュー投入 → エージェント実行 |
| T-ORC-012 | cron タスク統合 | 03:00 トリガー | cron → review タスク → Reviewer 実行 |
| T-ORC-013 | Daily digest 統合 | 08:00 トリガー | 集計データ → Slack 通知 |

---

## 21. `src/index.ts` — エントリーポイント

| # | テストケース | 入力 | 期待結果 |
|---|------------|------|---------|
| T-IDX-001 | 正常起動 | 有効な環境変数 | Orchestrator 開始ログ出力 |
| T-IDX-002 | 環境変数バリデーション失敗で終了 | 不正な .env | プロセス exit code=1、エラーログ |
| T-IDX-003 | DB 初期化 | 起動時 | スキーマ作成 + WAL モード有効化 |
| T-IDX-004 | SIGTERM ハンドラ登録 | 起動時 | process.on('SIGTERM') が登録される |
| T-IDX-005 | SIGINT ハンドラ登録 | 起動時 | process.on('SIGINT') が登録される |

---

## 22. Contract テスト

| # | テストケース | 入力 | 期待結果 |
|---|------------|------|---------|
| T-CTR-001 | Reviewer Handoff スキーマ | findings 配列 + summary | Zod バリデーション成功 |
| T-CTR-002 | Fixer Handoff スキーマ | fixedFiles 配列 + testResult | Zod バリデーション成功 |
| T-CTR-003 | Builder Handoff スキーマ | newFiles, modifiedFiles, testResult | Zod バリデーション成功 |
| T-CTR-004 | Scribe Handoff スキーマ | updatedDocs 配列 | Zod バリデーション成功 |
| T-CTR-005 | Slack イベント — 全 12 種のペイロード検証 | 各イベントの JSON | SlackNotification スキーマ通過 |
| T-CTR-006 | Classification — single レスポンス検証 | Haiku レスポンスモック | Classification スキーマ通過 |
| T-CTR-007 | Classification — pipeline レスポンス検証 | Haiku レスポンスモック | Classification スキーマ通過 |

---

## テストカバレッジ集計

| モジュール | テストケース数 | カバー対象 |
|-----------|-------------|-----------|
| types.ts | 16 | Zod スキーマ全定義、有効値/無効値/境界値 |
| env-config.ts | 14 | 全環境変数、必須/任意/デフォルト/相互排他 |
| schema.ts | 11 | テーブル作成、WAL、インデックス、CHECK 制約、デフォルト値 |
| task-queue.ts | 29 | CRUD 全操作、依存関係解決、状態遷移全パス、クラッシュ復旧、集計 |
| migrations.ts | 3 | 初回/スキップ/差分適用 |
| agent-config.ts | 7 | 全4エージェント設定値、無効ロール、セキュリティ検証 |
| dispatcher.ts | 15 | 成功/全エラーパターン/タイムアウト/Context Bridge/パイプライン分岐 |
| classifier.ts | 10 | 全ラベルパターン/Haiku モック/エラー/不正出力/依存関係 |
| github-poller.ts | 13 | Issue 検出/重複/API エラー/PR approve/reject/close |
| cron-scheduler.ts | 5 | 全スケジュール/範囲外/ID 形式/冪等性 |
| manual-cli.ts | 6 | 引数パース/バリデーション/デフォルト |
| context-bridge.ts | 6 | 読み書き/不在/不正/ディレクトリ作成/プロンプト生成 |
| result-collector.ts | 8 | 設計PR/最終PR/単体/diff上限/エラー/エビデンス/Slack無効 |
| rate-controller.ts | 8 | 有効/無効/クールダウン/ウィンドウ上限/リセット/通知 |
| circuit-breaker.ts | 10 | 全状態遷移（CLOSED→OPEN→HALF_OPEN→CLOSED/OPEN） |
| budget-guard.ts | 6 | 予算内/超過/Max無効/記録/日次リセット/境界値 |
| slack-notifier.ts | 10 | 全レベル/URL未設定/HTTPエラー/全12イベント |
| logger.ts | 6 | 生成/子ロガー/レベル/ファイル出力/JSON形式 |
| log-rotation.ts | 5 | 保持/削除/空/非対象/ディレクトリ不在 |
| orchestrator.ts | 13 | メインループ全パターン/統合シナリオ/graceful shutdown |
| index.ts | 5 | 起動/バリデーション失敗/DB初期化/シグナルハンドラ |
| contract tests | 7 | Handoff全4種/Slack全種/Classification全種 |
| **合計** | **213** | |
