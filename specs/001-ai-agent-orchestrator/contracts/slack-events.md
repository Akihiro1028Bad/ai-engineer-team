# Contract: Slack Notification Events

Orchestrator が Slack Incoming Webhook に送信する通知イベントの定義。

## 即時通知イベント

### task_completed

タスクが正常に完了した。

```json
{
  "level": "info",
  "event": "task_completed",
  "title": "✅ タスク完了: ログイン画面のバリデーションバグ修正",
  "body": "Fixer エージェントがタスクを完了しました。",
  "fields": {
    "taskId": "gh-42-1",
    "agent": "fixer",
    "cost": "$0.38",
    "turns": "12",
    "duration": "2m 15s"
  }
}
```

### approval_requested

パイプラインの設計PRが作成され、人間の承認を待っている。

```json
{
  "level": "info",
  "event": "approval_requested",
  "title": "👀 設計PR承認依頼: 認証モジュールのバグ調査",
  "body": "Reviewer の分析が完了しました。設計PRを確認し、approveしてください。",
  "fields": {
    "taskId": "gh-42-0",
    "prUrl": "https://github.com/org/repo/pull/123",
    "pipeline": "gh-42-0 (review) → gh-42-1 (fix)"
  }
}
```

### pipeline_pr_created

パイプライン実装完了後の最終PRが作成された。

```json
{
  "level": "info",
  "event": "pipeline_pr_created",
  "title": "🎉 実装PR作成: 認証モジュールのバグ修正",
  "body": "パイプラインが完了し、最終PRが作成されました。",
  "fields": {
    "prUrl": "https://github.com/org/repo/pull/124",
    "parentIssue": "#42",
    "agents": "reviewer → fixer",
    "totalCost": "$0.61",
    "totalDuration": "4m 30s"
  }
}
```

### task_failed_retrying

タスクが失敗し、リトライがスケジュールされた。

```json
{
  "level": "warn",
  "event": "task_failed_retrying",
  "title": "⚠️ タスク失敗（リトライ予定）: Nightly review",
  "body": "タスクが失敗しました。120秒後にリトライします。",
  "fields": {
    "taskId": "cron-r-0322",
    "agent": "reviewer",
    "error": "Timeout after 600s",
    "retryCount": "2/3",
    "nextRetryIn": "120s"
  }
}
```

### task_failed_final

タスクがリトライ上限に到達し、最終的に失敗した。

```json
{
  "level": "error",
  "event": "task_failed_final",
  "title": "❌ タスク最終失敗: ログイン画面のバリデーションバグ修正",
  "body": "3回のリトライ後も失敗しました。人間の確認が必要です。",
  "fields": {
    "taskId": "gh-42-1",
    "agent": "fixer",
    "error": "Error: Test suite failed with 3 failures",
    "issueUrl": "https://github.com/org/repo/issues/42"
  }
}
```

### approval_rejected

設計PRが却下され、パイプラインがキャンセルされた。

```json
{
  "level": "warn",
  "event": "approval_rejected",
  "title": "🚫 設計PR却下: 決済機能の設計",
  "body": "設計PRが却下されました。パイプラインの後続タスクをキャンセルしました。",
  "fields": {
    "taskId": "gh-50-0",
    "prUrl": "https://github.com/org/repo/pull/130",
    "cancelledTasks": "gh-50-1 (build), gh-50-2 (document)"
  }
}
```

### auth_error

OAuth トークンが期限切れになった。

```json
{
  "level": "error",
  "event": "auth_error",
  "title": "🔑 認証エラー: OAuth トークン期限切れ",
  "body": "Claude の認証が切れました。WSL2 上で `claude login` を実行してください。",
  "fields": {
    "action": "claude login"
  }
}
```

### circuit_breaker_open

Circuit Breaker が発動し、全エージェントが停止した。

```json
{
  "level": "error",
  "event": "circuit_breaker_open",
  "title": "🛑 緊急停止: Circuit Breaker 発動",
  "body": "連続5回の失敗を検出しました。全エージェントを1時間停止します。",
  "fields": {
    "consecutiveFailures": "5",
    "lastError": "Error: API returned 500",
    "resumeAt": "2026-03-22T04:15:00+09:00"
  }
}
```

### circuit_breaker_closed

Circuit Breaker が復旧した。

```json
{
  "level": "info",
  "event": "circuit_breaker_closed",
  "title": "✅ 復旧: Circuit Breaker 解除",
  "body": "試行タスクが成功しました。通常運用を再開します。",
  "fields": {}
}
```

### rate_limit_approaching

Max プランの5hウィンドウ枠が残り10%以下になった。

```json
{
  "level": "warn",
  "event": "rate_limit_approaching",
  "title": "⚠️ 枠残りわずか: 5hウィンドウ",
  "body": "5時間ウィンドウの残りタスク枠が10%以下です。",
  "fields": {
    "tasksInWindow": "140/150",
    "windowResetAt": "2026-03-22T08:00:00+09:00"
  }
}
```

### daily_budget_reached

API従量課金時の日次予算上限に到達した。

```json
{
  "level": "error",
  "event": "daily_budget_reached",
  "title": "💰 日次予算上限: 全エージェント停止",
  "body": "本日の予算上限（$10.00）に到達しました。翌日リセットまで停止します。",
  "fields": {
    "spent": "$10.23",
    "limit": "$10.00"
  }
}
```

### classifier_unclear

Classifier が Issue を判定できず、質問を投稿した。

```json
{
  "level": "info",
  "event": "classifier_unclear",
  "title": "❓ 分類不能: Issue #55",
  "body": "Issue の情報が不十分です。GitHub Issue にコメントで質問を投稿しました。",
  "fields": {
    "issueUrl": "https://github.com/org/repo/issues/55"
  }
}
```

## 定期通知

### daily_digest

毎日 08:00 に送信される運用サマリ。

```json
{
  "level": "info",
  "event": "daily_digest",
  "title": "📊 Daily Digest: 2026-03-22",
  "body": "完了: 7 tasks (review: 3, fix: 2, build: 1, docs: 1)\n失敗: 1 task (cron-r-0322 — timeout)\nコスト: $4.23\nPR作成: 3 (awaiting review)\n平均所要時間: 5m 12s\n未承認PR: 1件 (12h経過)",
  "fields": {
    "completed": "7",
    "failed": "1",
    "cost": "$4.23",
    "prsCreated": "3",
    "avgDuration": "5m 12s",
    "pendingApprovals": "1 (12h)"
  }
}
```
