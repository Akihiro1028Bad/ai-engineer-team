# AI Engineering Team — 設計書

> **版数:** v2.1（Maxプラン対応版）  
> **作成日:** 2026年3月22日  
> **前版からの変更:** 認証設計（Maxプラン対応）、Rate Controller、既知の制約を追加

---

## 1. 概要

### 1.1 プロジェクトの目的

24時間稼働可能なWindows PC上に、Claude Codeベースの4つの専門AIエージェントを配置し、1つのエンジニアリングチームとして自律的にソフトウェア開発タスクを遂行するシステムを構築する。

### 1.2 スコープ

本システムは以下の4種類のタスクを自動処理する。

| タスク種別 | 担当エージェント | 主な作業内容 |
|-----------|----------------|-------------|
| コードレビュー・品質チェック | Reviewer | 静的解析、バグ検出、スタイル違反検出 |
| バグ修正・テスト | Fixer | 問題再現、修正、テスト作成・実行 |
| 新機能の実装 | Builder | 設計、実装、ユニットテスト |
| ドキュメント生成・保守 | Scribe | README更新、APIドキュメント、CHANGELOG |

### 1.3 前提条件

- Windows PC（24時間稼働） + WSL2（Ubuntu 24.04）
- Node.js v22以上（Claude Code・Orchestrator実行に必要）
- Claude Max (20x) プラン、または Anthropic API Key
- Claude Code CLI（`npm install -g @anthropic-ai/claude-code`）
- GitHub / GitLab リポジトリ（ソースコード管理）
- Slack / Discord Webhook（通知用、任意）

### 1.4 使用技術

| コンポーネント | 技術 | 選定理由 |
|--------------|------|---------|
| エージェント実行 | Claude Agent SDK (TypeScript) | ビルトインツール、自動コンテキスト管理、サブエージェント対応 |
| タスクキュー | better-sqlite3 | 軽量、サーバー不要、永続化対応 |
| 非同期処理 | Node.js (async/await) | 並行実行制御、タイムアウト管理 |
| ソースコード管理 | Git worktree | エージェント間のファイル競合を完全回避 |
| 通知 | Slack Webhook API | リアルタイム通知、日次レポート |
| 型安全 | Zod | 構造化出力のバリデーション、型生成 |
| 常駐化 | systemd (user service) | WSL2対応、自動再起動 |

### 1.5 アーキテクチャの要点：Agent SDK と Claude Code の関係

本設計の中核を担う `@anthropic-ai/claude-agent-sdk` は、内部的にローカルにインストールされた Claude Code CLI をランタイムエンジンとして使用する。

```
Orchestrator (TypeScript / Node.js)
    ↓  query() 呼び出し
Claude Agent SDK (@anthropic-ai/claude-agent-sdk)
    ↓  内部的にプロセス起動
Claude Code CLI （ランタイムエンジン、SDKにバンドル）
    ↓  認証情報を解決
    ├── ANTHROPIC_API_KEY が設定されている場合 → API 従量課金
    └── 設定されていない場合 → claude login の OAuth 認証 → Max プランの枠を使用
    ↓
Claude API （モデル）
```

この構造により、Agent SDK の `query()` 関数をそのまま使いながら、認証方式を切り替えるだけで Max プランでも API 従量課金でも動作する。コードの変更は不要である。

---

## 2. 認証・課金設計

### 2.1 課金プランの選択肢

| 項目 | Max 20x ($200/月) | API 従量課金 |
|------|-------------------|-------------|
| 認証方式 | `claude login`（OAuth） | `ANTHROPIC_API_KEY` 環境変数 |
| Agent SDK 利用 | そのまま使える | そのまま使える |
| 課金体系 | 月額固定 | トークン単価 (Sonnet: $3/$15 per M) |
| 使用量制限 | 5時間ローリングウィンドウ + 週次上限 | RPM/TPM のみ、実質無制限 |
| コスト予測 | 完全に予測可能 | 変動あり（月$70-$300程度） |
| claude.ai との枠共有 | あり（同一バケット） | なし（完全に別枠） |
| 並行実行 | 枠を共有消費するため1推奨 | 制限なし（RPM内）、2以上可 |
| Extra Usage | 枠超過時にAPIレートで自動課金可 | 不要 |

### 2.2 推奨構成

**メイン：Max 20x ($200/月)**
- 月額固定で予算が完全に予測可能
- コスト暴走リスクがない
- Extra Usage を有効にすれば、枠超過時のみ従量課金にフォールバック可能

**Max プランが向かないケース → API 従量課金に切り替え：**
- 並行2エージェント以上を常時稼働させたい場合
- 自分が claude.ai を日常的に使いたい場合（エージェントと枠を奪い合うため）
- 月間タスク量が非常に多い（30+/日）場合

### 2.3 認証手順

**Max プランの場合：**

```bash
# 初回ログイン（ブラウザが開く）
claude login
# → "Claude.ai" を選択 → Max プランのアカウントでログイン

# 認証状態の確認
claude auth status

# 重要: ANTHROPIC_API_KEY を環境変数に設定しないこと
# API Key があると OAuth より優先され、意図せず従量課金になる
unset ANTHROPIC_API_KEY
```

認証情報の保存場所：
- Linux/WSL2: `~/.claude/.credentials.json`（mode 0600）

**API 従量課金の場合：**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### 2.4 Agent SDK から見た認証の透過性

Agent SDK の `query()` はどちらの認証方式でもコードの変更なしに動作する。認証の解決は SDK が内部的に呼び出す Claude Code CLI が行う。

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

// このコードは Max プランでも API Key でもそのまま動く
for await (const message of query({
  prompt: "src/ 配下をレビューしてください",
  options: {
    allowedTools: ["Read", "Glob", "Grep"],
    permissionMode: "dontAsk",  // 読み取り専用：許可ツール以外はすべて拒否
    maxTurns: 15,
    maxBudgetUsd: 0.50,  // API 課金時にはコスト上限として機能
  },
})) {
  // ...
}
```

> **注意：** `maxBudgetUsd` は API 従量課金時にタスク単位のコスト上限として機能する。Max プランでは枠ベースの消費となるため、この値は直接的な費用制限としては機能しないが、内部的なトークン消費の目安として引き続き有効である。

---

## 3. システムアーキテクチャ

### 3.1 全体構成

```
GitHub Issues / cron / 手動入力
         │
         ▼
┌─────────────────────────────────────────────────────────┐
│  Windows PC (24h) + WSL2                                │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Orchestrator (TypeScript + Node.js)              │  │
│  │                                                   │  │
│  │  ┌──────────────┐   ┌──────────────────────────┐  │  │
│  │  │ Task Source   │──▶│ Classifier (Claude Haiku)│  │  │
│  │  │ GitHub/cron   │   │ 種別判定 + 粒度判定     │  │  │
│  │  └──────────────┘   └───────────┬──────────────┘  │  │
│  │                                 ▼                  │  │
│  │              ┌──────────────────────────┐          │  │
│  │              │ Task Queue (SQLite)      │          │  │
│  │              │ 依存関係 + 優先度管理    │          │  │
│  │              └──┬─────┬─────┬─────┬────┘          │  │
│  │                 ▼     ▼     ▼     ▼               │  │
│  │  ┌────────────────────────────────────────┐       │  │
│  │  │ Rate Controller (Max プラン時のみ)     │       │  │
│  │  │ 5h ウィンドウ消費ペースを制御          │       │  │
│  │  └──┬─────┬─────┬─────┬───────────────────┘       │  │
│  │     ▼     ▼     ▼     ▼                           │  │
│  │  ┌────┐┌────┐┌────┐┌────┐                         │  │
│  │  │ R  ││ F  ││ B  ││ S  │  Agents (Agent SDK)    │  │
│  │  └──┬─┘└──┬─┘└──┬─┘└──┬─┘                         │  │
│  │     ▼     ▼     ▼     ▼                           │  │
│  │  ┌──────────────────────────┐                      │  │
│  │  │ Git Worktrees (独立)     │                      │  │
│  │  └───────────┬──────────────┘                      │  │
│  │              ▼                                     │  │
│  │  ┌──────────────────────────┐                      │  │
│  │  │ Result Collector         │                      │  │
│  │  │ PR作成 / Slack通知       │                      │  │
│  │  └──────────────────────────┘                      │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
         │
         ▼
   GitHub PR → CI/CD → main merge
```

### 3.2 コンポーネント一覧

| コンポーネント | 責務 | 入力 | 出力 |
|--------------|------|------|------|
| Task Source | GitHub Issue / cron からタスクを取得 | GitHub API / 時刻 | Raw Issue データ |
| Classifier | タスクの種別・粒度・依存関係を判定 | Issue のタイトル・本文・ラベル | 分類結果 JSON |
| Task Queue | タスクの永続管理、依存関係考慮のディスパッチ | Task オブジェクト | 次に実行すべきタスク |
| **Rate Controller** | **Maxプランの枠消費ペースを制御** | **タスク実行イベント** | **クールダウン指示** |
| Dispatcher | エージェントの起動・タイムアウト・結果回収 | Task + Config | 実行結果・コスト・ターン数 |
| Context Bridge | エージェント間のコンテキスト引き継ぎ | エージェントの出力 JSON | Handoff ファイル |
| Result Collector | PR 作成、Slack 通知、ログ記録 | 完了タスクの結果 | GitHub PR / Slack メッセージ |
| Circuit Breaker | 連続失敗の検出と自動停止 | 成功/失敗イベント | open/closed 状態 |

### 3.3 Rate Controller（Max プラン時のみ有効）

Max プランでは使用量が「5時間ローリングウィンドウ」で管理される。エージェントが連続してタスクを処理すると枠を急速に消費するため、Rate Controller がペースを制御する。

```typescript
/**
 * Max プランの使用枠を管理する。
 * API 従量課金時は無効化（スルー）する。
 */
class RateController {
  private lastTaskTime = 0;
  private tasksInWindow = 0;
  private windowStart = Date.now();

  constructor(
    private readonly enabled: boolean = true,
    private readonly cooldownMs: number = 60_000,       // タスク間の最小インターバル
    private readonly maxTasksPerWindow: number = 150,   // 5hウィンドウの安全上限
  ) {}

  /** レート制限を超えないようクールダウンを挿入 */
  async waitIfNeeded(): Promise<void> {
    if (!this.enabled) return; // API 従量課金時はスキップ

    // 5時間ウィンドウのリセット
    let now = Date.now();
    if (now - this.windowStart > 5 * 3600_000) {
      this.tasksInWindow = 0;
      this.windowStart = now;
    }

    // ウィンドウ内の上限チェック
    if (this.tasksInWindow >= this.maxTasksPerWindow) {
      const waitMs = (this.windowStart + 5 * 3600_000) - now;
      logger.warn("rate_limit_reached", { waitMs });
      await sleep(waitMs);
      // sleep 後は now を再取得
      now = Date.now();
      this.tasksInWindow = 0;
      this.windowStart = now;
    }

    // タスク間のクールダウン（now を再取得して正確な経過時間を計算）
    now = Date.now();
    const elapsed = now - this.lastTaskTime;
    if (elapsed < this.cooldownMs) {
      await sleep(this.cooldownMs - elapsed);
    }

    this.lastTaskTime = Date.now();
    this.tasksInWindow += 1;
  }
}
```

**設定の目安：**

| パラメータ | Max プラン推奨値 | API 課金時 |
|-----------|----------------|-----------|
| enabled | `true` | `false`（無効化） |
| cooldownMs | 60000（タスク間60秒） | 0（クールダウンなし） |
| maxTasksPerWindow | 150（5h上限の安全マージン） | 無制限 |

---

## 4. タスク管理設計

### 4.1 タスクのライフサイクル

```
               ┌──────────────────────────────┐
               │                              │
               ▼                              │
  ┌─────────┐     ┌─────────────┐     ┌──────┴──┐     ┌───────────┐
  │ PENDING  │────▶│ IN_PROGRESS │────▶│COMPLETED│     │  FAILED   │
  └─────────┘     └──────┬──────┘     └─────────┘     └───────────┘
       ▲                 │                                   ▲
       │                 │ 失敗 (retry < 3)                  │
       └─────────────────┘                                   │
                         │ 失敗 (retry >= 3)                 │
                         └───────────────────────────────────┘
```

### 4.2 タスクデータモデル

```typescript
type TaskType = "review" | "fix" | "build" | "document";
type TaskStatus = "pending" | "in_progress" | "completed" | "failed" | "needs_human";

/** タスク投入時の入力型（ランタイムで自動設定されるフィールドを省略可能） */
interface CreateTaskInput {
  id: string;              // 一意識別子 (例: "gh-42-0")
  taskType: TaskType;
  title: string;
  description: string;     // 詳細な指示
  source: string;          // タスクの出所 (例: "github_issue:42")
  priority?: number;       // 1(最高) - 10(最低)、デフォルト: 5
  dependsOn?: string;      // 先行タスクID (完了するまで実行されない)
  parentTaskId?: string;   // パイプライン時の親タスクID
}

/** タスクの完全なデータモデル（DB保存形式） */
interface Task extends CreateTaskInput {
  priority: number;
  status: TaskStatus;      // デフォルト: "pending"
  result?: string;         // エージェントの出力結果
  costUsd: number;         // 消費したAPIコスト（Maxプラン時は概算値）、デフォルト: 0
  turnsUsed: number;       // エージェントが使ったターン数、デフォルト: 0
  retryCount: number;      // リトライ回数 (最大3)、デフォルト: 0
  contextFile?: string;    // Context Bridge のファイルパス
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}
```

### 4.3 タスク分解（Classifier）

GitHub Issueが到着すると、まず安価なClaude Haikuモデルで分類を行う。

**分類の3パターン：**

| 複雑度 | 説明 | 処理 |
|--------|------|------|
| single | 1エージェントで完結する単純なタスク | そのまま1タスクとしてキューに投入 |
| pipeline | 複数エージェントの連鎖が必要な複合タスク | サブタスクに分解し、依存関係付きでキューに投入 |
| unclear | 情報が不十分で判断できない | GitHub Issueにコメントで質問を投稿 |

**分類の判定材料：**

- Issue のタイトルと本文
- 付与されたラベル（bug, feature, docs 等）
- 関連する diff（PRリンクがある場合）

**パイプライン例：「決済機能を追加」というIssue**

```
gh-50-0: [review]   既存コードの調査・設計方針レビュー    dependsOn: null
gh-50-1: [build]    決済機能の実装                       dependsOn: gh-50-0
gh-50-2: [document] APIドキュメント・README更新           dependsOn: gh-50-1
```

**Classifierのモデル選択：**

Agent SDK ではサブエージェントのモデルを指定できる（`"sonnet"`, `"opus"`, `"haiku"`）。Classifier は判定タスクのみで軽量なため、`"haiku"` を指定してコストを抑える。

```typescript
// Classifier は Haiku で実行（安価）
const classifierAgent: AgentDefinition = {
  description: "タスクの種別・粒度・依存関係を判定する分類エージェント",
  prompt: "...",
  model: "haiku",
  maxTurns: 1,
  tools: ["Read"],
};
```

### 4.4 タスクキューの依存関係解決

SQLiteクエリで依存関係を制御する。

```sql
SELECT * FROM tasks
WHERE status = 'pending'
  AND (depends_on IS NULL
       OR depends_on IN (SELECT id FROM tasks WHERE status = 'completed'))
ORDER BY priority ASC
LIMIT 1
```

このクエリにより、先行タスクが完了するまで後続タスクは取り出されない。

### 4.5 タスクの投入方法

**方法1: GitHub Issue（自動取り込み）**

`ai-task` ラベルが付いたIssueを5分間隔でポーリングし、自動取り込みする。追加ラベルでタスク種別のヒントを提供する。

| ラベル | 判定されるタスク種別 |
|--------|-------------------|
| bug, fix | fix |
| feature, enhancement | build |
| documentation, docs | document |
| 上記以外 | Classifierが本文から判定 |

**方法2: cron定期タスク**

| スケジュール | タスク | 内容 |
|------------|--------|------|
| 毎晩 3:00 | Nightly review | src/ 配下のコード品質レビュー |
| 毎週月曜 9:00 | Weekly docs sync | ドキュメントとソースの整合性チェック |

**方法3: 手動投入（CLIスクリプト）**

```typescript
// better-sqlite3 は同期APIのため await 不要
queue.push({
  id: "manual-001",
  taskType: "fix",
  title: "ログイン画面のバリデーションバグ修正",
  description: "メールアドレスに+が含まれるとエラーになる",
  source: "manual",
  priority: 2,
} satisfies CreateTaskInput);
```

---

## 5. エージェント設計

### 5.1 エージェント一覧と権限

| エージェント | 役割 | 許可ツール | 禁止操作 | 予算/タスク | ターン上限 | タイムアウト |
|------------|------|-----------|---------|-----------|----------|------------|
| Reviewer | コードレビュー | Read, Glob, Grep | Write, Edit, Bash | $0.50 | 15 | 10分 |
| Fixer | バグ修正・テスト | Read, Edit, Glob, Grep, Bash(test系) | rm, deploy系 | $1.00 | 30 | 30分 |
| Builder | 新機能実装 | Read, Edit, Glob, Grep, Bash(npm/git) | rm -rf, deploy系 | $2.00 | 50 | 40分 |
| Scribe | ドキュメント生成 | Read, Edit, Glob, Grep | Bash | $0.50 | 20 | 10分 |

**最小権限の原則：** 各エージェントは作業に必要な最小限のツールのみ使用可能。Reviewerはファイル読み取りのみ、Fixerはテスト実行のみBash許可、Builderもgitとパッケージマネージャのみ許可する。

### 5.2 エージェントのシステムプロンプト設計方針

各エージェントのシステムプロンプトには以下を含める。

1. **役割の明確な定義** — 何をするエージェントか
2. **作業手順** — ステップバイステップの手順
3. **出力形式** — 構造化JSON形式を指定（Context Bridgeで使用）
4. **禁止事項** — やってはいけないことの明示
5. **CLAUDE.md参照** — プロジェクト共通ルールの遵守指示

**出力JSON形式の例（Reviewer）：**

```json
{
  "findings": [
    {
      "severity": "critical",
      "file": "src/auth.ts",
      "line": 42,
      "issue": "SQLインジェクションの可能性",
      "suggestion": "パラメータ化クエリを使用"
    }
  ],
  "summary": "重大な問題が1件、警告が3件見つかりました"
}
```

### 5.3 CLAUDE.md（プロジェクト共通ルール）

すべてのエージェントが `.claude/` ディレクトリの `CLAUDE.md` を読み込む。Agent SDK の `query()` に `cwd` オプションで worktree パスを指定することで、worktree 内の CLAUDE.md が自動的に適用される。

```markdown
# CLAUDE.md

## コーディング規約
- 既存スタイルに従う
- 新しい関数には必ずドキュメントコメント
- マジックナンバー禁止、定数として定義

## Gitルール
- Conventional Commits 形式 (feat:, fix:, docs:, test:, refactor:)
- 1コミット = 1つの論理的変更
- WIP コミット禁止

## テスト
- 新機能・修正には必ずテスト追加
- カバレッジを下げる変更は禁止

## 禁止事項
- 本番データベースへの直接アクセス
- 環境変数やシークレットのハードコーディング
- node_modules/ や .env ファイルのコミット
- 破壊的変更を告知なしに行うこと
```

---

## 6. エージェント間連携（Context Bridge）

### 6.1 課題

Claude Agent SDKのセッションはステートレスであり、セッション間で状態を共有できない。エージェントAの分析結果をエージェントBが参照するには、明示的な引き継ぎ機構が必要である。

### 6.2 解決策：ファイルベースのContext Bridge

各エージェントの出力をJSON形式で `.claude/handoff/` ディレクトリに保存し、後続エージェントのプロンプトに組み込む。

```
.claude/handoff/
├── gh-42-0_Reviewer.json      # Reviewerの指摘結果
├── gh-42-1_Fixer.json         # Fixerの修正結果
└── gh-42-2_Scribe.json        # Scribeのドキュメント更新結果
```

### 6.3 Handoffファイルのフォーマット

```json
{
  "taskId": "gh-42-0",
  "agent": "Reviewer",
  "timestamp": "2026-03-22T03:15:00+09:00",
  "data": {
    "findings": [...],
    "summary": "..."
  }
}
```

### 6.4 パイプラインフロー例

**Issue #42「認証モジュールにバグがある」の処理フロー：**

```
Step 1: Reviewer
  入力: "src/auth.ts を精査してください"
  出力: gh-42-0_Reviewer.json (指摘リスト)

          ↓ Handoff JSON

Step 2: Fixer
  入力: "以下の指摘を修正してください" + Reviewer の handoff JSON
  出力: gh-42-1_Fixer.json (修正結果)

          ↓ Handoff JSON

Step 3: Scribe
  入力: "以下の変更に合わせてドキュメントを更新" + Fixer の handoff JSON
  出力: gh-42-2_Scribe.json (ドキュメント更新結果)

          ↓ 全結果集約

Step 4: Orchestrator
  → GitHub PR 作成
  → Slack 通知
```

### 6.5 プロンプトへの組み込み

Dispatcherは依存タスクのhandoffファイルを検出し、プロンプトの冒頭に自動挿入する。

```
## タスク: 認証モジュールのバグ修正

メールアドレスに+が含まれるとバリデーションエラーになる。

## 前のエージェント (Reviewer) からの引き継ぎ情報
タスクID: gh-42-0
時刻: 2026-03-22T03:15:00+09:00

{
  "findings": [
    {
      "severity": "critical",
      "file": "src/auth.ts",
      "line": 42,
      "issue": "emailのバリデーション正規表現が+を許可していない",
      "suggestion": "RFC 5322準拠の正規表現に変更"
    }
  ]
}

完了したら、指定のJSON形式で結果を出力してください。
```

---

## 7. Git戦略

### 7.1 Worktree分離

各エージェントは独立したGit worktreeで作業する。これにより、ファイルシステムレベルで完全に分離され、同時編集による競合が発生しない。

```
~/my-project/              # メインリポジトリ (.git)
~/worktrees/
├── reviewer/              # Reviewer専用 (agent/review/* ブランチ)
├── fixer/                 # Fixer専用   (agent/fix/* ブランチ)
├── builder/               # Builder専用 (agent/build/* ブランチ)
└── scribe/                # Scribe専用  (agent/docs/* ブランチ)
```

### 7.2 ブランチ命名規則

```
agent/{agent_name}/{task_id}

例:
agent/reviewer/gh-42-0
agent/fixer/gh-42-1
agent/builder/gh-50-1
agent/scribe/gh-50-2
```

### 7.3 ブランチ保護ルール

| ルール | 設定 | 目的 |
|--------|------|------|
| main ブランチへの直接 push 禁止 | Branch protection rule | エージェントの変更が無検証で反映されるのを防止 |
| PR 必須 | Require pull request | すべての変更をPR経由に強制 |
| CI 通過必須 | Required status checks | テスト失敗した変更のmergeを防止 |
| Diff サイズ制限 | Pre-push hook | 500行以上の変更は分割を強制 |

---

## 8. 安全設計（暴走防止）

### 8.1 3層防壁

```
┌─────────────────────────────────────────────────┐
│ Layer 1: Agent-level guardrails                 │
│  ・maxTurns: アクション回数のハードリミット       │
│  ・maxBudgetUsd: タスクあたりのコスト上限         │
│  ・allowedTools: ホワイトリスト方式のツール制限   │
│  ・AbortController: タイムアウトによる強制終了    │
├─────────────────────────────────────────────────┤
│ Layer 2: Orchestrator-level controls            │
│  ・Rate Controller: Maxプランの枠消費ペース制御   │
│  ・dailyBudgetUsd: 日次コスト上限(API課金時)      │
│  ・Semaphore: 同時実行数を制限                    │
│  ・Circuit Breaker: 連続失敗で自動停止            │
│  ・Retry Policy: exponential backoff (3回まで)    │
├─────────────────────────────────────────────────┤
│ Layer 3: Git-level safety                       │
│  ・worktree isolation: ファイル競合ゼロ           │
│  ・branch protection: main は PR + CI 必須        │
│  ・diff size limit: 500行以上は分割強制           │
│  ・pre-push hook: テスト通過必須                  │
└─────────────────────────────────────────────────┘
```

### 8.2 各ガードレールの詳細設定値

| ガードレール | 設定値 | 発動時の挙動 |
|------------|--------|-------------|
| maxTurns (Reviewer) | 15 | エージェント強制終了、タスク失敗 |
| maxTurns (Fixer) | 30 | エージェント強制終了、タスク失敗 |
| maxTurns (Builder) | 50 | エージェント強制終了、タスク失敗 |
| maxTurns (Scribe) | 20 | エージェント強制終了、タスク失敗 |
| maxBudgetUsd (Reviewer) | $0.50 | エージェント停止 |
| maxBudgetUsd (Fixer) | $1.00 | エージェント停止 |
| maxBudgetUsd (Builder) | $2.00 | エージェント停止 |
| maxBudgetUsd (Scribe) | $0.50 | エージェント停止 |
| timeout (Reviewer) | 600秒 (10分) | AbortController → リトライ |
| timeout (Fixer) | 1800秒 (30分) | AbortController → リトライ |
| timeout (Builder) | 2400秒 (40分) | AbortController → リトライ |
| timeout (Scribe) | 600秒 (10分) | AbortController → リトライ |
| dailyBudgetUsd | $10.00 | 全エージェント1時間停止、翌日リセット（API課金時） |
| Rate Controller cooldown | 60秒 | タスク間にインターバル挿入（Max プラン時） |
| Rate Controller windowLimit | 150タスク/5h | ウィンドウリセットまで待機（Max プラン時） |
| maxConcurrent | 1 (Max) / 2 (API) | Semaphore で制限 |
| Circuit Breaker threshold | 連続5回失敗 | 全エージェント1時間停止 + Slack通知 |
| Retry Policy | 最大3回 | backoff: 30s → 120s → 480s |
| diffSizeLimit | 500行 | PR作成を拒否、分割を要求 |

### 8.3 Max プラン vs API 課金での安全設計の違い

| 項目 | Max プラン | API 従量課金 |
|------|-----------|-------------|
| コスト暴走リスク | なし（月額固定） | あり → `maxBudgetUsd` + `dailyBudgetUsd` で防止 |
| 枠消費リスク | あり → Rate Controller で防止 | なし |
| 推奨同時実行数 | 1（枠を節約） | 2（RPM内で自由） |
| claude.ai への影響 | あり（枠共有）→ 夜間にタスク集中推奨 | なし |

### 8.4 allowedTools の詳細（Bashコマンドのホワイトリスト）

```typescript
// Reviewer: Read only — Bash は一切不可
const reviewerTools = ["Read", "Glob", "Grep"];

// Fixer: テスト実行のみ許可
const fixerTools = [
  "Read", "Edit", "Glob", "Grep",
  "Bash(npm test *)", "Bash(npx jest *)",
  "Bash(npx vitest *)",
  "Bash(git diff *)", "Bash(git status *)",
];

// Builder: パッケージ管理とgitのみ許可
const builderTools = [
  "Read", "Edit", "Glob", "Grep",
  "Bash(npm *)", "Bash(npx *)",
  "Bash(git diff *)", "Bash(git status *)",
  "Bash(git add *)", "Bash(git commit *)",
];

// Scribe: Read + Edit のみ — Bash は一切不可
const scribeTools = ["Read", "Edit", "Glob", "Grep"];
```

末尾の `*` はプレフィックスマッチ。`Bash(git diff *)` は `git diff` で始まるすべてのコマンドを許可する。`rm`, `curl`, `wget`, `docker`, `sudo` 等の危険なコマンドは一切リストに含めない。

---

## 9. 障害復旧・リトライ設計

### 9.1 リトライポリシー

```
タスク失敗
  │
  ├── 認証エラー（OAuth トークン期限切れ）?
  │    └── YES → Slack で「claude login が必要」と通知 → 一時停止
  │
  ├── retryCount < 3?
  │    ├── YES → exponential backoff → ステータスを pending に戻す
  │    │         delay = 30 × 4^(retryCount - 1)
  │    │         retry 1: 30秒後に再実行
  │    │         retry 2: 120秒後に再実行
  │    │         retry 3: 480秒後に再実行
  │    │
  │    └── NO  → ステータスを failed に変更
  │              → Slack に通知
  │              → 人間のレビューを要求
  │
  └── Circuit Breaker チェック
       └── 連続5回失敗? → 全エージェント1時間停止 → Slack緊急通知
```

### 9.2 Circuit Breaker の状態遷移

```
CLOSED (正常稼働)
  │
  │ 連続5回失敗
  ▼
OPEN (停止中)
  │
  │ 1時間経過
  ▼
HALF-OPEN (試行)
  │
  ├── 成功 → CLOSED に戻る
  └── 失敗 → OPEN に戻る（1時間再停止）
```

### 9.3 想定される障害パターンと対応

| 障害パターン | 検出方法 | 自動対応 | 人間の対応 |
|-------------|---------|---------|-----------|
| Max 枠上限到達 | Rate Controller | ウィンドウリセットまで待機 | Extra Usage の有効化検討 |
| OAuth トークン期限切れ | RuntimeError | Slack 通知 + 一時停止 | `claude login` 再実行 |
| API レート制限 | HTTP 429 | exponential backoff | 不要（自動復旧） |
| API 障害 | HTTP 5xx | circuit breaker → 1h停止 | 状況確認 |
| エージェント無限ループ | max_turns / timeout | 強制終了 → リトライ | プロンプト改善 |
| コスト超過（API課金時） | dailyBudgetUsd | 全エージェント停止 | 予算調整 |
| テスト失敗 | CI red | PR マージ拒否 | コードレビュー |
| Git コンフリクト | GitHub conflict 検出 | Slack 通知 | 手動resolve |
| WSL2 クラッシュ | systemd restart | 自動再起動 | 不要（自動復旧） |
| ディスク容量不足 | ログローテーション | 古いログ削除 | ディスク増設 |

---

## 10. 状態管理・ログ・監視

### 10.1 データストア（SQLite）

```sql
CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    task_type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    source TEXT NOT NULL,
    priority INTEGER DEFAULT 5,
    status TEXT DEFAULT 'pending',
    result TEXT,
    cost_usd REAL DEFAULT 0,
    turns_used INTEGER DEFAULT 0,
    retry_count INTEGER DEFAULT 0,
    parent_task_id TEXT,
    depends_on TEXT,
    context_file TEXT,
    created_at TEXT,
    started_at TEXT,
    completed_at TEXT
);
```

### 10.2 構造化ログ（JSON Lines）

すべてのイベントをJSON Lines形式で記録する。1行 = 1イベント。

```jsonl
{"ts":"03:15:03","level":"INFO","agent":"Classifier","task":"gh-42","event":"classified","complexity":"pipeline","sub_tasks":3}
{"ts":"03:15:05","level":"INFO","agent":"Reviewer","task":"gh-42-0","event":"task_start","title":"認証モジュールレビュー"}
{"ts":"03:15:08","level":"INFO","agent":"Reviewer","task":"gh-42-0","event":"tool_call","tool":"Read","file":"src/auth.ts"}
{"ts":"03:15:12","level":"INFO","agent":"Reviewer","task":"gh-42-0","event":"tool_call","tool":"Grep","pattern":"validate.*email"}
{"ts":"03:17:41","level":"INFO","agent":"Reviewer","task":"gh-42-0","event":"task_complete","cost":0.23,"turns":8}
{"ts":"03:17:42","level":"INFO","agent":"Fixer","task":"gh-42-1","event":"task_start","title":"バリデーションバグ修正"}
{"ts":"03:18:55","level":"INFO","agent":"Fixer","task":"gh-42-1","event":"tool_call","tool":"Edit","file":"src/auth.ts","lines_changed":3}
{"ts":"03:19:25","level":"INFO","agent":"Fixer","task":"gh-42-1","event":"tool_call","tool":"Bash","cmd":"npm test"}
{"ts":"03:19:50","level":"INFO","agent":"Fixer","task":"gh-42-1","event":"task_complete","cost":0.38,"turns":12}
{"ts":"04:00:00","level":"WARN","agent":"system","task":"-","event":"rate_limit_approaching","tasks_in_window":140}
```

**ログファイルの保存場所：** `logs/YYYY-MM-DD.jsonl`

**ログローテーション：** 30日間保持、それ以上は自動削除。

### 10.3 Slack通知

| イベント | 通知タイミング | 内容 |
|---------|-------------|------|
| タスク完了 | 即時 | タスク名、コスト、ターン数 |
| タスク失敗 | 即時 | タスク名、エラー内容、リトライ回数 |
| 認証エラー | 即時 | `claude login` 再実行の依頼（Maxプラン時） |
| Circuit breaker OPEN | 即時 | 緊急通知、確認依頼 |
| Rate limit 接近 | 即時 | 枠消費の警告（Maxプラン時） |
| Daily digest | 毎日 08:00 | 完了数、失敗数、合計コスト、作成PR数、平均所要時間 |

**Daily digest の例：**

```
📊 Daily digest
完了: 7 tasks (review: 3, fix: 2, build: 1, docs: 1)
失敗: 1 task (cron-r-0322 — timeout, retrying)
コスト: $4.23（概算）
PR作成: 3 (awaiting review)
平均所要時間: 5m 12s
```

---

## 11. コスト設計

### 11.1 Max プランでの運用

| プラン | 月額 | 枠の目安（5hウィンドウ） |
|--------|------|------------------------|
| Max 5x | $100 | Proの5倍（約225メッセージ） |
| Max 20x | $200 | Proの20倍（約900メッセージ） |

Max プランでは Extra Usage を有効にすることで、枠超過時のみ API 標準レートで従量課金を受けることもできる。

### 11.2 API 従量課金での月間コスト試算

| 運用パターン | 日次タスク数 | 月額目安 |
|------------|------------|---------|
| ライト | 5 | $66 |
| 標準 | 15 | $206 |
| ヘビー | 30 | $300+ |

### 11.3 コスト管理の階層

| レベル | Max プラン | API 従量課金 |
|--------|-----------|-------------|
| タスク単位 | maxBudgetUsd（間接制御） | maxBudgetUsd（厳密制御） |
| ターン単位 | maxTurns | maxTurns |
| 5hウィンドウ | Rate Controller | 不要 |
| 日次 | 不要（月額固定） | dailyBudgetUsd |
| 月次 | $200 固定 + Extra Usage | Daily digest で監視 |

---

## 12. 環境構築手順

### 12.1 WSL2 セットアップ

```bash
# 1. WSL2でsystemdを有効化
sudo sh -c 'echo "[boot]\nsystemd=true" > /etc/wsl.conf'
# Windowsターミナルで: wsl --shutdown && wsl

# 2. 必要パッケージのインストール
sudo apt update && sudo apt install -y git

# 3. Node.js インストール（v22以上必須）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# 4. Claude Code インストール
npm install -g @anthropic-ai/claude-code

# 5. プロジェクトの依存関係インストール（Agent SDK 含む）
cd ~/ai-engineer && npm install
```

### 12.2 Claude Code 認証

```bash
# Max プランの場合
claude login
# → ブラウザが開く → "Claude.ai" を選択 → Max プランのアカウントでログイン

# 認証状態の確認
claude auth status

# 重要: Max プランで使う場合は ANTHROPIC_API_KEY を設定しないこと
# API Key があると OAuth より優先される
```

### 12.3 ディレクトリ構造

```
~/ai-engineer/
├── src/
│   ├── index.ts           # エントリーポイント
│   ├── orchestrator.ts    # メインプロセス
│   ├── agents/            # エージェント定義
│   ├── queue/             # タスクキュー（SQLite）
│   ├── rate-controller.ts # レート制御
│   └── types.ts           # 型定義
├── package.json
├── tsconfig.json
├── .env                   # 環境変数（git管理外）
├── tasks.db               # タスクDB（自動生成）
└── logs/                  # 構造化ログ出力先
    └── 2026-03-22.jsonl

~/my-project/              # 対象のgitリポジトリ
├── .claude/
│   ├── CLAUDE.md          # エージェント共通ルール
│   └── handoff/           # Context Bridge ファイル
│       ├── gh-42-0_Reviewer.json
│       └── gh-42-1_Fixer.json
└── src/
    └── ...

~/worktrees/               # エージェント専用worktree
├── reviewer/
├── fixer/
├── builder/
└── scribe/
```

### 12.4 環境変数 (.env)

```bash
# === 課金方式 ===
# Max プランの場合: ANTHROPIC_API_KEY を設定しない（claude login の OAuth を使用）
# API 従量課金の場合: 以下を設定
# ANTHROPIC_API_KEY=sk-ant-...

# === Rate Controller ===
# Max プランの場合: RATE_CONTROL_ENABLED=true
# API 従量課金の場合: RATE_CONTROL_ENABLED=false
RATE_CONTROL_ENABLED=true
RATE_COOLDOWN_SECONDS=60

# === GitHub ===
GITHUB_TOKEN=ghp_...
GITHUB_REPO=your-org/your-repo

# === プロジェクトパス ===
PROJECT_DIR=/home/user/my-project
WORKTREE_DIR=/home/user/worktrees

# === Slack ===
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...

# === 運用パラメータ ===
DAILY_BUDGET_USD=10.0       # API 従量課金時のみ有効
MAX_CONCURRENT=1            # Max プラン: 1 推奨, API: 2 でOK
```

### 12.5 systemdサービス設定

```ini
# ~/.config/systemd/user/ai-engineer.service
[Unit]
Description=AI Engineering Team Orchestrator
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/user/ai-engineer
EnvironmentFile=/home/user/ai-engineer/.env
ExecStart=/usr/bin/node /home/user/ai-engineer/dist/index.js
Restart=always
RestartSec=30
StandardOutput=append:/home/user/ai-engineer/logs/stdout.log
StandardError=append:/home/user/ai-engineer/logs/stderr.log

[Install]
WantedBy=default.target
```

```bash
# サービスの有効化と起動
systemctl --user daemon-reload
systemctl --user enable ai-engineer
systemctl --user start ai-engineer

# ログ確認
journalctl --user -u ai-engineer -f
```

---

## 13. 段階的導入ロードマップ

### Phase 1: 単体エージェントの検証（1-2週間）

**目標：** WSL2上でClaude Agent SDKがMaxプランで動くことを確認する。

| タスク | 期間 | 成功条件 |
|--------|------|---------|
| WSL2 + Node.js + Claude Code + Agent SDK セットアップ | 1日 | `claude -p "hello"` が動く |
| `claude login` で Max プラン認証 | 1日 | `claude auth status` で認証確認 |
| Reviewer エージェント単体テスト（Agent SDK） | 3日 | `query()` でレビュー結果が構造化JSON出力される |
| Orchestrator 最小構成（TypeScript + キュー + 1エージェント） | 1週間 | タスク投入 → 実行 → 結果保存が動く |
| Nightly review のcron設定 | 1日 | 毎晩3時にレビューが自動実行される |

**設定：** `MAX_CONCURRENT=1`, `RATE_CONTROL_ENABLED=true`, `RATE_COOLDOWN_SECONDS=60`

### Phase 2: 2エージェント + パイプライン（2-4週間）

**目標：** Reviewer → Fixer のパイプラインが動くことを確認する。

| タスク | 期間 | 成功条件 |
|--------|------|---------|
| Fixer エージェント追加 | 3日 | バグ修正 + テスト実行が動く |
| Context Bridge 実装 | 3日 | Reviewerの指摘をFixerが読める |
| Classifier 実装 | 3日 | IssueがReview/Fixに自動分類される |
| GitHub Issue 自動取り込み | 3日 | ai-task ラベルで自動処理される |
| Slack 通知 | 1日 | 完了・失敗がSlackに通知される |

**設定：** `MAX_CONCURRENT=1`, `RATE_COOLDOWN_SECONDS=60`

### Phase 3: フルチーム稼働（1-2ヶ月）

**目標：** 4エージェントが協調して動くことを確認する。

| タスク | 期間 | 成功条件 |
|--------|------|---------|
| Builder エージェント追加 | 1週間 | 新機能実装 + テストが動く |
| Scribe エージェント追加 | 3日 | ドキュメント自動更新が動く |
| Circuit breaker 実装 | 3日 | 連続失敗で自動停止する |
| Rate Controller 実装 | 3日 | Max枠を超えないペース制御が動く |
| Daily digest 実装 | 1日 | 毎朝8時にサマリが届く |
| PR 自動作成 | 1週間 | エージェントの変更がPRになる |
| 本番運用開始 | - | 24時間安定稼働 |

**設定：** `MAX_CONCURRENT=1`, `RATE_COOLDOWN_SECONDS=60`

---

## 14. 既知の制約と回避策

### 14.1 Max プラン固有の制約

| # | 制約 | 影響 | 回避策 |
|---|------|------|--------|
| 1 | OAuthトークンが非対話モードで期限切れになるケースがある | 長時間稼働時に認証エラーが発生する可能性（GitHub Issue #28827） | Orchestrator がエラーを検出し Slack で通知。ユーザーが `claude login` を再実行。Agent SDK 側で修正される可能性あり |
| 2 | claude.ai と使用量枠を共有する | エージェントが枠を消費すると、自分の claude.ai 利用に影響 | Rate Controller でペースを抑える。夜間にタスクを集中させる運用 |
| 3 | `ANTHROPIC_API_KEY` が OAuth より優先される | 意図せず API 従量課金になる（GitHub Issue #33996） | Max プランで使う場合は `ANTHROPIC_API_KEY` を環境変数に設定しない |
| 4 | M2M (Machine-to-Machine) 認証の公式サポートがない | 自動化用途の正式な認証方法が未整備（GitHub Issue #1454） | OAuth ログインを維持。SDK の更新で改善される可能性あり |

### 14.2 Agent SDK 全般の制約

| # | 制約 | 影響 | 回避策 |
|---|------|------|--------|
| 1 | セッション間がステートレス | 前のタスクの結果を直接引き継げない | Context Bridge（JSON ファイル）で引き継ぎ |
| 2 | `maxBudgetUsd` は Max プラン時に厳密なドル単位制御として機能しない | タスク単位の費用上限が間接的になる | `maxTurns` とタイムアウトで間接制御。実質的な暴走防止には十分 |
| 3 | マルチターンセッション（`--session-id`/`--resume`）は CLI 機能 | Agent SDK の `query()` からは `resume` オプションで利用可能だが、Context Bridge の方がシンプル | 各タスクを独立した `query()` 呼び出しで実行し、Context Bridge で引き継ぎ |

### 14.3 将来の改善が期待される項目

- OAuth トークンの非対話モードでの自動更新（Issue #28827）
- M2M 認証のサポート（Issue #1454）
- Max プラン向けの使用量 API（残り枠のプログラム的取得）
- Agent SDK からのモデル指定の安定化

---

## 15. 今後の拡張可能性

| 拡張 | 概要 | 優先度 |
|------|------|--------|
| Agent Teams | Claude Code 実験機能。エージェント同士がメッセージで直接やりとり | 中 |
| Web UI ダッシュボード | タスク状態、コスト、ログをブラウザで確認 | 低 |
| 自動PR マージ | CI全パス + Reviewer承認で自動マージ | 中 |
| MCPサーバー連携 | Jira, Notion, Slack等との直接連携 | 高 |
| モデル使い分け | Orchestrator=Opus, Researcher=Haiku のようなモデル最適化 | 中 |
| API自動フォールバック | Max枠消費時にAPI Keyへ自動切り替え | 高 |
| セルフヒーリング | 失敗タスクの原因を別のエージェントが分析して自動修正 | 低 |

---

## 16. ファイル一覧

| ファイル | 説明 |
|---------|------|
| `src/index.ts` | エントリーポイント |
| `src/orchestrator.ts` | メインプロセス（Orchestrator） |
| `src/agents/` | エージェント定義（Reviewer, Fixer, Builder, Scribe） |
| `src/queue/` | タスクキュー（SQLite + better-sqlite3） |
| `src/rate-controller.ts` | Rate Controller（Max プラン用） |
| `src/types.ts` | 共通型定義（Task, AgentConfig 等） |
| `package.json` | 依存関係管理 |
| `tsconfig.json` | TypeScript コンパイラ設定 |
| `setup.sh` | WSL2 セットアップスクリプト |
| `.env` | 環境変数テンプレート |
| `CLAUDE.md` | エージェント共通コーディングルール |
| `ai-engineer.service` | systemd ユーザーサービス定義 |

---

*本設計書は 2026年3月22日時点の情報に基づく。Claude Agent SDK は活発に開発されており、特に Max プランの認証周りは改善が進む可能性が高い。該当箇所は最新の状況に合わせて随時更新すること。*
