# Data Model: AI Agent Orchestrator

## Entity: Task

システムが処理する作業の最小単位。

| Field | Type | Constraints | Description |
|-------|------|-------------|-------------|
| id | string | PK, unique | 一意識別子（例: `gh-42-0`, `cron-r-0322`, `manual-001`） |
| taskType | `"review" \| "fix" \| "build" \| "document"` | NOT NULL | タスク種別 |
| title | string | NOT NULL | タスクのタイトル |
| description | string | NOT NULL | エージェントへの詳細な指示 |
| source | string | NOT NULL | タスクの出所（`github_issue:42`, `cron:nightly_review`, `manual`） |
| priority | number | 1-10, DEFAULT 5 | 優先度（1=最高, 10=最低） |
| status | TaskStatus | NOT NULL, DEFAULT `"pending"` | 現在のステータス |
| result | string \| null | | エージェントの出力結果（JSON文字列） |
| costUsd | number | DEFAULT 0 | 消費したAPIコスト（Maxプラン時は概算値） |
| turnsUsed | number | DEFAULT 0 | エージェントが使ったターン数 |
| retryCount | number | DEFAULT 0, MAX 3 | リトライ回数 |
| dependsOn | string \| null | FK → Task.id | 先行タスクID（完了するまで実行されない） |
| parentTaskId | string \| null | FK → Task.id | パイプライン時の親タスクID |
| contextFile | string \| null | | Context Bridge のファイルパス |
| approvalPrUrl | string \| null | | 設計PRのURL（`awaiting_approval` 時に設定） |
| createdAt | string (ISO 8601) | NOT NULL | 作成日時 |
| startedAt | string (ISO 8601) \| null | | 実行開始日時 |
| completedAt | string (ISO 8601) \| null | | 完了日時 |

### TaskStatus 状態遷移

```
                  ┌──────────────────────────────────┐
                  │                                  │
                  ▼                                  │
    ┌─────────┐     ┌─────────────┐     ┌──────────────────┐
    │ pending  │────▶│ in_progress │────▶│awaiting_approval │
    └─────────┘     └──────┬──────┘     └────────┬─────────┘
         ▲                 │                     │
         │                 │ (単体タスク          │ approve
         │                 │  完了時)             ▼
         │                 │              ┌─────────────┐
         │                 └─────────────▶│  completed   │
         │                                └─────────────┘
         │                 │
         │                 │ 失敗 (retry < 3)
         └─────────────────┘
                           │
                           │ 失敗 (retry >= 3)
                           │ OR reject/close
                           ▼
                    ┌─────────────┐
                    │   failed    │
                    └─────────────┘
```

**遷移ルール:**
- `pending` → `in_progress`: Dispatcher がタスクを取り出して実行開始
- `in_progress` → `completed`: 単体タスク（single）の正常完了
- `in_progress` → `awaiting_approval`: パイプラインの Reviewer 完了後、設計PR作成
- `awaiting_approval` → `pending` (後続タスク): 人間が設計PRを approve
- `awaiting_approval` → `failed` (後続タスク): 人間が設計PRを reject/close
- `in_progress` → `pending`: 失敗時 retry (retryCount < 3)、またはクラッシュ復旧時
- `in_progress` → `failed`: retry 上限到達 (retryCount >= 3)

## Entity: AgentConfig

エージェントの実行設定（コード上の定数オブジェクト、DB非保存）。

| Field | Type | Description |
|-------|------|-------------|
| role | `"reviewer" \| "fixer" \| "builder" \| "scribe"` | エージェントの役割 |
| allowedTools | string[] | 許可ツールのホワイトリスト |
| permissionMode | `"dontAsk" \| "acceptEdits"` | ツール許可モード |
| maxTurns | number | ターン数上限 |
| maxBudgetUsd | number | 予算上限 |
| timeoutMs | number | タイムアウト（ミリ秒） |
| model | `"sonnet" \| "haiku"` | 使用モデル |
| systemPrompt | string | システムプロンプト |

### エージェント設定値

| Role | allowedTools | permissionMode | maxTurns | maxBudgetUsd | timeoutMs |
|------|-------------|----------------|----------|-------------|-----------|
| reviewer | Read, Glob, Grep | dontAsk | 15 | 0.50 | 600,000 |
| fixer | Read, Edit, Glob, Grep, Bash(npm test *), Bash(npx jest *), Bash(npx vitest *), Bash(git diff *), Bash(git status *) | acceptEdits | 30 | 1.00 | 1,800,000 |
| builder | Read, Edit, Glob, Grep, Bash(npm *), Bash(npx *), Bash(git diff *), Bash(git status *), Bash(git add *), Bash(git commit *) | acceptEdits | 50 | 2.00 | 2,400,000 |
| scribe | Read, Edit, Glob, Grep | acceptEdits | 20 | 0.50 | 600,000 |

## Entity: Handoff

エージェント間の結果引き継ぎデータ。JSONファイルとして `.claude/handoff/` に保存。

| Field | Type | Description |
|-------|------|-------------|
| taskId | string | 元タスクのID |
| agent | string | 出力したエージェント名 |
| timestamp | string (ISO 8601) | 作成日時 |
| data | object | 構造化された結果データ（エージェント種別ごとに異なるスキーマ） |

**ファイル命名**: `{taskId}_{agent}.json`（例: `gh-42-0_Reviewer.json`）

## Entity: Classification

Classifier（Haiku）の分類結果。

| Field | Type | Description |
|-------|------|-------------|
| issueId | number | GitHub Issue 番号 |
| complexity | `"single" \| "pipeline" \| "unclear"` | 複雑度判定 |
| taskType | TaskType \| null | single の場合のタスク種別 |
| subTasks | SubTaskDef[] \| null | pipeline の場合のサブタスク定義 |
| question | string \| null | unclear の場合の質問テキスト |

### SubTaskDef

| Field | Type | Description |
|-------|------|-------------|
| taskType | TaskType | サブタスクの種別 |
| title | string | サブタスクのタイトル |
| description | string | サブタスクの詳細指示 |
| dependsOnIndex | number \| null | 依存する前のサブタスクのインデックス |

## Entity: SlackNotification

Slack に送信する通知メッセージの構造。

| Field | Type | Description |
|-------|------|-------------|
| level | `"info" \| "warn" \| "error"` | 通知レベル |
| event | string | イベント種別（`task_completed`, `approval_requested`, `circuit_breaker_open` 等） |
| title | string | 通知タイトル |
| body | string | 通知本文（Markdown形式） |
| fields | Record<string, string> | 補足フィールド（taskId, cost, duration 等） |
| timestamp | string (ISO 8601) | 送信日時 |

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    task_type TEXT NOT NULL CHECK(task_type IN ('review','fix','build','document')),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    source TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 5 CHECK(priority BETWEEN 1 AND 10),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','in_progress','completed','failed','awaiting_approval')),
    result TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    turns_used INTEGER NOT NULL DEFAULT 0,
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count <= 3),
    depends_on TEXT REFERENCES tasks(id),
    parent_task_id TEXT REFERENCES tasks(id),
    context_file TEXT,
    approval_pr_url TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_depends_on ON tasks(depends_on);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
```

### 次タスク取得クエリ

```sql
SELECT * FROM tasks
WHERE status = 'pending'
  AND (depends_on IS NULL
       OR depends_on IN (SELECT id FROM tasks WHERE status = 'completed'))
ORDER BY priority ASC, created_at ASC
LIMIT 1;
```

### クラッシュ復旧クエリ

```sql
UPDATE tasks
SET status = 'pending',
    retry_count = MIN(retry_count + 1, 3),
    started_at = NULL
WHERE status = 'in_progress';

UPDATE tasks
SET status = 'failed'
WHERE status = 'pending' AND retry_count > 3;
```
