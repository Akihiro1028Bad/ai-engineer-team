<!--
Sync Impact Report
===================
- Version change: N/A → 1.0.0 (initial ratification)
- Added principles:
  1. Type Safety First (NEW)
  2. Least Privilege (NEW)
  3. Safety by Design (NEW)
  4. Test-First Development (NEW)
  5. Simplicity & YAGNI (NEW)
  6. Observability (NEW)
  7. Git Isolation (NEW)
- Added sections:
  - Technology Constraints
  - Development Workflow
  - Governance
- Removed sections: N/A
- Templates requiring updates:
  - .specify/templates/plan-template.md — ✅ Constitution Check section aligns with 7 principles
  - .specify/templates/spec-template.md — ✅ Requirements/Success Criteria compatible
  - .specify/templates/tasks-template.md — ✅ Phase structure supports test-first and parallelism
- Follow-up TODOs: None
-->

# AI Agent Team Constitution

## Core Principles

### I. Type Safety First

すべてのコードは TypeScript strict モードで記述し、コンパイル時に検出可能なエラーを最大化する。

- `tsconfig.json` の `"strict": true` を有効化し、無効化してはならない
- `any` 型の使用は禁止。`unknown` + 型ガード、または Zod スキーマで代替する
- 外部境界（API レスポンス、JSON パース、環境変数）のデータは必ず Zod `safeParse` でバリデーションし、`z.infer<typeof Schema>` で型を導出する
- `as` キャスト・Non-null アサーション (`!`) は原則禁止。`satisfies` 演算子・型ガード関数・Optional chaining (`?.`) + Nullish coalescing (`??`) で代替する
- ESLint `@typescript-eslint/strictTypeChecked` をベースとし、`no-explicit-any`, `no-unsafe-*` 系ルールをすべて `error` に設定する

**根拠:** AI エージェントが自律的にコードを生成・修正するシステムにおいて、型安全性は人間のレビューなしに品質を担保する最後の砦である。

### II. Least Privilege

各エージェントには、そのタスク遂行に必要最小限のツール・予算・実行時間のみを付与する。

- Agent SDK の `allowedTools` でツールをホワイトリスト制御し、`permissionMode: "dontAsk"` で未許可ツールを自動拒否する
- `maxTurns` と `maxBudgetUsd` を全エージェントに設定し、無限ループ・暴走コストを防止する
- Bash コマンドはプレフィックスマッチ（例: `Bash(npm test *)`, `Bash(git status *)`）で細かく制限する
- Reviewer は読み取り専用（Read, Glob, Grep のみ）、Fixer/Builder は段階的に権限を拡大する

**根拠:** 自律エージェントの暴走リスクを最小化し、1エージェントの障害がシステム全体に波及しないことを保証する。

### III. Safety by Design

安全性は後付けではなく、アーキテクチャレベルで3層の防壁として組み込む。

- **Agent レベル:** `maxTurns`, `maxBudgetUsd`, `allowedTools`, `AbortController`（タイムアウト）
- **Orchestrator レベル:** Rate Controller（Max プラン枠のペース制御）、日次予算上限（API 課金時）、Circuit Breaker（連続5回失敗で1時間停止）
- **Git レベル:** worktree 分離、ブランチ保護（main は PR + CI 必須）、diff サイズ上限（500行/PR）
- すべての Agent SDK `query()` 呼び出しには `AbortController` によるタイムアウトを設定する
- エラー発生時は `cause` チェーンでラップし、構造化ログに `taskId`, `agentRole` を含める

**根拠:** 24時間無人稼働するシステムでは、単一の防壁突破がシステム全体の障害につながる。多層防御により、いずれか1層が破られても残りの層が安全を担保する。

### IV. Test-First Development

テストは実装の前に書く。テストが失敗することを確認してから実装に着手する。

- Red-Green-Refactor サイクルを厳守する
- 単体テストはモジュールの公開インターフェースに対して記述する
- SQLite（better-sqlite3）のテストではインメモリ DB（`:memory:`）を使用し、テスト間の分離を保証する
- エージェントの構造化出力は Zod スキーマでバリデーションテストを行う
- CI で `npm run typecheck && npm run lint && npm run test` がすべて通過しなければマージ不可

**根拠:** AI エージェントが自律的にコードを修正するため、テストが仕様の唯一の信頼できる源泉となる。テストなしの変更は検証不能であり、本番に到達させてはならない。

### V. Simplicity & YAGNI

必要十分な最小限の複雑さでシステムを構築する。将来の仮想的な要件に対する事前設計は行わない。

- 1ファイル1責務。300行を超えたら分割を検討する
- 関数の引数は3つまで。4つ以上はオプションオブジェクトパターンを使用する
- 早期リターンでネストを浅く保つ
- 抽象化は3回以上の重複が確認されてから導入する（Rule of Three）
- `enum` は使わない。`as const` オブジェクト + `typeof` で代替する
- デフォルト export は禁止。名前付き export のみ使用する

**根拠:** 複雑なシステムは予測困難な障害を生む。AI エージェントが理解・修正しやすいコードは、人間にとっても保守しやすいコードである。

### VI. Observability

システムの動作状態は、構造化ログとメトリクスにより常に可視化する。

- ログは JSON Lines 形式で出力する（pino 等の構造化ロガーを使用）
- すべてのログに `taskId`, `agentRole`, `timestamp` をコンテキストフィールドとして付与する
- ログレベルは4段階: `debug`（開発時のみ）、`info`（正常系イベント）、`warn`（回復可能な異常）、`error`（要対応の異常）
- エージェントの実行結果（成功/失敗/タイムアウト）、所要時間（`durationMs`）、コスト消費を記録する
- Circuit Breaker の状態遷移（closed → open → half-open）をログに記録する

**根拠:** 24時間無人稼働システムでは、問題の事後分析が唯一のデバッグ手段となる。構造化ログなしには、障害の根本原因特定は不可能である。

### VII. Git Isolation

エージェント間の作業は Git worktree により完全に分離し、互いの変更が干渉しないことを保証する。

- 各エージェントは専用の worktree（`~/worktrees/{agent_name}/`）で作業する
- ブランチ命名: `agent/{agent_name}/{task_id}`（例: `agent/fixer/gh-42-1`）
- Conventional Commits を厳守: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`
- 1コミット = 1つの論理的変更。1PR あたりの diff は500行以内
- main ブランチへの直接 push は禁止。すべての変更は PR + CI 通過を経由する
- Context Bridge（`.claude/handoff/*.json`）でエージェント間の結果を引き継ぐ

**根拠:** 複数エージェントが同一リポジトリを同時操作する場合、worktree 分離なしにはコンフリクトと相互破壊が不可避である。

## Technology Constraints

本プロジェクトの技術選定は以下に固定し、正当な理由なく変更してはならない。

| 領域 | 技術 | バージョン要件 |
|------|------|--------------|
| 言語 | TypeScript（strict モード） | ES2022+ ターゲット |
| ランタイム | Node.js | v22+ |
| エージェント実行 | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) | 最新安定版 |
| タスクキュー | SQLite（`better-sqlite3`） | WAL モード有効 |
| バリデーション | Zod | v3 系列 |
| 常駐化 | systemd user service | WSL2 環境 |

### SQLite 運用規約

- WAL モード（`db.pragma('journal_mode = WAL')`）を初期化時に必ず有効化する
- 書き込み操作は `db.transaction()` でラップし、自動ロールバックを活用する
- `db.transaction()` 内で非同期関数を使用しない（トランザクションが不正にコミットされるため）
- プリペアドステートメント（`db.prepare()`）を使い回し、SQL インジェクションを防止する
- テストでは `:memory:` データベースを使用し、テスト間の状態汚染を防ぐ

### Agent SDK 運用規約

- すべての `query()` 呼び出しに `allowedTools`, `permissionMode`, `maxTurns`, `maxBudgetUsd` を明示的に設定する
- 読み取り専用エージェントは `permissionMode: "dontAsk"` で未許可ツールを自動拒否する
- 書き込みエージェントは `permissionMode: "acceptEdits"` を使用し、ファイル編集を自動承認する
- 構造化出力は `outputFormat` で JSON Schema を指定し、結果を Zod でバリデーションする
- サブエージェント（Classifier 等）は `model: "haiku"` でコストを最適化する
- `AbortController` + `setTimeout` で各エージェントにタイムアウトを設定する

## Development Workflow

### コード品質ゲート

すべての PR は以下のチェックを通過しなければマージできない:

1. **型チェック:** `npm run typecheck`（`tsc --noEmit`）がエラーゼロ
2. **Lint:** `npm run lint`（ESLint `strictTypeChecked`）がエラーゼロ
3. **テスト:** `npm run test` が全パス
4. **diff サイズ:** 500行以内（超過する場合は PR を分割する）

### import 規約

1. Node.js 組み込みモジュール（`node:` プレフィックス必須）
2. 外部パッケージ
3. プロジェクト内部モジュール

各グループ間に空行を入れる。型のみの import は `import type { ... }` で分離する。

### 命名規則

| 対象 | 規則 | 例 |
|------|------|-----|
| 変数・関数・メソッド | camelCase | `taskQueue`, `dispatchAgent()` |
| 定数（モジュールレベル） | UPPER_SNAKE_CASE | `MAX_CONCURRENT`, `DEFAULT_TIMEOUT_MS` |
| 型・インターフェース・クラス | PascalCase | `TaskStatus`, `AgentConfig` |
| ファイル名 | kebab-case | `rate-controller.ts`, `task-queue.ts` |
| 未使用引数 | `_` プレフィックス | `_event`, `_index` |
| boolean 変数 | `is`/`has`/`should` プレフィックス | `isRunning`, `hasPermission` |
| ブランチ名 | `agent/{agent_name}/{task_id}` | `agent/fixer/gh-42-1` |
| コミットメッセージ | Conventional Commits | `feat:`, `fix:`, `docs:` |

## Governance

- 本 Constitution はプロジェクトの最上位規範であり、他のすべてのドキュメント・慣行に優先する
- 改訂には以下の手順を必須とする:
  1. 改訂提案を PR として提出し、変更理由を明記する
  2. Constitution のバージョンを Semantic Versioning に従い更新する
     - **MAJOR:** 原則の削除・根本的な再定義
     - **MINOR:** 新原則・セクションの追加、既存原則の実質的な拡張
     - **PATCH:** 文言修正、誤字修正、非実質的な改善
  3. `LAST_AMENDED_DATE` を更新する
- すべての PR レビューおよびエージェント設計変更時に、本 Constitution への準拠を検証する
- 複雑さの導入には正当化が必要: Principle V (Simplicity & YAGNI) に違反する場合、Complexity Tracking テーブルに理由を記録する
- ランタイムの開発ガイダンスは `CLAUDE.md` を参照する

**Version**: 1.0.0 | **Ratified**: 2026-03-22 | **Last Amended**: 2026-03-22
