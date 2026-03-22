# Quickstart: AI Agent Orchestrator

## Prerequisites

- Windows PC (24時間稼働) + WSL2 (Ubuntu 24.04)
- Node.js v22+
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
- Claude Max (20x) プラン、または Anthropic API Key
- GitHub リポジトリ + Personal Access Token
- Slack Incoming Webhook URL（任意）

## 1. Setup

```bash
# リポジトリクローン
git clone <repo-url> ~/ai-engineer
cd ~/ai-engineer

# 依存関係インストール
npm install

# 環境変数設定
cp .env.example .env
# .env を編集（下記参照）
```

## 2. 認証

```bash
# Max プランの場合
claude login
# → ブラウザで "Claude.ai" を選択 → Max プランのアカウントでログイン

# 確認
claude auth status

# 重要: ANTHROPIC_API_KEY を .env に設定しないこと（Max プラン時）
```

## 3. 環境変数 (.env)

```bash
# Rate Controller (Max プラン: true, API課金: false)
RATE_CONTROL_ENABLED=true
RATE_COOLDOWN_SECONDS=60

# GitHub
GITHUB_TOKEN=ghp_...
GITHUB_REPO=your-org/your-repo

# プロジェクトパス
PROJECT_DIR=/home/user/my-project
WORKTREE_DIR=/home/user/worktrees

# Slack（任意）
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...

# 運用パラメータ
DAILY_BUDGET_USD=10.0
MAX_CONCURRENT=1
```

## 4. Worktree 準備

```bash
cd $PROJECT_DIR
git worktree add ~/worktrees/reviewer -b agent/reviewer/init
git worktree add ~/worktrees/fixer -b agent/fixer/init
git worktree add ~/worktrees/builder -b agent/builder/init
git worktree add ~/worktrees/scribe -b agent/scribe/init
```

## 5. ビルド & 起動

```bash
cd ~/ai-engineer

# ビルド
npm run build

# 開発モード（フォアグラウンド）
npm run dev

# 本番（systemd）
systemctl --user enable ai-engineer
systemctl --user start ai-engineer
```

## 6. 動作確認

```bash
# 手動タスク投入
node dist/src/sources/manual-cli.js --type review --title "初回レビュー" --description "src/ 配下をレビュー"

# ログ確認
tail -f logs/$(date +%Y-%m-%d).jsonl | npx pino-pretty

# GitHub Issue からの自動取り込み
# → リポジトリの Issue に `ai-task` ラベルを付ける
```

## 7. パイプラインの動作フロー

1. `ai-task` + `bug` ラベル付き Issue を作成
2. Orchestrator が 5 分以内に検出
3. Classifier が「pipeline: review → fix」と分類
4. Reviewer が分析を実行
5. **設計PR が自動作成され、Slack に承認依頼が届く**
6. **人間が PR を approve**
7. Fixer が修正とテストを実行
8. 最終PR が自動作成され、Slack に完了通知
