# AI Agent Orchestrator

4つの専門AIエージェント（Reviewer, Fixer, Builder, Scribe）を統括し、GitHub Issues・cron・手動入力からソフトウェア開発タスクを自律的に処理するシステム。

## 特徴

- **4種の専門エージェント** — コードレビュー、バグ修正、新機能実装、ドキュメント生成を各エージェントが担当
- **パイプライン実行** — 複合タスクを Classifier が自動分解し、依存関係付きで順次実行
- **ヒューマン・イン・ザ・ループ** — 設計PRを作成して人間の承認後に実装を開始
- **3層安全設計** — エージェント制限（予算・ターン・ツール）、Orchestrator 制御（Rate Controller・Circuit Breaker）、Git 保護（worktree 分離・ブランチ保護）
- **24時間無人稼働** — systemd による常駐化、クラッシュ自動復旧、構造化ログ
- **Slack 通知** — タスク完了・失敗・承認依頼・緊急停止を即時通知、Daily digest で日次サマリ

## アーキテクチャ

```
GitHub Issues / cron / 手動入力
        |
        v
Orchestrator (TypeScript + Node.js)
  +-- Classifier (Claude Haiku)  --> タスク分類・分解
  +-- Task Queue (SQLite)        --> 依存関係付きキュー管理
  +-- Rate Controller            --> Max プラン枠消費のペース制御
  +-- Dispatcher                 --> エージェント起動・タイムアウト・結果回収
        |
  Agent SDK query() --> 各エージェント（独立 worktree で実行）
        |
  Context Bridge (.claude/handoff/*.json) --> エージェント間の結果引き継ぎ
        |
  Result Collector --> PR作成・Slack通知
```

## エージェント一覧

| エージェント | 役割 | 許可ツール | 予算 | ターン上限 | タイムアウト |
|------------|------|-----------|------|----------|------------|
| Reviewer | コードレビュー（読み取り専用） | Read, Glob, Grep | $0.50 | 15 | 10分 |
| Fixer | バグ修正・テスト実行 | Read, Edit, Glob, Grep, Bash(test系) | $1.00 | 30 | 30分 |
| Builder | 新機能実装 | Read, Edit, Glob, Grep, Bash(npm/git系) | $2.00 | 50 | 40分 |
| Scribe | ドキュメント生成・更新 | Read, Edit, Glob, Grep | $0.50 | 20 | 10分 |

## 前提条件

- Windows PC（24時間稼働）+ WSL2（Ubuntu 24.04）
- Node.js v22 以上
- Claude Max (20x) プラン、または Anthropic API Key
- Claude Code CLI（`npm install -g @anthropic-ai/claude-code`）
- GitHub リポジトリ + Personal Access Token
- Slack Incoming Webhook URL（任意）

## セットアップ

### 1. クローン・インストール

```bash
git clone <repo-url> ~/ai-engineer
cd ~/ai-engineer
npm install
```

### 2. 環境変数の設定

```bash
cp .env.example .env
# .env を編集して各値を設定（下記「環境変数」セクション参照）
```

### 3. Claude 認証

```bash
# Max プランの場合
claude login
# → ブラウザで "Claude.ai" を選択 → Max プランのアカウントでログイン

# 確認
claude auth status

# 重要: Max プランでは ANTHROPIC_API_KEY を .env に設定しないこと
```

### 4. Worktree 準備

```bash
cd $PROJECT_DIR
git worktree add ~/worktrees/reviewer -b agent/reviewer/init
git worktree add ~/worktrees/fixer -b agent/fixer/init
git worktree add ~/worktrees/builder -b agent/builder/init
git worktree add ~/worktrees/scribe -b agent/scribe/init
```

### 5. ビルド・起動

```bash
cd ~/ai-engineer

# ビルド
npm run build

# 開発モード（フォアグラウンド）
npm run dev

# 本番（systemd）
systemctl --user daemon-reload
systemctl --user enable ai-engineer
systemctl --user start ai-engineer
```

## 使い方

### GitHub Issue からの自動取り込み

1. 対象リポジトリの Issue に `ai-task` ラベルを付ける
2. 追加ラベルでタスク種別をヒント（`bug` → 修正、`feature` → 新機能実装、`documentation` → ドキュメント）
3. Orchestrator が 5 分以内に検出・分類・実行

### パイプラインフロー（feature Issue の場合）

```
1. Issue 作成（ai-task + feature ラベル）
2. Classifier が review → build → document の 3 ステップに分解
3. Reviewer が設計レビューを実行
4. 設計 PR が自動作成され、Slack に承認依頼が届く
5. 人間が PR を approve
6. Builder が新機能を実装
7. Scribe がドキュメントを更新
8. 最終 PR が自動作成され、Slack に完了通知
```

### cron 定期タスク

| スケジュール | タスク |
|------------|--------|
| 毎晩 3:00 | `src/` 配下のコード品質レビュー |
| 毎週月曜 9:00 | ドキュメントとソースの整合性チェック |

### 手動タスク投入

```bash
npm run task:add -- --type review --title "認証モジュールのレビュー" --description "src/auth.ts を精査してください"
npm run task:add -- --type fix --title "バリデーションバグ" --description "メールアドレスに+が含まれるとエラー" --priority 2
```

## 環境変数

| 変数 | 必須 | デフォルト | 説明 |
|------|------|-----------|------|
| `RATE_CONTROL_ENABLED` | Yes | - | `true`（Max プラン）/ `false`（API 課金） |
| `RATE_COOLDOWN_SECONDS` | No | `60` | タスク間のクールダウン秒数（Max プラン時） |
| `MAX_TASKS_PER_WINDOW` | No | `150` | 5時間ウィンドウのタスク上限（Max プラン時） |
| `RATE_LIMIT_WARN_THRESHOLD` | No | `0.1` | 枠残り警告閾値（10% = 0.1） |
| `GITHUB_TOKEN` | Yes | - | GitHub Personal Access Token |
| `GITHUB_REPO` | Yes | - | 対象リポジトリ（`owner/repo` 形式） |
| `PROJECT_DIR` | Yes | - | 対象リポジトリのパス |
| `WORKTREE_DIR` | Yes | - | エージェント用 worktree のベースパス |
| `SLACK_WEBHOOK_URL` | No | - | Slack Incoming Webhook URL |
| `DAILY_BUDGET_USD` | No | - | 日次予算上限（API 課金時のみ） |
| `MAX_CONCURRENT` | No | `1` | 同時実行エージェント数 |
| `ANTHROPIC_API_KEY` | No | - | API 従量課金の場合のみ設定 |

## 開発

```bash
npm run build        # TypeScript コンパイル
npm run dev          # 開発モード（tsx）
npm run typecheck    # 型チェックのみ（tsc --noEmit）
npm run lint         # ESLint（strictTypeChecked）
npm run test         # テスト実行（Vitest）
npm run test:watch   # テスト ウォッチモード
npm run test:coverage # カバレッジレポート
```

### ディレクトリ構成

```
src/
  agents/        エージェント定義・実行・分類
  queue/         タスクキュー（SQLite）
  sources/       タスク入力（GitHub, cron, CLI）
  bridges/       エージェント間連携・PR作成
  safety/        安全機構（Rate Controller, Circuit Breaker, Budget Guard）
  notifications/ Slack通知
  logging/       構造化ログ（pino）
  config/        環境変数バリデーション
  types.ts       共通型定義（Zod スキーマ）
  orchestrator.ts メインループ
  index.ts       エントリーポイント
```

## 安全設計（3層防壁）

### Layer 1: エージェントレベル

- `allowedTools` でツールをホワイトリスト制御
- `maxTurns` / `maxBudgetUsd` でリソース上限
- `AbortController` によるタイムアウト強制終了

### Layer 2: Orchestrator レベル

- **Rate Controller** — Max プランの 5h ウィンドウ枠を消費ペース制御
- **Circuit Breaker** — 連続 5 回失敗で全エージェント 1 時間停止
- **Budget Guard** — API 課金時の日次予算上限
- **リトライ** — exponential backoff（30s → 120s → 480s、最大 3 回）

### Layer 3: Git レベル

- **worktree 分離** — エージェント間のファイル競合をゼロに
- **ブランチ保護** — main は PR + CI 必須
- **diff サイズ制限** — 500 行超の PR は分割を要求

## ライセンス

TBD
