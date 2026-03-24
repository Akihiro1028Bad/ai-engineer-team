# Research: AI Agent Orchestrator

## R1: Claude Agent SDK メッセージ型と結果処理

**Decision**: `query()` の async iterator から `SDKResultMessage` を取得し、`subtype` で成功/エラーを判別する。構造化出力は `outputFormat` + Zod バリデーション。

**Rationale**: SDK は `AssistantMessage`（中間）、`ResultMessage`（最終）の 2 種類を yield する。ResultMessage の `subtype` が `"success"` なら `structured_output` と `total_cost_usd`, `num_turns`, `duration_ms` を取得可能。エラー時は `"error_max_turns"`, `"error_during_execution"`, `"error_max_budget_usd"` で分岐できる。

**Alternatives considered**:
- Streaming (`includePartialMessages: true`) — 中間出力のリアルタイム表示が不要なため不採用。ログには ResultMessage の情報で十分。
- `resume` オプションでのセッション継続 — Context Bridge のほうがシンプルで、パイプライン設計に適合するため不採用。

## R2: better-sqlite3 トランザクションとWALモード

**Decision**: WAL モード有効化 + `db.transaction()` による同期トランザクション。タスクキューの CRUD はすべてプリペアドステートメント。

**Rationale**: better-sqlite3 は同期 API であり、`db.transaction()` 内で非同期関数を使うとトランザクションが不正にコミットされる。WAL モードにより読み取りと書き込みの並行性が向上し、Orchestrator のメインループがキュー読み取り中にディスパッチ結果の書き込みを行えるようになる。

**Alternatives considered**:
- PostgreSQL — サーバー不要の要件に反するため不採用
- Redis — 永続化の信頼性が SQLite に劣るため不採用
- LiteFS — 分散は不要（単一マシン運用）のため不採用

## R3: GitHub API ポーリング設計

**Decision**: `@octokit/rest` を使用し、5 分間隔で Issue ポーリング + PR review ステータス監視を行う。

**Rationale**: GitHub REST API v3 は認証済みで 5,000 req/hour。5 分間隔のポーリングは 12 req/hour（Issue リスト + PR レビュー）で、レート制限の 0.24% にすぎない。Webhook は受信用 HTTP サーバーが必要で WSL2 環境での運用複雑度が増すため、ポーリングで十分。

**Alternatives considered**:
- GitHub Webhook — WSL2 でのポート公開・HTTPS 証明書管理が複雑なため不採用
- GraphQL API — Issue/PR の取得にはREST で十分。GraphQL の学習コストに見合わない

## R4: Slack Webhook 通知設計

**Decision**: Slack Incoming Webhook を使用し、イベント駆動（即時）+ スケジュール（Daily digest）の 2 パターンで通知する。

**Rationale**: Incoming Webhook は HTTP POST 1 回で通知完了。双方向通信は不要（承認は GitHub PR approve で行う）。通知レベル（info/warn/error）に応じてメッセージの色・フォーマットを変える。

**通知タイミングの設計原則**:
- **即時通知すべきイベント**: 人間のアクションが必要なもの（承認依頼、エラー対応、緊急停止）、またはユーザーがリアルタイムで知りたいもの（タスク完了、PR作成）
- **ログのみに留めるイベント**: 正常系の詳細動作（タスク開始、ツール呼び出し、ポーリング実行）、自動リカバリされるもの（ポーリング失敗、クールダウン挿入）
- **Daily digest に含めるべきデータ**: 24時間の集計値（完了数、失敗数、コスト）、未解決のアクション項目（未承認PR）

**Alternatives considered**:
- Discord Webhook — Slack と同等だが、プロジェクトの前提が Slack のため不採用
- Email — リアルタイム性が低く、通知過多になりやすいため不採用

## R5: テストフレームワーク選定

**Decision**: Vitest を採用。TypeScript ネイティブサポート、ESM 互換、高速実行。

**Rationale**: Jest は ESM + TypeScript の設定が煩雑。Vitest は `vitest.config.ts` のみで TypeScript strict モードのテストが実行可能。better-sqlite3 のインメモリ DB テストとの相性も良い。

**Alternatives considered**:
- Jest — ESM + TypeScript の設定が複雑、トランスフォーム設定が必要なため不採用
- Node.js native test runner (`node:test`) — アサーションライブラリが貧弱、watch モード未成熟のため不採用

## R6: ロギングライブラリ選定

**Decision**: pino を採用。JSON Lines 出力、子ロガーによるコンテキスト付与、高性能。

**Rationale**: Constitution VI (Observability) が JSON Lines 形式の構造化ログを要求。pino は Node.js 最速の構造化ロガーであり、`logger.child({ taskId, agentRole })` でコンテキストフィールドを自動付与できる。`pino.destination()` でファイル出力も容易。

**Alternatives considered**:
- Winston — pino より低速。JSON 出力は可能だが、子ロガーの API が冗長
- Bunyan — メンテナンス頻度が低下しているため不採用
- console.log — 構造化ログの要件を満たさないため不採用

## R7: 環境変数バリデーション

**Decision**: Zod スキーマで `.env` の全変数をバリデーションし、起動時に不正な設定を即座に検出する。

**Rationale**: Constitution I (Type Safety First) により、外部境界のデータは Zod `safeParse` でバリデーション必須。環境変数は外部入力であり、起動時バリデーションにより「Max プランと API Key の同時設定」等のミスを早期検出できる。

**Alternatives considered**:
- dotenv のみ — バリデーションなしでは型安全性を担保できないため不採用
- envalid — Zod がプロジェクト標準であり、別ライブラリの導入は不要
