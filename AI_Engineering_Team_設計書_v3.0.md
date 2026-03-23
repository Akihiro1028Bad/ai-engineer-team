# AI Engineering Team — 設計書 v3.0

> **版数:** v3.0（5層コンポジットアーキテクチャ）
> **作成日:** 2026年3月23日
> **前版からの変更:** アーキテクチャ全面刷新 — DAGベース計画層、品質ゲート層、学習フィードバック層を追加。6エージェント体制、階層型モデルルーティング、Per-Agent Circuit Breaker、階層型予算管理を導入。

---

## 1. 概要

### 1.1 プロジェクトの目的

24時間稼働可能なWindows PC（WSL2）上に、Claude Agent SDK ベースの7つの専門AIエージェント + 2つの補助エージェントを配置し、1つのエンジニアリングチームとして自律的にソフトウェア開発タスクを遂行するシステムを構築する。

v2.1 からの根本的な変更点:

| 観点 | v2.1 | v3.0 |
|------|------|------|
| アーキテクチャ | Dispatcher 1パターン | 5層コンポジット（Intake→Planning→Execution→Quality→Feedback） |
| 計画 | 固定2ステップ（review→fix/build） | Planner Agent が動的に DAG を生成 |
| 実行 | 逐次、単一パス | 並列ファンアウト + 反復ループ |
| 品質保証 | なし | Validation Gate + Generator-Critic Loop |
| モデル戦略 | Opus(分類+設計) + Sonnet(実装) | Haiku(分析・分類) + Sonnet(実行) + Opus(計画のみ) |
| 学習 | なし | Eval Store + Pattern Memory + Adaptive Model Routing |
| 障害耐性 | グローバル Circuit Breaker 1つ | Per-Agent Circuit Breaker + 階層型予算 |
| 推定コスト/タスク | $5-10 | $3-5 |

### 1.2 スコープ

本システムは以下の作業を自動処理する。7つの専門エージェントと2つの補助エージェントで構成される。

| 作業種別 | 担当エージェント | モデル | 主な作業内容 |
|----------|----------------|--------|-------------|
| Issue 分類・トリアージ | Classifier | Haiku | ラベル判定、複雑度分析、質問生成、自動トリアージ |
| コードベース分析 | Analyzer | Haiku | ファイル構造調査、依存関係マッピング、根本原因特定 |
| 実行計画策定 | Planner | Opus | DAG生成、モデル割当、コスト見積、リスク評価 |
| 設計書作成 | Designer | Sonnet | design.md 作成、テストケース設計、影響範囲分析 |
| コード実装 | Implementer | Sonnet | コーディング、テスト作成・実行、lint/型チェック |
| 品質検証 | Critic | Sonnet | コードレビュー、設計書↔実装一貫性検証、品質スコアリング |
| ドキュメント更新 | Scribe | Haiku | README、API docs、CHANGELOG の更新 |
| _プロンプト最適化_ | _Optimizer（補助）_ | _Opus_ | _月次プロンプト改善、A/Bテスト_ |
| _ツール生成_ | _Tool Synthesizer（補助）_ | _Sonnet_ | _不足スキルの自動生成・テスト・登録_ |

### 1.3 前提条件

- Windows PC（24時間稼働） + WSL2（Ubuntu 24.04）
- Node.js v22 以上
- Claude Max (20x) プラン、または Anthropic API Key
- Claude Code CLI（Agent SDK にバンドル）
- GitHub リポジトリ（ソースコード管理）
- Slack Webhook（通知用、任意）

### 1.4 使用技術

| コンポーネント | 技術 | 選定理由 |
|--------------|------|---------|
| エージェント実行 | Claude Agent SDK (TypeScript) | Native subagent、構造化出力、ストリーミング |
| タスクキュー | better-sqlite3 | 軽量、サーバー不要、永続化、WAL モード |
| バリデーション | Zod | 構造化出力スキーマ定義、型生成 |
| Git戦略 | worktree | エージェント間のファイル競合を完全回避 |
| 通知 | Slack Webhook API | リアルタイム通知 |
| 常駐化 | systemd user service | WSL2対応、自動再起動 |
| ログ | pino (JSON Lines) | 構造化ログ、高パフォーマンス |

---

## 2. アーキテクチャ

### 2.1 5層コンポジットアーキテクチャ

本システムは Google が定義する8つのマルチエージェントパターンのうち4つ（Coordinator、Parallel Fan-Out、Generator-Critic、Hierarchical）を組み合わせた **Composite Pattern** を採用する。

```
┌──────────────────────────────────────────────────────────────────┐
│                     Layer 5: FEEDBACK LOOP                       │
│                    学習・評価・コスト最適化                         │
│  ┌──────────────┐  ┌───────────────┐  ┌────────────────────────┐ │
│  │  Eval Store  │  │ Pattern Memory│  │ Adaptive Model Routing │ │
│  │  (SQLite)    │  │ (SQLite)      │  │ (コスト効率最大化)      │ │
│  └──────────────┘  └───────────────┘  └────────────────────────┘ │
├──────────────────────────────────────────────────────────────────┤
│                     Layer 4: QUALITY GATE                        │
│                    検証・批評・コンセンサス                         │
│  ┌────────────────────────┐  ┌──────────────────────────────┐   │
│  │    Validation Gate     │  │   Generator-Critic Loop      │   │
│  │ (全ハンドオフ時・Haiku) │  │  (高リスク時・Sonnet×2)      │   │
│  └────────────────────────┘  └──────────────────────────────┘   │
├──────────────────────────────────────────────────────────────────┤
│                     Layer 3: EXECUTION                           │
│                    並列実行・worktree 分離                        │
│  ┌─────────┐ ┌──────────┐ ┌─────────────┐ ┌────────┐ ┌───────┐ │
│  │Analyzer │ │ Designer │ │ Implementer │ │ Critic │ │ Scribe│ │
│  │ (Haiku) │ │ (Sonnet) │ │  (Sonnet)   │ │(Sonnet)│ │(Haiku)│ │
│  └─────────┘ └──────────┘ └─────────────┘ └────────┘ └───────┘ │
├──────────────────────────────────────────────────────────────────┤
│                     Layer 2: PLANNING                            │
│                    DAG ベース実行計画・動的分解                     │
│  ┌─────────────────────┐  ┌──────────────────────────────────┐  │
│  │   Planner Agent     │  │       DAG Scheduler              │  │
│  │   (Opus, 5ターン)    │  │ (トポロジカルソート + 並列実行)    │  │
│  └─────────────────────┘  └──────────────────────────────────┘  │
├──────────────────────────────────────────────────────────────────┤
│                     Layer 1: INTAKE                              │
│                    イベント駆動タスク受付・分類                     │
│  ┌─────────────┐  ┌────────────────┐  ┌────────────────────┐   │
│  │ GitHub      │  │  Classifier    │  │  Priority Queue    │   │
│  │ Poller      │  │  (Haiku)       │  │  (SQLite)          │   │
│  └─────────────┘  └────────────────┘  └────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 データフロー

```
                         ┌─── GitHub Issue ───┐
                         │                    │
                         ▼                    │
                   ┌──────────┐               │
                   │  Intake  │               │
                   │ (Haiku)  │               │
                   └────┬─────┘               │
                        │ TaskInput           │
                        ▼                     │
                   ┌──────────┐               │
                   │ Planning │               │
                   │  (Opus)  │               │
                   └────┬─────┘               │
                        │ ExecutionPlan (DAG) │
                        ▼                     │
                 ┌─────────────┐              │
              ┌──│  Execution  │──┐           │
              │  │             │  │           │
              ▼  └──────┬──────┘  ▼           │
         ┌────────┐     │    ┌────────┐       │
         │Worker A│     │    │Worker B│       │
         └───┬────┘     │    └───┬────┘       │
             │          │        │            │
             ▼          ▼        ▼            │
         ┌─────────────────────────┐          │
         │     Quality Gate        │          │
         │  Validation + Critic    │          │
         └───────────┬─────────────┘          │
                     │ pass                   │
                     ▼                        │
              ┌──────────────┐                │
              │ Result       │                │
              │ Collector    │────── PR ───────┘
              └──────┬───────┘      Slack
                     │
                     ▼
              ┌──────────────┐
              │ Feedback     │
              │ Loop (L5)    │
              └──────────────┘
```

### 2.3 層の責務

| 層 | 責務 | 入力 | 出力 |
|----|------|------|------|
| **L1: Intake** | タスク受付、分類、優先度付与、キュー投入 | GitHub Issue / cron / 手動入力 | `TaskInput` レコード |
| **L2: Planning** | タスク分析、DAG生成、モデル割当、コスト見積 | `TaskInput` + コードベースコンテキスト | `ExecutionPlan` (DAG) |
| **L3: Execution** | エージェント実行、worktree 分離、並列制御 | `ExecutionPlan` の各ノード | `NodeResult` |
| **L4: Quality Gate** | ハンドオフ検証、Generator-Critic ループ | `NodeResult` | `ValidatedResult` / 差し戻し |
| **L5: Feedback Loop** | 実行結果記録、パターン学習、モデル選択最適化 | `ValidatedResult` + メタデータ | 学習済みパターン（次回計画に反映） |

---

## 3. Layer 1: Intake — タスク受付・分類

### 3.1 タスクソース

| ソース | トリガー | 処理 |
|--------|---------|------|
| **GitHub Issues** | ポーリング（30秒間隔） | ラベルで分類、Classifier で複雑度判定 |
| **Cron** | 定時実行 | 夜間レビュー(03:00)、週次ドキュメント(月曜09:00) |
| **手動 CLI** | コマンド実行 | `npm run task:add` で直接投入 |
| **CI 失敗** | CI Monitor 検出 | 失敗ログから自動修正パイプライン生成 |

### 3.2 Classifier

**v2.1 からの変更:** Opus → **Haiku** に変更。コスト 1/30。

Classifier は GitHub Issue を受け取り、以下を判定する:

1. **タスクタイプ**: ラベルから `fix` / `build` / `document` を判定
2. **複雑度**: Haiku で Issue 本文を分析
   - `single`: 1-2 ファイルの小規模変更
   - `pipeline`: 設計→実装の標準パイプライン
   - `unclear`: 情報不足（Issue にコメントで質問を投稿）

**スコープ分析のエスカレーション:**
複雑度が `pipeline` の場合、追加でスコープ分析を実施:

```
Haiku (分類: $0.01) → 大規模判定の場合のみ → Sonnet (スコープ分割: $0.10)
```

Sonnet でのスコープ分析が失敗した場合は、キーワードベースのフォールバックヒューリスティクスを使用する。

### 3.3 共通スキーマ

```typescript
// === タスクタイプ ===
const TaskTypeSchema = z.enum(["review", "fix", "build", "document"]);
type TaskType = z.infer<typeof TaskTypeSchema>;

// === サブタスク定義（パイプライン構成用） ===
const SubTaskDefSchema = z.object({
  taskType: TaskTypeSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  dependsOnIndex: z.number().int().nullable(),
});
type SubTaskDef = z.infer<typeof SubTaskDefSchema>;

// === タスク入力（L1→L2 の受け渡し） ===
const TaskInputSchema = z.object({
  id: z.string().min(1),
  repo: z.string().min(1),
  taskType: TaskTypeSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  source: z.string().min(1),
  priority: z.number().int().min(1).max(10).default(5),
  issueNumber: z.number().int().nullable().default(null),
  labels: z.array(z.string()).default([]),
});
type TaskInput = z.infer<typeof TaskInputSchema>;
```

### 3.4 分類スキーマ

```typescript
const ClassificationSchema = z.discriminatedUnion("complexity", [
  z.object({
    issueId: z.number().int(),
    complexity: z.literal("single"),
    taskType: TaskTypeSchema,
  }),
  z.object({
    issueId: z.number().int(),
    complexity: z.literal("pipeline"),
    subTasks: z.array(SubTaskDefSchema).min(1),
  }),
  z.object({
    issueId: z.number().int(),
    complexity: z.literal("unclear"),
    question: z.string().min(1),
  }),
]);
```

### 3.5 Priority Queue

SQLite ベースの優先度付きキュー。WAL モードで並行アクセスに対応。

**優先度ルール（降順）:**
1. CI 修正タスク（`ci_fixing`）: 最優先
2. 承認済みタスク（`awaiting_approval` → 承認後の実装）
3. 手動投入タスク
4. GitHub Issue 由来タスク（priority フィールドで細分化）
5. Cron タスク: 最低優先

**重複排除:** `source` フィールドで同一ソースからの二重投入を防止。

---

## 4. Layer 2: Planning — DAG ベース実行計画

### 4.1 概要

v2.1 では「review → fix/build」の固定2ステップパイプラインだったが、v3.0 では **Planner Agent が動的に実行 DAG（有向非巡回グラフ）を生成**する。これにより:

- タスクの複雑度に応じた柔軟な実行計画
- 独立したサブタスクの並列実行
- 各ノードへの最適なモデル割当によるコスト最適化
- リスク評価に基づく品質ゲート適用判断

### 4.2 Planner Agent

| 項目 | 値 |
|------|-----|
| モデル | Opus |
| 最大ターン | 5 |
| 最大予算 | $1.00 |
| 許可ツール | Read, Glob, Grep（コードベース調査用） |
| 入力 | TaskInput + Analyzer の調査結果 + Pattern Memory |
| 出力 | ExecutionPlan（構造化JSON） |

**Planner の実行フロー:**

```
TaskInput
    ↓
Analyzer Agent (Haiku, $0.10)
  → コードベースの事前調査
  → 関連ファイル・依存関係の特定
  → 影響範囲の推定
    ↓
Planner Agent (Opus, $1.00)
  → Analyzer の結果 + Pattern Memory を入力
  → DAG ノードの定義
  → 各ノードへのモデル割当
  → コスト見積とリスク評価
    ↓
ExecutionPlan (DAG)
```

### 4.3 ExecutionPlan スキーマ

```typescript
const PlanNodeSchema = z.object({
  /** ノードの一意識別子 */
  id: z.string(),
  /** 実行するエージェントロール */
  agentRole: AgentRoleSchema,
  /** エージェントへのプロンプト */
  prompt: z.string(),
  /** 先行ノードID（これらが全て完了しないと実行されない） */
  dependsOn: z.array(z.string()),
  /** 後続ノードに渡す前の検証ルール（自然言語） */
  validationRule: z.string(),
  /** 使用モデル */
  model: z.enum(["haiku", "sonnet", "opus"]),
  /** 推定コスト（USD） */
  estimatedCostUsd: z.number(),
  /** Generator-Critic ループを適用するか */
  requiresCriticLoop: z.boolean(),
  /** 構造化出力のスキーマ（JSON Schema、任意） */
  outputSchema: z.record(z.unknown()).nullable().default(null),
  /** 最大リトライ回数（このノード単体） */
  maxRetries: z.number().int().min(0).max(3).default(1),
});
type PlanNode = z.infer<typeof PlanNodeSchema>;

const ExecutionPlanSchema = z.object({
  /** 元タスクID */
  taskId: z.string(),
  /** DAG のノード一覧 */
  nodes: z.array(PlanNodeSchema).min(1),
  /** クリティカルパス（最長依存チェーンのノードID列） */
  criticalPath: z.array(z.string()),
  /** 合計推定コスト */
  totalEstimatedCostUsd: z.number(),
  /** リスク評価 */
  riskLevel: z.enum(["low", "medium", "high"]),
  /** 計画の根拠（デバッグ・監査用） */
  rationale: z.string(),
});
type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;
```

### 4.4 DAG パターン例

**注:** 全パターンに共通して、Intake（Classifier: ~$0.01）と Planning（Planner: ~$1.00）のコストが加算される。以下の合計はDAG実行部分のみの費用。

#### パターン A: 小規模バグ修正（単純パイプライン）

```
[Analyze] ──→ [Design] ──→ [Implement] ──→ [Validate]
  Haiku        Sonnet       Sonnet          Haiku
  $0.05        $0.50        $1.00           $0.03
                            DAG 実行合計: $1.58  |  総合計: $2.59
```

#### パターン B: 中規模機能追加（設計→実装→レビュー）

```
[Analyze] ──→ [Design] ──→ [Implement] ──→ [Critic] ──→ [Validate]
  Haiku        Sonnet       Sonnet          Sonnet       Haiku
  $0.05        $0.50        $1.50           $0.30        $0.03
                            DAG 実行合計: $2.38  |  総合計: $3.39
```

#### パターン C: 大規模機能追加（並列ファンアウト）

```
                        ┌→ [Design-API]  ──→ [Impl-API]  ──┐
[Analyze] ──→           │                                    ├→ [Integration] ──→ [Critic] ──→ [Validate]
  Haiku                 └→ [Design-UI]  ──→ [Impl-UI]   ──┘     Sonnet         Sonnet        Haiku
  $0.05                    Sonnet×2        Sonnet×2               $0.50          $0.30         $0.03
                           $0.50×2         $1.50×2
                            DAG 実行合計: $5.88  |  総合計: $6.89
```

#### パターン D: CI 修正（高速フィードバック）

```
[Analyze-CI-Logs] ──→ [Fix] ──→ [Validate]
     Haiku              Sonnet     Haiku
     $0.05              $0.50      $0.03
                            DAG 実行合計: $0.58  |  総合計: $0.59
                            (Planner をスキップし、固定パイプラインで実行)
```

### 4.5 DAG Scheduler

DAG Scheduler は ExecutionPlan を受け取り、以下のアルゴリズムで実行する:

```
1. トポロジカルソートでノードの実行順序を決定
2. 依存関係のないノード群を特定（= 並列実行可能）
3. 並列実行可能なノードを Promise.all で同時起動
4. 各ノード完了時:
   a. Quality Gate (L4) の Validation Gate を通過させる
   b. 通過した場合 → 後続ノードの依存カウントをデクリメント
   c. 不通過の場合 → リトライ or 差し戻し
5. 全ノード完了 or 失敗で DAG 実行終了
```

**並列実行の制約:**
- `maxConcurrent` 設定に従う（Max プラン時は 1 推奨）
- worktree は role ごとに1つのため、同一 role の並列実行はできない
- 異なる role のノードは並列実行可能（Analyzer と Scribe は同時に動ける）

---

## 5. Layer 3: Execution — エージェント実行

### 5.1 エージェント定義

本システムは **7つの専門エージェント** + **2つの補助エージェント**（Optimizer, Tool Synthesizer）で構成される。

#### 5.1.0 Classifier（L1 専用）

```typescript
const CLASSIFIER_CONFIG = {
  role: "classifier",
  model: "haiku",
  maxTurns: 3,
  maxBudgetUsd: 0.05,
  timeoutMs: 60_000,  // 1分
  permissionMode: "dontAsk",
  allowedTools: [],  // ツール不要（テキスト分析のみ）
  systemPrompt: `あなたは Issue 分類の専門家です。
GitHub Issue を分析し、以下を判定してください:
1. タスクタイプ: fix / build / document
2. 複雑度: single / pipeline / unclear
3. unclear の場合: ユーザーに確認すべき具体的な質問

ラベルがある場合はラベルを優先、ない場合は自動トリアージも実施してください。`,
} as const;
```

**注:** Classifier は L1（Intake）専用であり、DAG 実行には参加しない。Issue のトリアージ・分類・質問生成・コメント分類を担当する。

#### 5.1.1 Analyzer

```typescript
const ANALYZER_CONFIG = {
  role: "analyzer",
  model: "haiku",
  maxTurns: 10,
  maxBudgetUsd: 0.10,
  timeoutMs: 300_000,  // 5分
  permissionMode: "dontAsk",
  allowedTools: ["Read", "Glob", "Grep"],
  systemPrompt: `あなたはコードベース分析の専門家です。
与えられたタスクに関連するコードの構造を調査し、以下を特定してください:

1. 関連ファイルの一覧とその役割
2. 依存関係グラフ（どのモジュールがどのモジュールに依存しているか）
3. 変更が必要と推定されるファイルと箇所
4. テストファイルの有無と既存テストのカバレッジ状況
5. 潜在的なリスク（破壊的変更の可能性、パフォーマンスへの影響）

調査結果は構造化された形式で出力してください。コードの修正は行わないでください。`,
} as const;
```

**Analyzer の構造化出力スキーマ:**

```typescript
const AnalysisResultSchema = z.object({
  /** 関連ファイルとその役割 */
  relevantFiles: z.array(z.object({
    path: z.string(),
    role: z.string(),
    linesOfCode: z.number().int().optional(),
  })),
  /** 依存関係グラフ（edges） */
  dependencies: z.array(z.object({
    from: z.string(),
    to: z.string(),
    type: z.enum(["import", "call", "inherit", "implement"]),
  })),
  /** 変更が必要と推定される箇所 */
  suggestedChanges: z.array(z.object({
    file: z.string(),
    reason: z.string(),
    estimatedLines: z.number().int().optional(),
  })),
  /** テスト状況 */
  testCoverage: z.object({
    hasTests: z.boolean(),
    testFiles: z.array(z.string()),
    estimatedCoverage: z.enum(["none", "low", "medium", "high"]).optional(),
  }),
  /** リスク評価 */
  risks: z.array(z.object({
    description: z.string(),
    severity: z.enum(["high", "medium", "low"]),
  })),
  /** 要約 */
  summary: z.string(),
});
type AnalysisResult = z.infer<typeof AnalysisResultSchema>;
```

#### 5.1.2 Planner

```typescript
const PLANNER_CONFIG = {
  role: "planner",
  model: "opus",
  maxTurns: 5,
  maxBudgetUsd: 1.00,
  timeoutMs: 600_000,  // 10分
  permissionMode: "dontAsk",
  allowedTools: ["Read", "Glob", "Grep"],
  systemPrompt: `あなたは実行計画策定の専門家です。
タスクの分析結果と過去の実行パターンを基に、最適な実行計画（DAG）を生成してください。

## 計画策定の原則

1. **最小コスト原則**: 品質を維持できる最も安いモデルを選択する
   - 分析・検証 → Haiku ($0.01-0.05)
   - 設計・実装・レビュー → Sonnet ($0.30-1.50)
   - Opus は計画策定（この段階）でのみ使用
2. **並列化原則**: 独立したサブタスクは並列実行可能にする
3. **早期検証原則**: 高コストなノードの前に低コストな検証を挟む
4. **リスク比例原則**: riskLevel が high のタスクには requiresCriticLoop: true を設定

## 過去のパターン情報

以下の過去の実行パターンを参考にしてください（提供される場合）:
- 類似タスクの成功/失敗パターン
- モデル別の成功率とコスト
- よくある失敗原因

## 出力形式

ExecutionPlan スキーマに従った JSON を出力してください。`,
} as const;
```

#### 5.1.3 Designer

```typescript
const DESIGNER_CONFIG = {
  role: "designer",
  model: "sonnet",
  maxTurns: 30,
  maxBudgetUsd: 1.00,
  timeoutMs: 900_000,  // 15分
  permissionMode: "acceptEdits",
  allowedTools: ["Read", "Write", "Edit", "Glob", "Grep"],
  systemPrompt: `あなたは設計レビュアーです。GitHub Issue を分析し、設計書を作成してください。

## 手順
1. Issue の内容を理解する
2. 対象コードベースを調査する（Read, Glob, Grep を使用）
3. 問題の原因を特定し、修正方針を決定する
4. specs/issue-{ISSUE_NUMBER}/design.md を作成する

## 設計書に含める内容
- **問題分析**: 現状の動作、問題の原因（コード箇所を特定）
- **修正方針**: 変更対象ファイルと変更内容、選択しなかった代替案とその理由
- **影響範囲**: 影響を受けるコンポーネント、破壊的変更の有無
- **テストケース（カバレッジ 100% 目標）**:
  - ユニットテスト: 全分岐・境界値をカバー
  - 統合テスト: コンポーネント間の連携
  - ブラウザ動作確認: 画面ごとの確認項目、スクリーンショット確認項目
- **実装手順**: 番号付きステップで具体的に記述

## 重要
- コードの修正は行わないでください。設計書の作成のみです。
- テストケースはカバレッジ率100%を目指してください。`,
} as const;
```

#### 5.1.4 Implementer

```typescript
const IMPLEMENTER_CONFIG = {
  role: "implementer",
  model: "sonnet",
  maxTurns: 50,
  maxBudgetUsd: 2.00,
  timeoutMs: 2_400_000,  // 40分
  permissionMode: "acceptEdits",
  allowedTools: [
    "Read", "Edit", "Write", "Glob", "Grep",
    "Bash(npm test *)", "Bash(npm run test*)", "Bash(npx jest *)", "Bash(npx vitest *)",
    "Bash(npm run lint*)", "Bash(npx tsc *)",
    "Bash(npm install *)", "Bash(npx *)",
    "Bash(git diff *)", "Bash(git status *)",
    "Bash(git add *)", "Bash(git commit *)",
  ],
  systemPrompt: `あなたは実装エージェントです。承認された設計書に従って実装を行ってください。

## 手順
1. specs/issue-{ISSUE_NUMBER}/design.md を読む
2. 設計書の「実装手順」に従って実装する
3. 設計書の「テストケース」に従ってテストを作成する
4. テストを実行し、全テストが通ることを確認する
5. lint と型チェックも通ることを確認する

## 重要
- 設計書に記載されていない変更は行わないでください。
- テストが通らない場合は修正してください。
- 全てのテストが PASS するまで完了としないでください。`,
} as const;
```

#### 5.1.5 Critic

```typescript
const CRITIC_CONFIG = {
  role: "critic",
  model: "sonnet",
  maxTurns: 15,
  maxBudgetUsd: 0.50,
  timeoutMs: 600_000,  // 10分
  permissionMode: "dontAsk",
  allowedTools: ["Read", "Glob", "Grep", "Bash(npm test *)", "Bash(npm run test*)", "Bash(npx tsc *)"],
  systemPrompt: `あなたはコード品質の専門的な批評家です。

## 検証項目
1. **設計書との一貫性**: design.md に記載された方針と実装が一致しているか
2. **コード品質**: 命名規則、関数設計、エラーハンドリング、型安全性
3. **テストカバレッジ**: 設計書のテストケースが全て実装されているか
4. **セキュリティ**: OWASP Top 10 の観点で問題がないか
5. **パフォーマンス**: 明らかな非効率がないか

## 出力形式
以下の構造で検証結果を報告してください:
- **品質スコア**: 0-100（80以上で合格）
- **指摘事項**: 各項目の severity (critical/warning/info) と具体的な問題箇所
- **改善提案**: 具体的なコード修正案（critical の場合のみ）
- **合否判定**: pass / fail_with_suggestions / fail_critical`,
} as const;
```

#### 5.1.6 Scribe

```typescript
const SCRIBE_CONFIG = {
  role: "scribe",
  model: "haiku",
  maxTurns: 10,
  maxBudgetUsd: 0.10,
  timeoutMs: 300_000,  // 5分
  permissionMode: "acceptEdits",
  allowedTools: ["Read", "Edit", "Write", "Glob", "Grep"],
  systemPrompt: `あなたはドキュメント更新エージェントです。
変更内容に合わせてドキュメントを更新してください。
必要最小限の更新のみ行い、過剰な修正は避けてください。`,
} as const;
```

#### 5.1.7 Optimizer（補助エージェント — 月次プロンプト最適化用）

```typescript
const OPTIMIZER_CONFIG = {
  role: "optimizer",
  model: "opus",
  maxTurns: 10,
  maxBudgetUsd: 2.00,
  timeoutMs: 1_200_000,  // 20分
  permissionMode: "dontAsk",
  allowedTools: ["Read", "Glob", "Grep"],
  systemPrompt: `あなたはプロンプト最適化の専門家です。
過去の実行結果とPRフィードバックを分析し、各エージェントのシステムプロンプトの改善案を生成してください。
改善は具体的かつ根拠データ付きで提示してください。`,
} as const;
```

#### 5.1.8 Tool Synthesizer（補助エージェント — ToolForge 用）

```typescript
const TOOL_SYNTHESIZER_CONFIG = {
  role: "tool_synthesizer",
  model: "sonnet",
  maxTurns: 30,
  maxBudgetUsd: 1.00,
  timeoutMs: 1_200_000,  // 20分
  permissionMode: "acceptEdits",
  allowedTools: [
    "Read", "Edit", "Write", "Glob", "Grep",
    "Bash(npm test *)", "Bash(npm run test*)", "Bash(npx tsc *)",
  ],
  systemPrompt: `あなたはツール開発の専門家です。
不足しているツールの handler.ts, schema.ts, tests.ts, SKILL.md を生成してください。
テストは最低5ケース作成し、全て PASS することを確認してください。`,
} as const;
```

### 5.2 エージェント構成サマリー

| Layer | Agent | Model | Turns | Budget | Timeout | Permission | Tools |
|-------|-------|-------|-------|--------|---------|------------|-------|
| L1 | **Classifier** | Haiku | 3 | $0.05 | 1分 | dontAsk | なし（テキスト分析のみ） |
| L3 | **Analyzer** | Haiku | 10 | $0.10 | 5分 | dontAsk | Read, Glob, Grep |
| L2 | **Planner** | Opus | 5 | $1.00 | 10分 | dontAsk | Read, Glob, Grep |
| L3 | **Designer** | Sonnet | 30 | $1.00 | 15分 | acceptEdits | Read, Write, Edit, Glob, Grep |
| L3 | **Implementer** | Sonnet | 50 | $2.00 | 40分 | acceptEdits | Read, Edit, Write, Glob, Grep, Bash(test/lint/npm/git) |
| L4 | **Critic** | Sonnet | 15 | $0.50 | 10分 | dontAsk | Read, Glob, Grep, Bash(test/tsc) |
| L3 | **Scribe** | Haiku | 10 | $0.10 | 5分 | acceptEdits | Read, Edit, Write, Glob, Grep |
| 補助 | **Optimizer** | Opus | 10 | $2.00 | 20分 | dontAsk | Read, Glob, Grep |
| 補助 | **Tool Synthesizer** | Sonnet | 30 | $1.00 | 20分 | acceptEdits | Read, Edit, Write, Glob, Grep, Bash(test/tsc) |

### 5.3 SDK Native Subagent パターン

v3.0 では、DAG の各ノードを個別の `query()` 呼び出しで実行する。将来的に SDK の `agents` オプションを使った native subagent パターンへの移行を検討する。

**現在の実行方式（ノードごとに独立 `query()`）:**
```typescript
// DAG Scheduler が各ノードを個別に実行
async function executeNode(node: PlanNode, context: NodeContext): Promise<NodeResult> {
  const config = getAgentConfig(node.agentRole);
  const cwd = worktreeManager.prepare(node.agentRole, node.id);

  for await (const message of query({
    prompt: node.prompt,
    options: {
      allowedTools: [...config.allowedTools],
      permissionMode: config.permissionMode,
      maxTurns: config.maxTurns,
      maxBudgetUsd: config.maxBudgetUsd,
      model: node.model,
      systemPrompt: config.systemPrompt,
      cwd,
      outputFormat: node.outputSchema
        ? { type: "json_schema", schema: node.outputSchema }
        : undefined,
    },
  })) {
    if (message.type === "result") {
      return processResult(message, node);
    }
  }
}
```

**将来の native subagent パターン:**
```typescript
// Orchestrator Agent が subagent を統括
for await (const message of query({
  prompt: dagToPrompt(plan),
  options: {
    allowedTools: ["Task"],  // 委譲のみ
    model: "sonnet",
    agents: {
      analyzer: { ...ANALYZER_CONFIG, description: "..." },
      designer: { ...DESIGNER_CONFIG, description: "..." },
      implementer: { ...IMPLEMENTER_CONFIG, description: "..." },
      critic: { ...CRITIC_CONFIG, description: "..." },
    },
  },
})) { /* ... */ }
```

### 5.4 Worktree 管理

各リポジトリ × 各エージェントロールに1つの worktree を割り当てる。複数リポジトリ対応のため、`{worktreeDir}/{repoId}/{role}/` のレイアウトを採用する。

```
~/worktrees/
├── frontend/           # リポジトリ "frontend" 用
│   ├── analyzer/
│   ├── designer/
│   ├── implementer/
│   ├── critic/
│   └── scribe/
├── backend/            # リポジトリ "backend" 用
│   ├── analyzer/
│   ├── designer/
│   ├── implementer/
│   ├── critic/
│   └── scribe/
└── ...
```

**単一リポジトリモード:** `repos.json` が未設定の場合、従来通り `{worktreeDir}/{role}/` のフラットレイアウトにフォールバックする。

**ブランチ命名規則:**
```
agent/{role}/{taskId}
例: agent/designer/gh-42-0
    agent/implementer/gh-42-1
```

タスク ID のサフィックス `-0`, `-1`, ... はパイプライン内のステップ番号を示す。スコープ分割時は `gh-42-scope-1-0` のように scope ID が挟まる。

**同一ブランチ戦略:** 設計→実装のパイプラインでは、Designer が作成したブランチを Implementer が引き継ぐ。具体的な Git 操作は以下の通り:

```
1. Designer が worktrees/{repo}/designer/ で作業
   → ブランチ agent/designer/gh-42-0 を作成、design.md をコミット・プッシュ
2. 承認後、Implementer の worktree を準備:
   → worktrees/{repo}/implementer/ で git fetch origin
   → git checkout agent/designer/gh-42-0 (Designer のブランチを直接チェックアウト)
   → 実装コードをコミット・プッシュ（同一ブランチ、同一 PR に追加される）
```

これにより design.md と実装コードが同一 PR に含まれる。

---

## 6. Layer 4: Quality Gate — 検証・批評

### 6.1 Validation Gate

**全てのノード間ハンドオフに適用**される軽量検証。Haiku で実行するためコストは極めて低い（$0.01-0.03/回）。

#### 検証項目

| # | 検証 | 手法 | 失敗時の動作 |
|---|------|------|-------------|
| 1 | **スキーマ検証** | Zod safeParse | 即座にリトライ |
| 2 | **完全性検証** | Haiku で出力の網羅性をチェック | リトライ（プロンプト補足付き） |
| 3 | **一貫性検証** | Haiku で前ノード出力との整合性チェック | 差し戻し |
| 4 | **安全性検証** | diff サイズ上限(500行)、禁止パターン検出 | 差し戻し + アラート |

#### Validation Gate スキーマ

```typescript
const ValidationResultSchema = z.object({
  /** 検証に通過したか */
  passed: z.boolean(),
  /** 信頼度スコア (0.0-1.0) */
  confidence: z.number().min(0).max(1),
  /** 検出された問題 */
  issues: z.array(z.object({
    severity: z.enum(["critical", "warning", "info"]),
    category: z.enum(["schema", "completeness", "consistency", "safety"]),
    message: z.string(),
    suggestion: z.string().optional(),
  })),
});
type ValidationResult = z.infer<typeof ValidationResultSchema>;
```

#### 検証フロー

```
NodeResult
    │
    ▼
┌──────────────┐    fail     ┌─────────────┐
│  Schema      │────────────→│  Retry      │
│  Validation  │             │  (max 2回)   │
└──────┬───────┘             └─────────────┘
       │ pass
       ▼
┌──────────────┐    fail     ┌─────────────┐
│  Semantic    │────────────→│  Retry with │
│  Validation  │             │  補足プロンプト│
│  (Haiku)     │             └─────────────┘
└──────┬───────┘
       │ pass
       ▼
┌──────────────┐    fail     ┌─────────────┐
│  Safety      │────────────→│  差し戻し    │
│  Check       │             │  + アラート   │
└──────┬───────┘             └─────────────┘
       │ pass
       ▼
  ValidatedResult
```

### 6.2 Generator-Critic Loop

**高リスクタスクにのみ適用**される反復的品質改善ループ。

#### 適用基準

以下のいずれかに該当する場合に自動適用:

| 条件 | 閾値 |
|------|------|
| Planner が `requiresCriticLoop: true` を設定 | — |
| 変更行数 (diff) | > 100行 |
| セキュリティ関連の変更 | ファイルパスに `auth`, `security`, `crypto` を含む |
| Validation Gate の confidence | < 0.7 |

#### ループフロー

```
┌──────────────┐         output          ┌──────────────┐
│  Implementer │ ───────────────────────→│   Critic     │
│  (Generator) │                         │  (Evaluator) │
│  Sonnet      │←───────────────────────│  Sonnet      │
└──────────────┘     feedback +          └──────────────┘
       ↑             quality score              │
       │                                        │
       └────── score < 80 かつ iteration < 3 ───┘
                          │
                   score >= 80 or iteration >= 3
                          ↓
                   Final Output
```

#### Critic の出力スキーマ

```typescript
const CriticResultSchema = z.object({
  qualityScore: z.number().int().min(0).max(100),
  verdict: z.enum(["pass", "fail_with_suggestions", "fail_critical"]),
  findings: z.array(z.object({
    severity: z.enum(["critical", "warning", "info"]),
    file: z.string(),
    line: z.number().int().optional(),
    issue: z.string(),
    suggestion: z.string(),
  })),
  summary: z.string(),
});
type CriticResult = z.infer<typeof CriticResultSchema>;
```

#### ループの終了条件

| 条件 | 動作 |
|------|------|
| `qualityScore >= 80` | 合格 → 次のノードへ進行 |
| `verdict === "pass"` | 合格 → 次のノードへ進行 |
| `iteration >= 3` | 反復上限 → 最新の結果をそのまま使用（警告付き） |
| `verdict === "fail_critical"` かつ修正不能 | 失敗 → DAG 全体を中断、人間にエスカレート |

---

## 7. Layer 5: Feedback Loop — 学習・評価・最適化

### 7.1 Eval Store

全ての DAG ノード実行結果を構造化して記録する。

```sql
CREATE TABLE eval_results (
  id TEXT PRIMARY KEY,
  -- 紐づけ
  task_id TEXT NOT NULL,
  plan_node_id TEXT NOT NULL,
  dag_id TEXT NOT NULL,
  -- エージェント情報
  agent_role TEXT NOT NULL,
  model TEXT NOT NULL,
  -- パフォーマンス
  cost_usd REAL NOT NULL,
  duration_ms INTEGER NOT NULL,
  turns_used INTEGER NOT NULL,
  -- 品質
  success BOOLEAN NOT NULL,
  quality_score INTEGER,          -- Critic の品質スコア (0-100)
  validation_confidence REAL,     -- Validation Gate の confidence (0.0-1.0)
  critic_iterations INTEGER,      -- Generator-Critic ループの反復回数
  -- テスト結果
  tests_passed INTEGER,
  tests_failed INTEGER,
  lint_errors INTEGER,
  diff_lines INTEGER,
  -- 失敗分析
  failure_category TEXT,           -- 'timeout' | 'budget' | 'quality' | 'crash' | 'validation'
  failure_details TEXT,
  -- コンテキスト
  repo TEXT NOT NULL,              -- 対象リポジトリ ID
  issue_labels TEXT,               -- JSON array of labels
  file_count INTEGER,              -- 変更ファイル数
  -- タイムスタンプ
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_eval_repo ON eval_results(repo);
CREATE INDEX idx_eval_agent_model ON eval_results(agent_role, model);
CREATE INDEX idx_eval_success ON eval_results(success);
CREATE INDEX idx_eval_created ON eval_results(created_at);
```

### 7.2 Pattern Memory

過去の実行結果から学習したパターンを保持し、Planner に注入する。

```sql
CREATE TABLE pattern_memory (
  id TEXT PRIMARY KEY,
  -- リポジトリ（リポジトリ固有の学習パターン）
  repo TEXT NOT NULL,
  -- パターン識別
  pattern_type TEXT NOT NULL,      -- 'model_performance' | 'failure_pattern' | 'cost_estimate'
  pattern_key TEXT NOT NULL,       -- e.g., "implementer:fix:sonnet"
  -- パターンデータ
  data TEXT NOT NULL,              -- JSON
  -- メタ情報
  occurrences INTEGER NOT NULL DEFAULT 1,
  last_updated TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(repo, pattern_type, pattern_key)
);
```

#### 学習されるパターン

**モデルパフォーマンス:**
```json
{
  "pattern_type": "model_performance",
  "pattern_key": "implementer:fix:sonnet",
  "data": {
    "successRate": 0.87,
    "avgCostUsd": 1.23,
    "avgDurationMs": 180000,
    "avgQualityScore": 82,
    "sampleCount": 45
  }
}
```

**失敗パターン:**
```json
{
  "pattern_type": "failure_pattern",
  "pattern_key": "test_failure_after_auth_change",
  "data": {
    "description": "auth モジュール変更後にテストが失敗する傾向",
    "mitigation": "auth 関連テストスイートを事前チェックに含める",
    "occurrences": 5,
    "lastOccurrence": "2026-03-20"
  }
}
```

**コスト予測:**
```json
{
  "pattern_type": "cost_estimate",
  "pattern_key": "fix:small:2files",
  "data": {
    "predictedCostUsd": 1.50,
    "actualCostAvgUsd": 1.23,
    "accuracy": 0.82,
    "sampleCount": 12
  }
}
```

### 7.3 Adaptive Model Routing

Eval Store のデータを基に、各ノードに最適なモデルを動的に選択する。

```typescript
function selectModel(
  agentRole: AgentRole,
  taskContext: TaskContext,
  history: EvalResult[],
): ModelChoice {
  // 1. 類似タスクの過去結果をフィルタリング
  const similar = history.filter(h =>
    h.agentRole === agentRole &&
    h.issueLabels?.some(l => taskContext.labels.includes(l))
  );

  if (similar.length < 5) {
    // データ不足 → デフォルトモデルを使用
    return getDefaultModel(agentRole);
  }

  // 2. モデル別の成績を集計
  const stats = aggregateByModel(similar);

  // 3. コスト効率（成功率 / コスト）が最大のモデルを選択
  //    ただし成功率 80% 未満のモデルは除外
  return stats
    .filter(s => s.successRate >= 0.80)
    .sort((a, b) =>
      (b.successRate / b.avgCostUsd) - (a.successRate / a.avgCostUsd)
    )[0]?.model ?? getDefaultModel(agentRole);
}
```

**安全策:** データが5件未満の場合はデフォルトモデルにフォールバック。新モデルの探索のため、10% の確率でランダムにモデルを選択する（Epsilon-Greedy 戦略）。

### 7.4 Pattern Injection

Planner Agent のプロンプトに、関連する Pattern Memory を自動注入する:

```typescript
function buildPlannerPrompt(task: TaskInput, analysis: AnalysisResult): string {
  const patterns = patternMemory.getRelevantPatterns(task, analysis);

  return [
    PLANNER_BASE_PROMPT,
    "",
    "## 過去の実行パターン（参考情報）",
    "",
    patterns.modelPerformance.length > 0
      ? `### モデル別パフォーマンス\n${formatModelStats(patterns.modelPerformance)}`
      : "",
    patterns.failurePatterns.length > 0
      ? `### 注意すべき失敗パターン\n${formatFailurePatterns(patterns.failurePatterns)}`
      : "",
    patterns.costEstimates.length > 0
      ? `### コスト予測\n${formatCostEstimates(patterns.costEstimates)}`
      : "",
    "",
    "## タスク情報",
    "",
    `タイトル: ${task.title}`,
    `説明: ${task.description}`,
    "",
    "## Analyzer の調査結果",
    "",
    analysis.summary,
  ].filter(Boolean).join("\n");
}
```

---

## 8. 安全設計

### 8.1 3層防壁（v2.1 からの強化）

| 層 | v2.1 | v3.0 |
|----|------|------|
| **Agent** | maxTurns, maxBudget, allowedTools, AbortController | 同左（各エージェントに個別設定） |
| **Orchestrator** | グローバル Circuit Breaker, Rate Controller, Budget Guard | **Per-Agent CB**, Rate Controller, **階層型 Budget Guard** |
| **Git** | worktree 分離, ブランチ保護, diff 上限 500行 | 同左 + **Validation Gate による diff 検証** |

### 8.2 Per-Agent Circuit Breaker

v2.1 ではグローバルに1つの Circuit Breaker だったが、v3.0 ではエージェントロール × タスクタイプごとに独立した Circuit Breaker を持つ。

```typescript
interface CircuitBreakerConfig {
  /** 識別キー (例: "implementer:fix") */
  key: string;
  /** OPEN 遷移までの連続失敗回数 */
  failureThreshold: number;
  /** OPEN → HALF_OPEN までの冷却時間 */
  cooldownMs: number;
  /** HALF_OPEN 状態での最大試行回数 */
  halfOpenMaxAttempts: number;
}
```

**デフォルト設定:**

| Agent | Threshold | Cooldown | 根拠 |
|-------|-----------|----------|------|
| Analyzer | 5 | 30分 | 低コスト、頻繁にリトライ可能 |
| Planner | 3 | 1時間 | 高コスト、慎重にリトライ |
| Designer | 3 | 1時間 | 中コスト |
| Implementer | 3 | 1時間 | 高コスト |
| Critic | 5 | 30分 | 低コスト |
| Scribe | 5 | 30分 | 低コスト |

**利点:** Implementer が3回連続失敗しても、Analyzer や Critic は影響を受けない。

### 8.3 階層型予算管理

日次予算を5つのプールに分割し、各層が独立に予算管理する。

```
Daily Budget (例: $20)
  ├── Intake Budget   (5%)  = $1.00   ← Classifier (Haiku)
  ├── Planning Budget (20%) = $4.00   ← Analyzer + Planner
  ├── Execution Budget(55%) = $11.00  ← Designer + Implementer + Scribe
  ├── Quality Budget  (15%) = $3.00   ← Validation Gate + Critic
  └── Reserve         (5%)  = $1.00   ← 緊急時の予備
```

**ルール:**
- 各プールは独立に消費を追跡
- プール残高がゼロになった場合、その層のタスクは翌日まで保留
- **Quality Budget は Execution Budget より先に枯渇してはならない**（品質検証を省略させないため）
- Reserve は手動承認でのみ使用可能

### 8.4 タイムアウトとキャンセル

各 `query()` 呼び出しに `AbortController` を設定し、タイムアウト時に強制キャンセルする。

```typescript
async function executeWithTimeout(
  node: PlanNode,
  config: AgentConfig,
): Promise<NodeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    // query() に abortController を渡す
    for await (const message of query({
      prompt: node.prompt,
      options: {
        ...config,
        abortController: controller,
      },
    })) {
      if (message.type === "result") return processResult(message);
    }
  } finally {
    clearTimeout(timeout);
  }
}
```

### 8.5 diff サイズ制限

| 制限 | 値 | 超過時の動作 |
|------|-----|-------------|
| 単一ノードの diff | 500行 | Validation Gate で拒否、Planner に再分割を要求 |
| PR 全体の diff | 1000行 | PR 作成を拒否、アラート送信 |

---

## 9. タスクライフサイクル

### 9.1 状態遷移図

```
                              ┌─────────┐
                              │ pending │◄──── 新規タスク投入
                              └────┬────┘
                                   │
                    ┌──────────────┼──────────────┐
                    ▼              ▼               ▼
             ┌────────────┐ ┌──────────────┐ ┌────────────────┐
             │ clarifying │ │  planning    │ │ dry_run_preview│
             │(Issue不明確)│ └──────┬───────┘ │ (計画プレビュー) │
             └──┬──────┬──┘        │         └───────┬────────┘
                │      │           │          approve│
         解決   │      │timeout/   ▼                 │
                │      │3往復   ┌──────────────┐     │
                │      │       │ in_progress  │◄────┘
                │      ▼       └──┬───────┬───┘
                │  ┌────────┐     │       │
                │  │ failed │     │       │
                │  └────────┘  success  failure
                │              ▼       ▼
                └─→planning  ┌────────────────┐ ┌────────┐
                   (通常フロー)│awaiting_approval│ │ failed │
                             │  (設計PR承認待ち)│ └────────┘
                   └───────┬────────┘
                           │
                    approve│  reject
                       ┌───┘───┐
                       ▼       ▼
                ┌────────────┐ ┌──────────┐
                │implementing│ │ rejected │
                └─────┬──────┘ └──────────┘
                      │
                      ▼
                ┌────────────┐
                │ci_checking │
                └─────┬──────┘
                   ┌──┴──┐
                   ▼     ▼
            ┌──────────┐ ┌────────────┐
            │ci_passed │ │ ci_fixing  │ ←── 自動修正 (最大3回)
            └────┬─────┘ └─────┬──────┘
                 │             │
                 ▼             ▼
            ┌──────────┐ ┌──────────┐
            │completed │ │ ci_failed│
            └──────────┘ └──────────┘
```

**補足:**
- `clarifying`: 最大3往復の質問後、回答がなければ `failed` に遷移。回答で解決すれば `planning` へ。
- `dry_run_preview`: Dry Run モード時、DAG 生成後にプレビューを提示して一時停止。「実行」コメントで `in_progress` へ、「キャンセル」で `failed` へ。
- `implementing` → `completed`: CI が設定されていないリポジトリでは `ci_checking` をスキップして直接 `completed` に遷移可能。
- `awaiting_approval`: DAG 全体完了後ではなく、**設計ノード完了時点**で遷移する（DAG はここで一時停止）。承認後に残りのノード（実装以降）を実行。

### 9.2 TaskStatus

```typescript
const TaskStatusSchema = z.enum([
  "pending",              // キューで待機中
  "clarifying",           // Issue の内容が不明確 → ディスカッション中
  "planning",             // Planner がDAG生成中
  "dry_run_preview",      // Dry Run モード: プレビュー提示中、人間の確認待ち
  "in_progress",          // DAG 実行中
  "awaiting_approval",    // 設計PR が人間の承認待ち（DAG 一時停止中）
  "implementing",         // 承認後、実装DAG実行中
  "completed",            // 全工程完了
  "failed",               // 最大リトライ後も失敗 / clarifying タイムアウト
  "rejected",             // 人間が設計を却下
  "ci_checking",          // CI 結果待ち
  "ci_passed",            // CI 通過
  "ci_fixing",            // CI 失敗を自動修正中
  "ci_failed",            // CI 修正の最大試行回数超過
]);
```

### 9.3 Task スキーマ

```typescript
const TaskSchema = z.object({
  id: z.string().min(1),
  /** 対象リポジトリ ID（repos.json の id） */
  repo: z.string().min(1),
  taskType: TaskTypeSchema,
  title: z.string().min(1),
  description: z.string().min(1),
  source: z.string().min(1),
  priority: z.number().int().min(1).max(10).default(5),
  status: TaskStatusSchema.default("pending"),
  // DAG 関連
  dagId: z.string().nullable().default(null),
  dependsOn: z.string().nullable().default(null),
  parentTaskId: z.string().nullable().default(null),
  // 結果
  result: z.string().nullable().default(null),
  costUsd: z.number().default(0),
  turnsUsed: z.number().int().default(0),
  qualityScore: z.number().int().nullable().default(null),
  // リトライ
  retryCount: z.number().int().min(0).max(3).default(0),
  // PR 関連
  approvalPrUrl: z.string().nullable().default(null),
  prNumber: z.number().int().nullable().default(null),
  ciFixCount: z.number().int().default(0),
  // タイムスタンプ
  createdAt: z.string(),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
});
```

---

## 10. ユーザー目線の処理フロー

本セクションでは、ユーザー（開発者）がシステムとどのようにインタラクションするかを、具体的なシナリオごとに時系列で説明する。

### 10.1 シナリオ A: GitHub Issue からバグ修正が完了するまで

#### ステップ 1: Issue 作成（ユーザーの操作）

ユーザーは GitHub に Issue を作成する。ラベルを付けるだけで、他に特別な操作は不要。

```markdown
タイトル: ログイン画面でメールアドレスのバリデーションが効いていない
ラベル: bug
本文:
  ## 現象
  空文字や不正な形式のメールアドレスでもログインフォームが送信できてしまう。

  ## 再現手順
  1. /login にアクセス
  2. メール欄に "abc" と入力
  3. 送信ボタンを押す → エラーなく送信される

  ## 期待動作
  不正なメールアドレスの場合、バリデーションエラーが表示される
```

#### ステップ 2: システムが Issue を検知（自動・30秒以内）

ユーザーに見える変化:
- Issue に 👀 リアクションが付く → **「システムがこの Issue を認識しました」** の合図

```
👀 ← GitHubPoller が Issue を検知した証拠
```

裏側の動作:
1. GitHubPoller が Issue を検知
2. Classifier（Haiku）がラベル `bug` → タスクタイプ `fix` と判定
3. 本文を分析し、複雑度を `pipeline`（設計→実装）と判定
4. タスクキューに `[設計] ログイン画面のバリデーション修正` と `[実装] ログイン画面のバリデーション修正` が投入される

#### ステップ 3: 分析・計画フェーズ（自動・約2-5分）

ユーザーに見える変化: **なし**（内部処理のみ）

裏側の動作:
1. Analyzer（Haiku）がコードベースを調査
   - `src/pages/login.tsx`, `src/validators/email.ts` を発見
   - 関連テストファイルの有無を確認
2. Planner（Opus）が実行 DAG を生成
   - `Analyze → Design → Implement → Critic → Validate` の5ノード計画
   - 推定コスト: $2.58、リスク: low

#### ステップ 4: 設計書作成（自動・約5-10分）

ユーザーに見える変化: **なし**（内部処理のみ）

裏側の動作:
1. Designer（Sonnet）が `specs/issue-42/design.md` を作成
2. Validation Gate がスキーマ検証・完全性検証を実施 → 通過

#### ステップ 5: 設計 PR が作成される（自動）

ユーザーに見える変化:
- **GitHub に PR が作成される**
- Issue にコメントが投稿される

```
Issue #42 へのコメント:
📋 設計書PRを作成しました。確認・承認をお願いします。
PR: https://github.com/owner/repo/pull/87
```

PR の内容:
```
タイトル: [設計] ログイン画面のバリデーション修正 (#42)
ブランチ: agent/designer/gh-42-0
変更ファイル: specs/issue-42/design.md (新規作成)
```

PR には `@claude /review` が自動コメントされ、Claude Code による自動レビューも実施される。

#### ステップ 6: ユーザーが設計書をレビュー（ユーザーの操作）

ユーザーは PR 上で `design.md` を読み、以下のいずれかのアクションを取る:

**パターン A: 承認する場合**
```
PR コメント: 承認
```
または GitHub の Review 機能で「Approve」を選択。

**パターン B: フィードバックを返す場合**
```
PR コメント: バリデーションライブラリは zod を使ってください。
また、メールだけでなくパスワードの最小文字数チェックも追加してください。
```

**パターン C: 却下する場合**
```
PR コメント: 却下
```
または PR を Close する。

#### ステップ 7A: フィードバック → 設計書修正（自動・約3-5分）

ユーザーがフィードバックを返した場合:

ユーザーに見える変化:
- **同じ PR に新しいコミットが追加される**（design.md が修正される）
- `@claude /review` が自動実行される

```
PR 上の変化:
  コミット 1: design: ログイン画面のバリデーション修正 (#42)  ← 最初の設計
  コミット 2: design: reflect feedback - zod使用、パスワードチェック追加  ← フィードバック反映
```

ユーザーは修正された design.md を確認し、再度「承認」「フィードバック」「却下」のいずれかを選択する。この**フィードバックループは何度でも繰り返せる**。

#### ステップ 7B: 承認 → 実装開始（自動・約10-30分）

ユーザーが「承認」した後:

ユーザーに見える変化:
- Issue にコメントが投稿される（※将来実装予定）

裏側の動作:
1. Implementer（Sonnet）が design.md に従ってコードを実装
2. テストを作成・実行（全テストが PASS するまで繰り返し）
3. lint、型チェックも通過することを確認
4. Critic（Sonnet）がコードレビュー → 品質スコア 80 以上で合格
   - 不合格の場合は Implementer が修正を繰り返す（最大3回）
5. 同じ PR ブランチにコミット・プッシュ

ユーザーに見える変化:
- **同じ PR に実装コミットが追加される**

```
PR 上の変化:
  コミット 1: design: ログイン画面のバリデーション修正 (#42)
  コミット 2: fix: メールバリデーション実装 (#42)
  コミット 3: test: メール・パスワードバリデーションテスト (#42)
```

- Issue にコメントが投稿される:
```
✅ 実装が完了しました。同じPRに追加コミットしました。CIの結果を監視中です。
PR: https://github.com/owner/repo/pull/87
```

#### ステップ 8: CI チェック（自動）

ユーザーに見える変化:
- PR 上で CI（GitHub Actions）が実行される

**CI 成功の場合:**
```
PR コメント: ✅ CI が全て通過しました。マージの準備ができています。
```
→ ユーザーが PR をマージするだけで完了 🎉

**CI 失敗の場合（自動修正・最大3回）:**
1. CIMonitor が失敗ログを自動取得
2. Analyzer が失敗原因を分析
3. Implementer が修正コミットを追加
4. CI を再実行

ユーザーに見える変化:
```
PR コメント: ⚠️ CI が失敗しました。自動修正を試みています（1/3回目）
  ...
PR コメント: ✅ CI 修正が成功しました。マージの準備ができています。
```

3回修正しても CI が通らない場合:
```
PR コメント: ⚠️ CI 自動修正の上限（3回）に達しました。手動での確認をお願いします。
```

#### ステップ 9: マージ（ユーザーの操作）

ユーザーは PR の内容を最終確認し、GitHub 上でマージボタンを押す。

**以上で完了。** ユーザーが実際に行う操作は:
1. Issue を作成する（ラベルを付ける）
2. 設計書 PR をレビューする（承認 / フィードバック / 却下）
3. 最終 PR をマージする

---

### 10.2 シナリオ B: 不明確な Issue のディスカッション

#### ステップ 1: 曖昧な Issue を作成（ユーザーの操作）

```markdown
タイトル: パフォーマンスを改善してほしい
ラベル: enhancement
本文:
  最近アプリが重い気がする。何とかしてほしい。
```

#### ステップ 2: システムが Issue を検知、不明確と判定（自動・30秒以内）

ユーザーに見える変化:
- Issue に 🤔 リアクションが付く → **「内容を確認中です」** の合図
- **質問コメントが自動投稿される**:

```markdown
🤔 Issue の内容について確認させてください。

以下の点が不明確なため、着手前に認識を合わせたいと思います:

1. **対象画面**: どの画面・どの操作が遅いと感じますか？
   （例: ダッシュボードの初期読み込み、商品一覧のスクロール等）
2. **定量的な目標**: 目標とするレスポンスタイム等はありますか？
   （例: 3秒以内に表示、現在の半分の時間にしたい等）
3. **再現条件**: 特定の条件で遅くなりますか？
   （例: データ件数が多い時、特定のブラウザで等）

ご回答いただければ、設計・実装を開始します。

---
_🤖 この質問は AI Engineering Team が自動生成しました_
```

#### ステップ 3: ユーザーが回答（ユーザーの操作）

```markdown
ユーザーのコメント:
  ダッシュボードの初期読み込みが遅いです。
  今は5秒くらいかかっていて、2秒以内にしたいです。
  データが1000件超えたあたりから顕著に遅くなります。
```

#### ステップ 4: 回答を受けて再分析（自動）

ユーザーに見える変化:
- Issue にコメントが投稿される:

```markdown
✅ ありがとうございます。以下の内容で理解しました:

- **対象**: ダッシュボード初期読み込み
- **現状**: 約5秒
- **目標**: 2秒以内
- **条件**: データ1000件超で顕著

設計を開始します。

---
_🤖 AI Engineering Team_
```

以降はシナリオ A のステップ 3（分析・計画フェーズ）以降と同じフローで進行。

#### 回答が不十分な場合

システムは最大3往復まで追加質問を行う。3往復で解決しない場合:

```markdown
💬 いくつか確認しましたが、詳細な要件の擦り合わせが必要そうです。
Issue の本文に以下を追記いただけると助かります:
- 対象画面のURL/スクリーンショット
- Chrome DevTools の Network タブのスクリーンショット

追記いただければ再度分析を開始します。

---
_🤖 AI Engineering Team_
```

---

### 10.3 シナリオ C: PRレビューコメントへの自動対応

#### 前提: 実装 PR #87 が作成済み、ユーザーがコードレビュー中

#### ステップ 1: レビュアーがコメントを残す（ユーザーの操作）

レビュアーは PR 上で通常通りレビューコメントを残す:

**行コメント（コード指摘）:**
```
src/validators/email.ts L15:
  正規表現が甘すぎます。RFC 5322 に準拠したバリデーションにしてください。
```

**サジェスチョン:**
````markdown
```suggestion
const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
```
````

**一般コメント:**
```
エラーメッセージが英語になっています。日本語にしてください。
```

**質問コメント:**
```
このバリデーション関数を共通化しなかった理由は？
```

#### ステップ 2: システムが自動検知・分類（自動・30秒以内）

ユーザーに見える変化:
- PR にコメントが投稿される:
```
📝 レビューコメントを確認しました。4件の未解決コメントを処理します。
- 修正指示: 2件（行コメント + 一般コメント）
- サジェスチョン適用: 1件
- 質問への回答: 1件

修正を開始します。
```

#### ステップ 3: 自動修正・自動回答（自動・約5-10分）

**サジェスチョン** → 機械的にそのまま適用（AI判断不要）

**コード指摘** → Implementer が修正:
```
src/validators/email.ts の正規表現を RFC 5322 準拠に変更
```

**一般コメント** → Implementer が修正:
```
エラーメッセージを日本語化
```

**質問コメント** → 回答コメントを投稿:
```markdown
📖 設計書 (specs/issue-42/design.md) の「修正方針」に記載の通り、
このバリデーション関数は login ページ固有のビジネスルール
（メール形式 + 社内ドメイン制限）を含むため、共通化せず
ページ固有のバリデーターとして実装しています。

共通メールバリデーションへの切り出しは影響範囲が広いため、
別 Issue での対応を推奨します。

---
_🤖 AI Engineering Team_
```

#### ステップ 4: 修正コミット・プッシュ・レビュー再依頼（自動）

ユーザーに見える変化:
- **PR に修正コミットが追加される**:
```
コミット 4: fix: apply review feedback - RFC5322 regex, Japanese error messages (#42)
```

- **各コメントに返信が付く**:
```
行コメントへの返信: ✅ RFC 5322 準拠の正規表現に修正しました。(abc1234)
サジェスチョンへの返信: ✅ サジェスチョンを適用しました。(abc1234)
一般コメントへの返信: ✅ エラーメッセージを日本語化しました。(abc1234)
```

- **PR にまとめコメントが投稿される**:
```markdown
🔄 レビューコメントへの修正が完了しました。

| コメント | 対応 | 状態 |
|---------|------|------|
| RFC 5322 準拠バリデーション | コード修正 | ✅ |
| サジェスチョン（正規表現） | そのまま適用 | ✅ |
| エラーメッセージ日本語化 | コード修正 | ✅ |
| バリデーション共通化の質問 | 回答コメント | 💬 |

再レビューをお願いします。

---
_🤖 AI Engineering Team_
```

- `@claude /review` が自動実行される

#### ステップ 5: レビュアーが再レビュー（ユーザーの操作）

レビュアーは修正結果を確認し:
- 問題なければ **Approve** → 通常の承認フローへ
- まだ指摘があれば再度コメント → ステップ 1 に戻る（**最大5往復**）

5往復しても解決しない場合:
```
⚠️ レビューコメント対応の上限（5回）に達しました。
残りの指摘事項については手動での修正をお願いします。
```

---

### 10.4 シナリオ D: 大規模機能追加（複数スコープ分割）

#### ステップ 1: Issue 作成（ユーザーの操作）

```markdown
タイトル: ダッシュボードに分析グラフとエクスポート機能を追加
ラベル: feature
本文:
  ## 要件
  1. ダッシュボード画面に月次売上グラフを追加
  2. グラフデータを CSV/PDF でエクスポートする機能を追加
  3. エクスポート履歴を表示するテーブルを追加

  ## 参考デザイン
  Figma: (URL)
```

#### ステップ 2: スコープ分割（自動・約1-3分）

裏側の動作:
1. Classifier（Haiku）が `feature` ラベル → タスクタイプ `build` と判定
2. Sonnet がスコープ分析 → 3つの独立スコープに分割:
   - Scope 1: 月次売上グラフ
   - Scope 2: CSV/PDF エクスポート
   - Scope 3: エクスポート履歴テーブル

ユーザーに見える変化:
- Issue に 👀 リアクション
- Issue にコメント（※将来実装予定）:
```
📋 この Issue を3つのスコープに分割しました:
1. [設計] 月次売上グラフ → [実装] 月次売上グラフ
2. [設計] CSV/PDFエクスポート → [実装] CSV/PDFエクスポート
3. [設計] エクスポート履歴テーブル → [実装] エクスポート履歴テーブル

各スコープの設計PRが順次作成されます。
```

#### ステップ 3: 設計 PR が複数作成される（自動）

各スコープについて独立した設計 PR が作成される（並列実行可能な場合は同時進行）:

```
PR #88: [設計] 月次売上グラフ (#45)
PR #89: [設計] CSV/PDFエクスポート (#45)
PR #90: [設計] エクスポート履歴テーブル (#45)
```

#### ステップ 4: ユーザーが各 PR を個別にレビュー（ユーザーの操作）

ユーザーは各 PR を独立にレビューできる。**承認の順序は自由**。

```
PR #88: 承認 → 実装開始
PR #89: フィードバック → 修正 → 承認 → 実装開始
PR #90: 承認 → 実装開始
```

各スコープの実装は独立して進行するため、PR #88 の実装完了を待たずに PR #90 の実装も開始される。

#### ステップ 5: 各 PR に実装が追加され、CI → マージ

シナリオ A のステップ 7B〜9 が各 PR について個別に実行される。ユーザーは各 PR を個別にマージする。

---

### 10.5 シナリオ E: 設計書を却下して方針転換

#### ステップ 1-5: シナリオ A と同じ

設計 PR が作成され、ユーザーがレビューする。

#### ステップ 6: 却下（ユーザーの操作）

ユーザーが設計の方向性が根本的に違うと判断した場合:

```
PR コメント: 却下。このアプローチではなく、サーバーサイドバリデーションで対応してください。
```
または PR を Close する。

ユーザーに見える変化:
- PR がクローズされる
- 後続の実装タスクもキャンセルされる
- Issue にコメント:
```
❌ 設計が却下されました。パイプラインをキャンセルしました。
```

#### ステップ 7: 新しい方針で再挑戦（ユーザーの操作）

ユーザーは Issue の本文を修正して方針を明確化するか、新しい Issue を作成する。システムが再度 Issue を検知し、新しいパイプラインが開始される。

---

### 10.6 シナリオ F: CI 失敗の自動修正

#### 前提: 実装 PR が作成済み、CI が実行中

#### 自動修正フロー（ユーザー操作不要）

```
時刻    イベント                                   ユーザーに見える変化
─────  ──────────────────────────────────         ─────────────────────
14:00  CI 実行開始                                  PR に CI チェックが表示される
14:03  CI 失敗（テスト2件失敗）                      PR に ❌ マークが付く
14:03  CIMonitor が失敗を検知                       PR コメント:
                                                    「⚠️ CI が失敗しました。自動修正を試みています（1/3回目）
                                                     失敗: test/auth.test.ts - 2件」
14:05  Analyzer が失敗ログを分析                     (内部処理)
14:10  Implementer が修正コミットをプッシュ            PR に新しいコミットが追加される
14:10  CI 再実行開始                                 PR に CI チェックが再表示される
14:13  CI 成功                                       PR に ✅ マークが付く
                                                    PR コメント: 「✅ CI が全て通過しました」
```

3回失敗した場合:
```
14:30  PR コメント:
       「⚠️ CI 自動修正の上限（3回）に達しました。手動での確認をお願いします。
        最後の失敗: test/integration/export.test.ts
        エラー: TypeError: Cannot read property 'data' of undefined」
```

→ ユーザーが手動で修正するか、新しい Issue として再投入する。

---

### 10.7 シナリオ G: 定時タスク（Cron）

ユーザーの操作は完全に不要。システムが自動的に実行する。

#### 夜間コードレビュー（毎日 03:00）

```
時刻    イベント                                   ユーザーに見える変化
─────  ──────────────────────────────────         ─────────────────────
03:00  CronScheduler がレビュータスクを生成          (なし)
03:01  Analyzer がコードベースを分析                 (なし)
03:05  Designer が品質レポートを作成                 (なし)
03:10  レポート PR が作成される                      PR が作成される:
                                                    「[レビュー] 夜間コードレビュー 03/23」
       Slack 通知                                   Slack に通知:
                                                    「✅ 夜間レビュー完了: 3件の改善提案」
```

ユーザーは朝出勤したら Slack 通知を確認し、PR を見るだけ。

#### 週次ドキュメント同期（毎週月曜 09:00）

```
09:00  CronScheduler がドキュメントタスクを生成
09:01  Scribe が変更履歴を分析、ドキュメントを更新
09:05  PR が作成される:「[ドキュメント] 週次ドキュメント同期 03/24」
```

---

### 10.8 シナリオ H: AIが自律的にスキルを生成する

#### 前提: 「E2Eテストを実行してください」という Issue が投入されたが、ブラウザ自動化ツールが存在しない

#### ステップ 1: 能力ギャップの検出（自動）

Planner が DAG 生成時に「E2E テスト実行にはブラウザ自動化ツールが必要だが、現在のツールセットにない」と判断。

裏側の動作:
1. Planner が `toolGapReport` を出力:
   ```json
   {
     "gapType": "missing_tool",
     "description": "Playwright ベースの E2E テスト実行ツールが必要",
     "requiredCapability": "ブラウザ起動、ページ遷移、DOM検証、スクリーンショット取得",
     "suggestedName": "run-playwright-test"
   }
   ```
2. Gap Detector が Skill Registry を検索 → 類似ツールなし → 新規生成フロー開始

#### ステップ 2: ToolForge がスキルを生成（自動・約5-10分）

ユーザーに見える変化:
- Issue にコメントが投稿される:
```markdown
🔧 このタスクの実行に必要なツール（E2Eテスト実行）が見つかりませんでした。
新しいスキルを自動生成しています...
```

裏側の動作:
1. Tool Synthesizer（Sonnet）が以下を生成:
   - `handler.ts` — Playwright テスト実行の実装
   - `schema.ts` — Zod 入出力スキーマ
   - `tests.ts` — 5件のユニットテスト
   - `SKILL.md` — ツール説明書
2. Sandbox Validator が検証:
   - 静的解析 → PASS
   - 型チェック → PASS
   - ユニットテスト → 5/5 PASS
   - セキュリティスキャン → `write_local`（ファイル書き込みあり）

#### ステップ 3: スキル PR が作成される（自動）

ユーザーに見える変化:
- **新しい PR が作成される:**

```
PR #92: [ToolForge] 新スキル: run-playwright-test
ブランチ: toolforge/run-playwright-test-v1
変更ファイル:
  + skills/tools/run-playwright-test/SKILL.md
  + skills/tools/run-playwright-test/handler.ts
  + skills/tools/run-playwright-test/schema.ts
  + skills/tools/run-playwright-test/tests.ts
  + skills/tools/run-playwright-test/metadata.json
```

- Issue にコメント:
```markdown
🔧 新しいスキル「run-playwright-test」を生成しました。

| 項目 | 内容 |
|------|------|
| 名前 | run-playwright-test |
| 用途 | Playwright ベースの E2E テスト実行 |
| 安全レベル | write_local（ファイル書き込みあり） |
| テスト結果 | 5/5 PASS |

PR #92 で内容を確認できます。承認後、このタスクの処理を再開します。
```

#### ステップ 4: ユーザーがスキル PR をレビュー（ユーザーの操作）

ユーザーはスキルのコード（`handler.ts`）と説明書（`SKILL.md`）を確認する:
- **Approve** → スキルが Skill Registry に登録され、元のタスクが再開される
- **フィードバック** → ToolForge がコードを修正して再提出
- **Reject** → スキル生成失敗、Issue にコメント: 「手動でのツール準備をお願いします」

#### ステップ 5: スキル登録後、元タスクが再開（自動）

スキルが承認されると:
1. Skill Registry に `approved` として登録
2. 元の Issue のタスクが `pending` → `planning` に戻る
3. Planner が新しいスキルを含めた DAG を再生成
4. 以降は通常フローで実行

ユーザーに見える変化:
```markdown
✅ スキル「run-playwright-test」が登録されました。タスクの処理を再開します。
```

#### 補足: read_only スキルは自動承認

ファイル読み取りやデータ変換のみのスキル（`safety_level: read_only`）は、テスト通過で自動承認されるため、**ユーザーの操作なしでスキルが登録・使用される**。

```
時刻    イベント                                     ユーザーの操作
─────  ───────────────────────────────────         ──────────────
10:00  CSV パースタスクで繰り返し失敗を検出            なし
10:01  ToolForge が parse-csv スキルを生成            なし
10:02  テスト 5/5 PASS、safety_level: read_only      なし
10:02  自動承認、Skill Registry に登録                なし
10:03  元タスクが新スキルを使って再実行               なし
10:10  タスク完了                                     Issue にコメント通知
```

---

### 10.9 シナリオ I: 手動 CLI でのタスク投入

GitHub Issue を使わず、コマンドラインから直接タスクを投入することも可能。

```bash
# バグ修正タスクを投入
$ npm run task:add -- \
  --type fix \
  --title "APIレスポンスのキャッシュが効いていない" \
  --description "GET /api/products のレスポンスに Cache-Control ヘッダーが設定されていない。max-age=3600 を設定する。" \
  --priority 8

タスクを登録しました:
  ID: manual-20260323-001
  タイプ: fix
  タイトル: APIレスポンスのキャッシュが効いていない
  優先度: 8 (高)
  ステータス: pending

処理が開始されると Slack に通知されます。
```

以降はシナリオ A のステップ 3 以降と同じフローで処理される（設計 PR → レビュー → 実装 → CI → マージ）。

---

### 10.10 ユーザーの操作まとめ

#### ユーザーが行う操作（全シナリオ共通）

| # | 操作 | 所要時間 | 頻度 |
|---|------|---------|------|
| 1 | **Issue を作成する**（タイトル + 本文 + ラベル） | 5-10分 | タスクごとに1回 |
| 2 | **設計 PR をレビューする**（design.md を読む） | 5-15分 | タスクごとに1回 |
| 3 | **承認 / フィードバック / 却下** を判断する | 1分 | レビューごとに1回 |
| 4 | **最終 PR をマージする** | 1分 | タスクごとに1回 |

#### ユーザーが行わなくてよい操作

| 操作 | 担当 |
|------|------|
| コードベースの調査・分析 | Analyzer（自動） |
| 実行計画の策定 | Planner（自動） |
| 設計書の作成 | Designer（自動） |
| コーディング | Implementer（自動） |
| テストの作成・実行 | Implementer（自動） |
| コードレビュー（自動レビュー） | Critic（自動） |
| CI 失敗時の修正 | CIMonitor + Implementer（自動、最大3回） |
| ドキュメントの更新 | Scribe（自動） |
| Slack への通知 | SlackNotifier（自動） |
| **PRレビューコメントへの修正対応** | **Implementer（自動、最大5往復）** |
| **PRコンフリクト解消** | **Implementer（自動、可能な場合）** |
| **進捗報告** | **Orchestrator（自動）** |
| **不明確な Issue への質問** | **Classifier（自動、最大3往復）** |
| **関連 Issue の検出・紐づけ** | **Classifier（自動）** |
| **Stale PR のリマインド** | **Orchestrator（自動）** |
| **不足スキルの自動生成** | **ToolForge（自動、`read_only` は承認不要）** |
| **スキルの進化・改良** | **ToolForge（自動、成功率低下時）** |

#### 通知チャネルと確認ポイント

ユーザーは以下のタイミングでシステムからの通知を受け取る:

| タイミング | 通知先 | 内容 |
|-----------|--------|------|
| Issue 検知時 | GitHub（👀 リアクション） | 「Issue を認識しました」 |
| **Issue 不明確時** | **GitHub（🤔 リアクション + 質問コメント）** | **「確認させてください」** |
| **Issue 回答受領時** | **GitHub（Issue コメント）** | **「理解しました。設計を開始します」** |
| 設計 PR 作成時 | GitHub（Issue コメント + PR） | 「設計書を確認してください」 |
| フィードバック反映時 | GitHub（PR コミット） | 「フィードバックを反映しました」 |
| 実装完了時 | GitHub（Issue コメント + PR コミット） | 「実装が完了しました」 |
| **レビューコメント検知時** | **GitHub（PR コメント）** | **「修正を開始します」** |
| **レビューコメント修正完了時** | **GitHub（PR コメント + 各コメント返信）** | **「修正完了。再レビューをお願いします」** |
| CI 成功時 | GitHub（PR コメント） | 「マージの準備ができています」 |
| CI 自動修正時 | GitHub（PR コメント） | 「CI 失敗を自動修正しています」 |
| CI 自動修正失敗時 | GitHub（PR コメント）+ Slack | 「手動での確認をお願いします」 |
| **コンフリクト解消成功時** | **GitHub（PR コメント）** | **「コンフリクトを自動解消しました」** |
| **コンフリクト解消失敗時** | **GitHub（PR コメント）** | **「手動での解消をお願いします」** |
| **進捗報告** | **GitHub（Issue コメント）** | **「進捗: 3/5 ノード完了」** |
| **関連 Issue 検出時** | **GitHub（Issue コメント）** | **「関連する Issue を検出しました」** |
| タスク完了時 | Slack | 「タスクが完了しました」 |
| タスク失敗時 | Slack + GitHub（Issue コメント） | 「タスクが失敗しました」 |
| Circuit Breaker 発動時 | Slack | 「連続失敗により一時停止中です」 |
| **Stale PR リマインド** | **GitHub（PR コメント）+ Slack** | **「レビュー待ちの PR があります」** |
| **スキル生成開始時** | **GitHub（Issue コメント）** | **「必要なツールを自動生成しています」** |
| **スキル PR 作成時** | **GitHub（Issue コメント + PR）** | **「スキルを確認してください」** |
| **スキル自動承認時（read_only）** | **GitHub（Issue コメント）** | **「スキルを登録し、タスクを再開しました」** |
| 夜間レビュー完了時 | Slack + GitHub（PR） | 「レビュー結果を確認してください」 |

---

### 10.11 タイムライン例: Issue 作成からマージまで

以下は典型的な中規模バグ修正の時間経過:

```
時刻     処理                              ユーザーの操作          所要時間
──────  ─────────────────────────────     ──────────────────     ─────────
10:00   ユーザーが Issue #42 を作成        Issue 作成 (5分)        -
10:00   👀 リアクション追加                                       即座
10:01   Classifier 分類完了                                      ~30秒
10:01   Analyzer コードベース分析開始                              -
10:03   Analyzer 完了                                            ~2分
10:03   Planner DAG 生成開始                                     -
10:05   Planner 完了 (5ノードDAG)                                ~2分
10:05   Designer 設計書作成開始                                   -
10:12   Designer 完了                                            ~7分
10:12   Validation Gate 通過                                     ~30秒
10:13   設計 PR #87 作成                                         即座
        ─── ここでユーザーの出番 ───
10:30   ユーザーが PR をレビュー           設計書レビュー (15分)    -
10:45   ユーザーが「承認」コメント         承認 (1分)              -
        ─── ここから再び自動 ───
10:45   Implementer 実装開始                                     -
11:05   Implementer 完了                                         ~20分
11:05   Critic レビュー開始                                      -
11:10   Critic 完了 (品質スコア: 85/100)                          ~5分
11:10   Validation Gate 通過                                     ~30秒
11:11   実装コミットを PR #87 に push                             即座
11:11   CI 実行開始                                              -
11:15   CI 全チェック通過                                         ~4分
11:15   PR コメント「✅ マージの準備完了」                          即座
        ─── ユーザーの最終操作 ───
11:20   ユーザーが PR をマージ             マージ (1分)            -
```

**合計所要時間:** 約1時間20分（実質のユーザー操作時間: 約20分）

**コスト内訳:**
```
Classifier (Haiku)    : $0.01
Analyzer (Haiku)      : $0.05
Planner (Opus)        : $0.80
Designer (Sonnet)     : $0.50
Validation Gate ×2    : $0.04
Implementer (Sonnet)  : $1.20
Critic (Sonnet)       : $0.30
──────────────────────────────
合計                  : $2.90
```

---

## 11. GitHub 連携

### 11.1 Issue → タスク変換フロー

```
GitHub Issue (open, ラベル付き)
    │
    ▼
GitHubPoller.pollIssues()
    │ 👀 eyes リアクション追加
    ▼
Classifier (Haiku)
    │ ラベル判定 + 複雑度分析
    │ 必要に応じて Sonnet でスコープ分析
    ▼
TaskQueue.pushPipeline()
    │ 単一 or 複数パイプライン投入
    ▼
Orchestrator.tick()
    │ 優先度順にデキュー
    ▼
Planning Layer (L2)
    │ Analyzer → Planner → DAG 生成
    ▼
Execution Layer (L3)
    │ DAG 実行
    ▼
ResultCollector
    │ PR 作成 + @claude /review
    ▼
GitHub Issue コメント
    └── 🚀 rocket リアクション (成功時)
    └── 😕 confused リアクション (失敗時)
```

### 11.2 設計 PR 承認フロー

```
設計PR 作成
    │
    ▼
人間がレビュー
    │
    ├── "承認" コメント or GitHub Approve
    │   → awaiting_approval → implementing
    │   → 実装DAG を実行
    │
    ├── フィードバックコメント
    │   → Designer がフィードバックを反映して design.md を修正
    │   → 同じPRに push
    │   → @claude /review で再レビュー
    │
    └── "却下" コメント or PR close
        → rejected
        → パイプラインの後続タスクもキャンセル
```

### 11.3 CI 連携

```
PR push 後
    │
    ▼
CIMonitor.checkPendingPRs()
    │ GitHub Actions の check run を監視
    │
    ├── 全チェック成功 → ci_passed → completed
    │
    └── チェック失敗 (ciFixCount < 3)
        │ 失敗ログを取得
        ▼
        CI修正DAG を生成・実行
        │ Analyzer(失敗分析) → Implementer(修正)
        │ 同じブランチに push
        ▼
        ci_checking に戻る（再チェック待ち）
```

---

## 12. 自律的動作パターン

本システムの中核的な価値は**人間の介入を最小化しつつ、必要な場面では適切にコミュニケーションを取る**ことにある。本セクションでは、システムが自律的に判断・行動するパターンを体系的に定義する。

### 12.0 共通定義

#### Bot コメントフッターテンプレート

全ての自動生成コメントには以下の統一フッターを付与する:

```
---
_🤖 {action_description} | AI Engineering Team_
```

`{action_description}` の例: `自動質問`, `レビュー修正完了`, `進捗報告`, `Dry Run プレビュー`, `自動トリアージ`, `スキル生成`

#### 承認・却下キーワード定義

PR コメントおよび Issue コメントで以下のキーワードを検出する。全パターンで共通の定義を使用する。

| カテゴリ | キーワード（大小区別なし） | 動作 |
|---------|------------------------|------|
| **承認** | `承認`, `LGTM`, `approve`, `approved`, `実行` | 承認フローへ |
| **却下** | `却下`, `reject`, `NACK`, `却下します` | 却下フローへ |
| **キャンセル** | `キャンセル`, `cancel`, `中止` | タスク中止 |

上記以外のコメントは**フィードバック**（修正指示 or 質問）として扱う。Bot コメント（GitHub ユーザータイプ `Bot` または既知の Bot ユーザー名: `vercel[bot]`, `github-actions[bot]`, `dependabot[bot]`）は全て無視する。

#### リアクション絵文字の体系

| 状態 | 絵文字 | 意味 |
|------|--------|------|
| Issue 検知 | 👀 | 「認識しました」 |
| 不明確 Issue（質問投稿） | 🤔 | 「確認中です」 |
| 作業開始 | 🚀 | 「処理を開始しました」 |
| 完了 | ✅ | 「完了しました」 |
| 失敗 | 😕 | 「問題が発生しました」 |

---

### 12.1 Issue ディスカッション（Clarification Loop）

#### 概要

Issue の内容が不明確・情報不足の場合、**Classifier が自動的に質問コメントを投稿し、ユーザーとの認識合わせを行う**。回答が得られるまでタスクは `clarifying` 状態で保留される。

#### 判定基準

Classifier（Haiku）が Issue を分析し、以下のいずれかに該当する場合に `unclear` と判定する:

| # | 不明確の種類 | 判定条件 | 質問例 |
|---|-------------|---------|--------|
| 1 | **再現手順の欠如** | bug ラベルだが再現手順がない | 「再現手順を教えてください。どのページでどの操作をすると問題が発生しますか？」 |
| 2 | **期待動作の欠如** | 現状の動作は書かれているが期待結果がない | 「期待する動作はどのようなものですか？」 |
| 3 | **スコープの曖昧さ** | 複数の解釈が可能な記述 | 「"パフォーマンスを改善" とのことですが、具体的にはどの画面のどの操作が対象ですか？目標値はありますか？」 |
| 4 | **技術的な判断が必要** | 複数のアプローチが考えられ、ユーザーの意向が不明 | 「この修正には2つのアプローチがあります:\n A) クライアント側バリデーション\n B) サーバー側バリデーション\nどちらが望ましいですか？」 |
| 5 | **依存関係の不明** | 他の Issue や外部サービスとの関係が不明確 | 「この機能は #38 の認証機能に依存しますか？先に #38 を完了させる必要がありますか？」 |
| 6 | **受け入れ基準の欠如** | feature ラベルだが完了条件が不明確 | 「この機能の受け入れ基準を教えてください。どうなれば完了と判断しますか？」 |

#### フロー

```
Issue 検知
    │
    ▼
Classifier (Haiku) が分析
    │
    ├── 明確 → pipeline → 通常フロー
    │
    └── unclear → 質問生成
            │
            ▼
        Issue に 🤔 リアクション追加
            │
            ▼
        質問コメントを投稿
            │
            ▼
        タスクを clarifying 状態で作成
            │
            ▼
        GitHubPoller が回答を監視（30秒ごと）
            │
            ├── ユーザーが回答コメント
            │   │
            │   ▼
            │   回答を Issue 本文 + 全コメントとして再分析
            │   │
            │   ├── 十分な情報 → pending → 通常フロー
            │   │
            │   └── まだ不明確 → 追加質問コメント（最大3往復）
            │
            └── 3往復しても解決しない場合
                → Issue コメント: 「直接ディスカッションをお願いします」
                → タスクを failed に遷移
```

#### 質問コメントのフォーマット

```markdown
🤔 Issue の内容について確認させてください。

以下の点が不明確なため、着手前に認識を合わせたいと思います:

1. **再現手順**: どのページでどの操作を行うと問題が発生しますか？
2. **期待動作**: 正しくはどのように動作すべきですか？

ご回答いただければ、設計・実装を開始します。

---
_🤖 この質問は AI Engineering Team が自動生成しました_
```

#### 回答検出ロジック

- Issue 作成者のコメントのみを回答として認識（第三者のコメントは無視）
- Bot コメント（自分自身を含む）は無視
- 引用ブロック (`>`) 内の質問テキストは無視し、引用外のテキストを回答として抽出

#### 制限

| 項目 | 値 | 根拠 |
|------|-----|------|
| 最大質問往復数 | 3回 | 3回で解決しない場合は人間同士の会話が必要 |
| 質問生成モデル | Haiku | 低コスト、質問生成には十分 |
| 質問コスト | ~$0.02/回 | Haiku の入出力合計 |
| 回答待ちタイムアウト | 7日 | 7日間回答がない場合は failed に遷移 |

---

### 12.2 PR レビューコメント自動対応（Review Comment Responder）

#### 概要

実装 PR に対して人間がレビューコメント（行コメント、サジェスチョン、一般コメント）を残した場合、**システムが自動的にコードを修正し、コミット・プッシュし、レビュー再依頼を行う**。

#### 対象となるコメントの種類

| コメント種別 | GitHub API | 検出方法 | 対応動作 |
|-------------|-----------|---------|---------|
| **行コメント** (Inline comment) | Pull Request Review Comment | `GET /repos/{owner}/{repo}/pulls/{pr}/comments` | 指摘箇所を特定して修正 |
| **サジェスチョン** (Suggested change) | Review Comment with `suggestion` body | コメント本文の ` ```suggestion ` ブロック検出 | サジェスチョンをそのまま適用 |
| **一般コメント** (General comment) | Issue Comment on PR | `GET /repos/{owner}/{repo}/issues/{pr}/comments` | 内容を解析して修正方針を決定 |
| **リクエストチェンジ** (Request changes) | Pull Request Review with `CHANGES_REQUESTED` | Review state 検出 | 全指摘事項を一括修正 |

#### フロー

```
PR にレビューコメントが投稿される
    │
    ▼
GitHubPoller.pollReviewComments()  ← 30秒ごとに監視
    │
    ▼
コメント分類 (Haiku)
    │
    ├── 承認系 ("LGTM", "Approve", "承認") → 無視（承認フローへ）
    ├── 却下系 ("却下", "NACK") → 無視（却下フローへ）
    ├── 質問系 ("これは何？", "なぜ？") → 回答コメントを投稿
    └── 修正指示系 → 修正フローへ
            │
            ▼
        PR にコメント: 「📝 レビューコメントを確認しました。修正を開始します。」
            │
            ▼
        全未解決コメントを収集
            │
            ▼
        Implementer Agent を起動
        ├── プロンプトにレビューコメント一覧を注入
        ├── 指摘箇所のファイル・行番号を特定
        ├── サジェスチョンはそのまま適用
        └── 一般コメントは AI が修正方針を判断
            │
            ▼
        修正コミット + プッシュ
            │
            ▼
        各コメントに返信: 「✅ 修正しました。(コミット: abc1234)」
            │
            ▼
        @claude /review を実行（自動レビュー）
            │
            ▼
        PR コメント: 「🔄 レビューコメントへの修正が完了しました。再レビューをお願いします。」
```

#### サジェスチョン自動適用

GitHub のサジェスチョン（` ```suggestion ` ブロック）は特別扱いする:

````markdown
```suggestion
const isValid = email.includes('@') && email.includes('.');
```
````

→ コードの該当行をサジェスチョン内容にそのまま置き換える。AI の判断を介さず**機械的に適用**する。

#### 質問コメントへの自動回答

「なぜこの実装にしたのか」「この変数の意味は」などの質問コメントには、コードを修正せず**説明コメントで返信**する:

```markdown
レビュアーのコメント:
> なぜ zod ではなく手動バリデーションにしたのですか？

システムの返信:
📖 設計書 (specs/issue-42/design.md) の「修正方針」セクションに記載の通り、
既存のバリデーション関数との整合性を優先しました。
zod への移行は影響範囲が大きいため、別 Issue での対応を推奨します。

---
_🤖 この回答は AI Engineering Team が自動生成しました_
```

#### 制限と安全策

| 項目 | 値 | 根拠 |
|------|-----|------|
| 1PR あたりの自動修正回数 | 最大5回 | 無限ループ防止 |
| 修正1回あたりの diff 上限 | 200行 | 大規模な修正は人間の判断が必要 |
| コメント処理モデル | Haiku（分類） + Sonnet（修正） | 分類は安く、修正は正確に |
| 処理済みコメントの追跡 | コメント ID をDB記録 | 同じコメントを2回処理しない |
| Bot コメントの無視 | GitHub ユーザータイプで判定 | 自分自身のコメントに反応しない |

---

### 12.3 自律的な進捗報告（Proactive Status Updates）

#### 概要

長時間かかるタスクの途中経過を、**ユーザーが問い合わせなくても自動的に報告**する。

#### 報告トリガー

| タイミング | 報告先 | 内容例 |
|-----------|--------|--------|
| DAG 実行開始時 | Issue コメント | 「🚀 作業を開始しました。推定所要時間: 約25分」 |
| DAG ノード完了ごと | Issue コメント（長時間タスクのみ） | 「⏳ 進捗: 3/5 ノード完了（設計完了、実装中...）」 |
| 想定時間超過時 | Issue コメント + Slack | 「⚠️ 想定時間（25分）を超過しています。現在も処理中です。」 |
| 実装完了・PR更新時 | Issue コメント | 「✅ 実装が完了しました。PR: #87」 |
| 処理失敗時 | Issue コメント + Slack | 「❌ 処理が失敗しました。詳細: ...」 |

#### 進捗コメントのフォーマット

```markdown
⏳ **進捗報告** (Issue #42)

| ステップ | 状態 | 所要時間 | コスト |
|---------|------|---------|--------|
| 分析 | ✅ 完了 | 2分 | $0.05 |
| 計画 | ✅ 完了 | 3分 | $0.80 |
| 設計 | ✅ 完了 | 7分 | $0.50 |
| 実装 | 🔄 実行中 | - | - |
| レビュー | ⏳ 待機中 | - | - |

推定残り時間: 約15分

---
_🤖 自動進捗報告 | AI Engineering Team_
```

#### 報告頻度の制御

- **短時間タスク（推定 < 15分）**: 開始時と完了時のみ
- **中時間タスク（推定 15-60分）**: 開始時 + ノード完了ごと + 完了時
- **長時間タスク（推定 > 60分）**: 上記 + 15分ごとのハートビート

---

### 12.4 マージコンフリクト自動解消

#### 概要

PR のブランチが main と競合した場合、**自動的にリベースまたはマージを試み**、解消できた場合はプッシュする。

#### フロー

```
GitHubPoller がマージ可能性を監視
    │
    ├── mergeable: true → 何もしない
    │
    └── mergeable: false (conflict)
            │
            ▼
        Analyzer (Haiku) がコンフリクト内容を分析
            │
            ├── 自動解消可能（異なるファイルの変更等）
            │   │
            │   ▼
            │   git merge main → コンフリクト解消 → push
            │   │
            │   ▼
            │   PR コメント: 「🔀 main とのコンフリクトを自動解消しました。」
            │
            └── 自動解消不可能（同一箇所の変更）
                │
                ▼
                PR コメント:
                「⚠️ main とのコンフリクトが検出されました。
                 同一ファイルの同一箇所に変更があるため、自動解消できません。
                 手動での解消をお願いします。

                 競合ファイル:
                 - src/validators/email.ts (L15-L23)
                 - src/pages/login.tsx (L42-L50)」
```

#### 安全策

- コンフリクト解消後は必ず `npm test` を実行し、テストが通ることを確認
- テスト失敗の場合はコンフリクト解消をリバートし、人間にエスカレート
- `package-lock.json` のみのコンフリクトは `npm install` で自動解消

---

### 12.5 関連 Issue の自動検出と紐づけ

#### 概要

新しい Issue が作成された際、**既存の Issue との類似性を分析**し、関連する可能性がある Issue を自動コメントする。

#### 判定基準

Classifier（Haiku）が以下の観点で類似性を判定:

1. **タイトルのキーワード一致** — 同じモジュール名、画面名、機能名を含む
2. **変更対象ファイルの重複** — Analyzer の調査結果で同一ファイルに触れる
3. **依存関係** — 一方の Issue が他方に依存する可能性がある

#### コメントフォーマット

```markdown
🔗 **関連する可能性がある Issue を検出しました**

| Issue | 類似度 | 関連理由 |
|-------|--------|---------|
| #38 認証モジュールのリファクタリング | 高 | 同じ `src/auth/` を変更対象としています |
| #41 ログインページのUIリニューアル | 中 | 同じ `src/pages/login.tsx` に関連します |

⚠️ #38 が未完了の場合、先にマージしないとコンフリクトする可能性があります。

---
_🤖 自動関連 Issue 検出 | AI Engineering Team_
```

---

### 12.6 Stale PR 検出とリマインド

#### 概要

レビュー待ちのまま一定期間放置された PR を検出し、**リマインドコメントを投稿**する。

#### ルール

| 経過時間 | 動作 |
|---------|------|
| 24時間 | PR コメント: 「👋 この PR はレビュー待ちの状態です。ご確認をお願いします。」 |
| 72時間 | PR コメント + Slack 通知: 「⏰ この PR は3日間レビューされていません。」 |
| 7日 | Slack 通知のみ: 「📋 PR #87 が1週間放置されています。クローズしますか？」 |

---

### 12.7 ToolForge — 自律的スキル・ツール生成

#### 概要

エージェントがタスク実行中に**自身の能力の限界**を検知した場合、**新しいツール（スキル）を自律的に設計・実装・テスト・登録**する。登録されたツールは以後の全エージェントセッションで利用可能になる。

これは LATM（LLM as Tool Maker）パターンと Voyager のスキルライブラリパターンを組み合わせた設計であり、Claude Agent SDK の MCP カスタムツール機能（`createSdkMcpServer`）を活用する。

#### アーキテクチャ

```
┌─────────────────────────────────────────────────────────────────┐
│                       ToolForge System                          │
│                                                                 │
│  ┌────────────┐    ┌──────────────┐    ┌───────────────────┐   │
│  │ Gap        │───→│ Tool         │───→│ Sandbox           │   │
│  │ Detector   │    │ Synthesizer  │    │ Validator         │   │
│  │            │    │ (Sonnet)     │    │ (isolated exec)   │   │
│  └────────────┘    └──────────────┘    └────────┬──────────┘   │
│        ↑                                        │              │
│        │ failure/gap report                     │ tests pass   │
│        │                                        ▼              │
│  ┌─────┴──────┐                         ┌──────────────────┐   │
│  │ Execution  │                         │ Skill Registry   │   │
│  │ Layer (L3) │←── new tool available ──│ (SQLite + FS)    │   │
│  └────────────┘                         └──────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

#### ツール生成のトリガー（Gap Detection）

| # | トリガー | 検出方法 | 例 |
|---|---------|---------|-----|
| 1 | **タスク失敗の反復** | 同じカテゴリのタスクが3回以上失敗 | 「画像リサイズのタスクが繰り返し失敗」→ 画像処理ツールを生成 |
| 2 | **エージェントの明示的報告** | 構造化出力に `toolGapReport` フィールド | 「データベースマイグレーションを実行するツールがない」 |
| 3 | **Planner の判断** | DAG 生成時に適切なツールが存在しないと判断 | 「E2Eテスト実行にはブラウザ自動化ツールが必要」 |
| 4 | **パターン分析** | Pattern Memory が繰り返しのボイラープレートを検出 | 「毎回同じ API 呼び出しパターンを手動で書いている」 |

#### ツール生成フロー

```
Gap 検出
    │
    ▼
Gap Detector が既存スキルライブラリを検索
    │
    ├── 類似ツールあり → 既存ツールの拡張を検討
    │
    └── 類似ツールなし → 新規生成フロー
            │
            ▼
        Tool Synthesizer (Sonnet) が以下を生成:
        ├── handler.ts    — ツール実装（TypeScript 関数）
        ├── schema.ts     — Zod 入出力スキーマ
        ├── tests.ts      — ユニットテスト（最低5ケース）
        └── SKILL.md      — ツール説明書（用途、制約、使用例）
            │
            ▼
        Sandbox Validator が検証:
        ├── 1. 静的解析（禁止パターンチェック）
        ├── 2. 型チェック（tsc --noEmit）
        ├── 3. ユニットテスト実行（全 PASS 必須）
        └── 4. セキュリティスキャン（FS/Net アクセスチェック）
            │
            ├── 全検証通過 → Skill Registry に登録
            │   │
            │   ▼
            │   PR を作成: 「[ToolForge] 新スキル: {tool_name}」
            │   → 人間がレビュー・承認後に main にマージ
            │
            └── 検証失敗 → Tool Synthesizer が修正を試みる（最大3回）
                │
                └── 3回失敗 → Gap Report をログに記録、人間にエスカレート
```

#### スキルライブラリ構成

```
skills/
├── registry.json                    # スキルインデックス
├── tools/
│   ├── parse-csv/
│   │   ├── SKILL.md                 # 説明書
│   │   ├── handler.ts               # 実装
│   │   ├── schema.ts                # Zod スキーマ
│   │   ├── tests.ts                 # テスト
│   │   └── metadata.json            # メタデータ
│   ├── run-playwright-test/
│   │   ├── SKILL.md
│   │   ├── handler.ts
│   │   ├── schema.ts
│   │   ├── tests.ts
│   │   └── metadata.json
│   └── generate-db-migration/
│       └── ...
```

#### SKILL.md フォーマット

```markdown
---
name: parse-csv
description: CSV ファイルを読み込み、構造化データとして返す
version: 1
created_by: toolforge
created_at: 2026-03-23T10:30:00Z
tags: [data, csv, parsing]
safety_level: read_only
---

# parse-csv

## 用途
CSV/TSV ファイルをパースし、ヘッダー付きの JSON 配列として返す。
大規模ファイル（100MB 超）はストリーミング処理で対応。

## 入力
| パラメータ | 型 | 必須 | 説明 |
|-----------|-----|------|------|
| filePath | string | Yes | CSV ファイルのパス |
| delimiter | string | No | 区切り文字（デフォルト: ","） |
| hasHeader | boolean | No | ヘッダー行の有無（デフォルト: true） |

## 出力
JSON 配列。各要素はヘッダーをキーとしたオブジェクト。

## 制約
- 読み取り専用（ファイルの変更はしない）
- 最大ファイルサイズ: 500MB
- エンコーディング: UTF-8 のみ

## 使用例
```typescript
const result = await parseCsv({ filePath: "data/users.csv" });
// → [{ name: "Alice", age: "30" }, { name: "Bob", age: "25" }]
```
```

#### metadata.json スキーマ

```typescript
const SkillMetadataSchema = z.object({
  /** スキルの一意識別子 */
  id: z.string(),
  /** 表示名 */
  name: z.string(),
  /** 1行の説明 */
  description: z.string(),
  /** バージョン番号 */
  version: z.number().int().min(1),
  /** 作成元 */
  createdBy: z.enum(["toolforge", "human"]),
  /** 作成日時 */
  createdAt: z.string(),
  /** 安全レベル */
  safetyLevel: z.enum(["read_only", "write_local", "write_external"]),
  /** タグ（検索用） */
  tags: z.array(z.string()),
  /** 使用回数 */
  usageCount: z.number().int().default(0),
  /** 成功率 (0.0-1.0) */
  successRate: z.number().min(0).max(1).default(1.0),
  /** 最終使用日時 */
  lastUsedAt: z.string().nullable().default(null),
  /** 承認状態 */
  approvalStatus: z.enum(["pending_review", "approved", "deprecated"]),
});
type SkillMetadata = z.infer<typeof SkillMetadataSchema>;
```

#### SDK への動的登録

生成されたスキルは `createSdkMcpServer` で MCP ツールとして各エージェントに提供される:

```typescript
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";

// Skill Registry から承認済みスキルをロード
const approvedSkills = skillRegistry.getApproved();

// MCP サーバーとして動的に構築
const skillServer = createSdkMcpServer({
  name: "agent-skills",
  version: "1.0.0",
  tools: approvedSkills.map(skill => tool(
    skill.id,
    skill.description,
    skill.zodSchema,
    skill.handler,
    { annotations: { readOnly: skill.safetyLevel === "read_only" } },
  )),
});

// エージェント実行時に注入
for await (const message of query({
  prompt: nodePrompt,
  options: {
    mcpServers: { "agent-skills": skillServer },
    allowedTools: [
      ...config.allowedTools,
      ...approvedSkills.map(s => `mcp__agent-skills__${s.id}`),
    ],
  },
})) { /* ... */ }
```

#### 安全設計（4層防壁）

| 層 | 検証内容 | 失敗時の動作 |
|----|---------|-------------|
| **1. 静的解析** | 禁止パターン検出（`process.exit`, `fs.rm`, `fetch` 等） | 生成却下 |
| **2. サンドボックス実行** | 隔離環境でテスト実行。FS/Network アクセスをブロック | 生成却下 |
| **3. 人間レビュー** | PR として作成。`write_external` レベルは必ず人間承認 | マージ拒否で未登録 |
| **4. ランタイム監視** | 使用時の成功率を追跡。50% 以下で自動 deprecate | 自動無効化 + アラート |

**安全レベルと承認フロー:**

| 安全レベル | 説明 | 承認フロー |
|-----------|------|-----------|
| `read_only` | ファイル読み取り、データ変換のみ | テスト通過で自動承認 |
| `write_local` | ローカルファイルの作成・変更 | テスト通過 + PR レビュー |
| `write_external` | 外部 API 呼び出し、ネットワークアクセス | テスト通過 + PR レビュー + 人間の明示的承認 |

#### スキルの進化サイクル

```
生成 → テスト → PR → 承認 → 登録 → 使用 → 評価 → 改善
                                        ↑         │
                                        └─────────┘
                                        成功率低下時に
                                        Tool Synthesizer が
                                        改良版を生成
```

- **使用回数 0 が30日続く** → `deprecated` に遷移、次回クリーンアップで削除
- **成功率 50% 以下** → 自動 deprecate + ToolForge に改良版生成を依頼
- **成功率 80% 以上 かつ 使用回数 10+** → Planner のデフォルトツールセットに昇格

#### 生成されるスキルの例

| スキル名 | トリガー | 用途 |
|---------|---------|------|
| `parse-csv` | データ処理タスクで CSV パース失敗が頻発 | CSV/TSV の構造化パース |
| `run-playwright-test` | E2E テストの要求に対してツールがない | Playwright ベースのブラウザテスト実行 |
| `generate-db-migration` | DB スキーマ変更タスクでマイグレーション生成が手動 | SQL マイグレーションファイル自動生成 |
| `analyze-bundle-size` | パフォーマンスタスクでバンドルサイズ分析が必要 | webpack/vite バンドル分析 |
| `screenshot-diff` | UI 変更タスクでビジュアルリグレッションチェック | スクリーンショット比較 |
| `openapi-client-gen` | API 連携タスクで OpenAPI スペックからクライアント生成 | TypeScript API クライアント自動生成 |

---

### 12.8 Dry Run モード（事前プレビュー）

#### 概要

タスクを実行せずに**「何をするか」を事前にプレビュー**する。Issue のラベルに `dry-run` を付与するか、CLI で `--dry-run` フラグを指定すると有効化される。

#### フロー

```
Issue / CLI (dry-run 指定)
    │
    ▼
通常通り Intake → Planning を実行
    │
    ▼
DAG 生成完了
    │
    ├── 通常モード: そのまま Execution へ
    │
    └── Dry Run モード: 実行を停止、プレビューを出力
            │
            ▼
        Issue / PR にプレビューコメントを投稿
            │
            ▼
        ユーザーが確認
            │
            ├── 「実行」コメント → Dry Run 解除、Execution へ
            ├── 「修正して」コメント → Planner が DAG を修正、再プレビュー
            └── 「キャンセル」コメント → タスク中止
```

#### プレビューコメントのフォーマット

````markdown
📋 **実行計画プレビュー** (Issue #42)

## 概要
ログイン画面のメールバリデーション修正

## 実行 DAG
[1] Analyzer (Haiku) → コードベース調査
[2] Designer (Sonnet) → specs/issue-42/design.md 作成
[3] Implementer (Sonnet) → コード修正 + テスト作成
[4] Critic (Sonnet) → コードレビュー
[5] Validate (Haiku) → 最終検証

## 変更予定ファイル（推定）
| ファイル | 変更種別 | 推定変更行数 |
|---------|---------|------------|
| src/validators/email.ts | 修正 | ~20行 |
| src/pages/login.tsx | 修正 | ~10行 |
| test/validators/email.test.ts | 新規作成 | ~50行 |

## 見積もり
| 項目 | 推定値 |
|------|--------|
| コスト | $2.90 |
| 所要時間 | 約35分 |
| リスクレベル | Low |

## アクション
- 「実行」とコメントすると処理を開始します
- 「修正して」とコメントすると計画を修正します
- 「キャンセル」とコメントすると中止します

---
_🤖 Dry Run プレビュー | AI Engineering Team_
````

#### 用途

| ユースケース | 説明 |
|-------------|------|
| **信頼構築** | システム導入初期に、ユーザーが動作を理解するまで全タスクを Dry Run で実行 |
| **高リスクタスク** | 大規模変更やセキュリティ関連の変更を事前に確認 |
| **コスト管理** | コストが高いタスクの事前見積もり |
| **計画レビュー** | チームで実行計画をレビューしてから実行 |

---

### 12.9 リアルタイムダッシュボード

#### 概要

システムの全状態を一目で把握できる**軽量 Web UI**。SQLite の読み取り専用接続で構築し、Orchestrator プロセスに HTTP サーバーを同梱する。

#### 技術スタック

| コンポーネント | 技術 | 選定理由 |
|--------------|------|---------|
| バックエンド | Express（Orchestrator プロセス内） | 追加プロセス不要、SQLite 直接読み取り |
| フロントエンド | Vite + React（静的ビルド） | 軽量、SPA で十分 |
| リアルタイム更新 | Server-Sent Events (SSE) | WebSocket より軽量、単方向で十分 |
| チャート | recharts | 軽量、React ネイティブ |

#### 画面構成

```
┌──────────────────────────────────────────────────────────────┐
│  AI Engineering Team Dashboard                    [repo ▼]  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─ Overview ──────────────────────────────────────────────┐ │
│  │  Active: 2   Queue: 5   Today: 12 done   Cost: $8.50   │ │
│  │  ■■■■□□ Circuit Breakers: All OK                        │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─ Task Queue ────────────────────────────────────────────┐ │
│  │  #42 [fix] メールバリデーション     🔄 implementing      │ │
│  │  #43 [build] エクスポート機能       ⏳ awaiting_approval │ │
│  │  #44 [fix] API キャッシュ           📋 planning          │ │
│  │  #45 [docs] README 更新             ⏸ pending           │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─ Active DAG (#42) ──────────────────────────────────────┐ │
│  │  [Analyze ✅] → [Design ✅] → [Implement 🔄] → [Critic] │ │
│  │  Cost: $1.35 / $2.90   Time: 18m / 35m est.             │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─ Metrics (7 days) ─────────────┐ ┌─ Cost (30 days) ────┐ │
│  │  Success Rate: 87% [████████░░] │ │  [$] ▁▃▅▃▂▆▄▃▅▂▃▄ │ │
│  │  Avg Duration: 28min            │ │  Total: $45.20      │ │
│  │  Avg Cost: $3.10                │ │  Avg/day: $1.50     │ │
│  │  Revert Rate: 2%               │ └─────────────────────┘ │
│  └─────────────────────────────────┘                         │
│                                                              │
│  ┌─ Agent Status ──────────────────────────────────────────┐ │
│  │  Analyzer  : idle       CB: closed ✅                    │ │
│  │  Planner   : idle       CB: closed ✅                    │ │
│  │  Designer  : idle       CB: closed ✅                    │ │
│  │  Implementer: #42 実装中  CB: closed ✅                  │ │
│  │  Critic    : idle       CB: closed ✅                    │ │
│  │  Scribe    : idle       CB: closed ✅                    │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌─ Skill Library (6 skills) ──────────────────────────────┐ │
│  │  parse-csv (v1) ✅ 92% success   12 uses                │ │
│  │  run-playwright (v2) ✅ 85%       8 uses                 │ │
│  │  ...                                                     │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

#### API エンドポイント

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/api/status` | システム全体の状態サマリー |
| GET | `/api/tasks` | タスク一覧（フィルタ対応） |
| GET | `/api/tasks/:id` | タスク詳細 + DAG 状態 |
| GET | `/api/tasks/:id/dag` | DAG のノード一覧と状態 |
| GET | `/api/agents` | エージェント状態 + Circuit Breaker |
| GET | `/api/metrics` | 成功率、コスト、所要時間の集計 |
| GET | `/api/skills` | スキルライブラリ一覧 |
| GET | `/api/budget` | 階層型予算の残高 |
| GET | `/api/events` | SSE ストリーム（リアルタイム更新） |

#### 複数リポジトリ対応

ダッシュボードのヘッダーにリポジトリ切り替えドロップダウンを配置。選択されたリポジトリのタスク・メトリクスのみを表示する。全リポジトリの横断ビュー（合計コスト・合計タスク数）も提供する。

#### システム構成

```
┌──────────────────────────────────────────────────────┐
│                  Orchestrator Process                  │
│                                                        │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │ Orchestrator │  │ Express API  │  │  SSE Stream  │ │
│  │ (メインループ)│  │ (port 3100)  │  │ (/api/events)│ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬──────┘ │
│         │                  │                  │        │
│         └────── SQLite (tasks.db) ───────────┘        │
└──────────────────────────────────────────────────────┘
          ↑ SSE
┌──────────────────────┐
│  Dashboard (Browser)  │
│  React SPA            │
│  port 3100 (同一)     │
└──────────────────────┘
```

#### 認証・アクセス制御

ダッシュボードはローカルネットワーク内での使用を前提とする。

| 方式 | 説明 |
|------|------|
| **デフォルト** | `localhost` のみリッスン（外部アクセス不可） |
| **Basic 認証（オプション）** | `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` 環境変数が設定されている場合に有効化 |
| **リバースプロキシ** | 外部公開時は nginx 等のリバースプロキシで TLS + 認証を設定 |

---

### 12.10 Issue 自動トリアージ

#### 概要

ラベルなし・不完全な Issue を**自動的に分類・ラベル付け・優先度設定**する。ユーザーがラベルを付け忘れてもシステムが処理を開始できる。

#### トリアージ項目

| 項目 | 判定方法 | 出力 |
|------|---------|------|
| **タイプ** | Haiku が Issue タイトル+本文を分析 | `bug` / `feature` / `docs` / `question` ラベルを自動付与 |
| **優先度** | 影響範囲（全ユーザー/一部/エッジケース）× 緊急度（クラッシュ/機能不全/体験劣化） | `P1`〜`P4` ラベルを自動付与 |
| **推定工数** | 変更対象ファイル数・変更行数の推定 | `size/S`, `size/M`, `size/L` ラベルを自動付与 |
| **関連コンポーネント** | ファイルパスやキーワードからモジュールを推定 | `component/auth`, `component/ui` 等のラベル |

#### フロー

```
Issue 作成（ラベルなし or 不完全）
    │
    ▼
GitHubPoller が検知
    │
    ▼
Classifier (Haiku) が自動トリアージ
    │
    ▼
GitHub API でラベルを自動付与
    │
    ▼
Issue にコメント:
  「🏷️ 自動トリアージ結果:
    タイプ: bug
    優先度: P2（一部ユーザーに影響する機能不全）
    推定工数: M（3-5ファイル変更）
    関連: src/auth/, src/pages/login/

   ラベルが正しくない場合は手動で修正してください。」
    │
    ▼
通常の Intake フローへ
```

#### ラベル修正への対応

ユーザーが自動付与されたラベルを手動で変更した場合、システムは修正後のラベルを優先する。Pattern Memory に「この種の Issue はユーザーが X と判断した」として学習し、次回以降のトリアージ精度を向上させる。

---

### 12.11 推定コスト・時間の事前表示

#### 概要

Planner が DAG を生成した時点で、**推定コスト・所要時間・リスクレベルを Issue コメントに投稿**する。Pattern Memory の蓄積に比例して精度が向上する。

#### 表示フォーマット

```markdown
📊 **タスク見積もり** (Issue #42)

| 項目 | 推定値 | 信頼度 |
|------|--------|--------|
| コスト | $2.90 | ±$0.80 (過去12件の類似タスク) |
| 所要時間 | 約35分 | ±10分 |
| リスクレベル | Low | — |
| 変更予定ファイル数 | 3ファイル | — |
| DAG ノード数 | 5ステップ | — |

設計PRが完成したら通知します。

---
_🤖 AI Engineering Team_
```

#### 信頼度の算出

```typescript
function estimateCost(plan: ExecutionPlan, history: EvalResult[]): CostEstimate {
  const similar = findSimilarTasks(plan, history);

  if (similar.length < 3) {
    // データ不足: ノード別のデフォルト見積もりを合算
    return {
      estimatedUsd: plan.totalEstimatedCostUsd,
      confidence: "low",
      basis: "default_estimates",
    };
  }

  const costs = similar.map(h => h.costUsd);
  const mean = costs.reduce((a, b) => a + b, 0) / costs.length;
  const stddev = Math.sqrt(costs.reduce((a, c) => a + (c - mean) ** 2, 0) / costs.length);

  return {
    estimatedUsd: mean,
    marginUsd: stddev * 1.5,  // ±1.5σ
    confidence: similar.length >= 10 ? "high" : "medium",
    basis: `${similar.length} similar tasks`,
  };
}
```

---

### 12.12 PR フィードバック学習

#### 概要

人間がPRレビューで残したコメント（修正指示・質問・承認理由・却下理由）を構造化して保存し、以後のエージェントの動作に反映する。**エージェントがチームの文化・好みを学習**する仕組み。

#### 学習対象

| カテゴリ | コメント例 | 学習内容 |
|---------|-----------|---------|
| **技術選定** | 「zod を使ってください」 | プロジェクトのライブラリ選定ポリシー |
| **命名規則** | 「この関数名はわかりにくい」 | チームの命名の好み |
| **テスト基準** | 「テストが足りない」 | 期待されるテストカバレッジ水準 |
| **設計判断** | 「このアプローチではなく〜」 | 好まれるアーキテクチャパターン |
| **コードスタイル** | 「早期リターンにして」 | コーディングスタイルの好み |
| **肯定的フィードバック** | 「LGTM、この書き方いいね」 | 好まれるパターン（正例） |

#### スキーマ

```sql
CREATE TABLE feedback_learnings (
  id TEXT PRIMARY KEY,
  -- ソース
  pr_number INTEGER NOT NULL,
  comment_id TEXT NOT NULL,
  comment_author TEXT NOT NULL,
  comment_body TEXT NOT NULL,
  -- 分類
  category TEXT NOT NULL,          -- 'tech_choice' | 'naming' | 'testing' | 'design' | 'style' | 'positive'
  sentiment TEXT NOT NULL,         -- 'correction' | 'suggestion' | 'praise'
  -- 学習内容
  learning TEXT NOT NULL,          -- 構造化された学習内容（1文）
  context TEXT,                    -- どの状況で適用するか
  -- メタ
  repo TEXT NOT NULL,              -- 対象リポジトリ
  occurrences INTEGER DEFAULT 1,  -- 同一学習の出現回数
  last_seen TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

#### 注入フロー

```
PRレビューコメント検出
    │
    ▼
Classifier (Haiku) がコメントを分類
    │
    ├── 修正指示 → 自動修正フロー（12.2）
    │       ↓ 同時に
    │   学習内容を抽出して feedback_learnings に保存
    │
    ├── 肯定コメント → 学習内容を抽出して保存
    │
    └── 質問 → 回答フロー（12.2）

次回タスク実行時:
    │
    ▼
Designer / Implementer のプロンプトに注入:
    「## このリポジトリのフィードバック履歴
     - zod を使用してバリデーションを行う（3回指摘）
     - 早期リターンパターンを好む（2回指摘）
     - テストは最低でも全分岐をカバーする（5回指摘）」
```

#### 重複排除と重み付け

- 同一内容の学習は `occurrences` をインクリメント（重複して保存しない）
- プロンプトへの注入時は `occurrences` 上位10件を優先
- 90日間 `occurrences` が増えなかった学習は自動的に減衰（プロジェクトの慣習は変化するため）

---

### 12.13 Agent 間の連携報告書（Handoff Report）

#### 概要

各 DAG ノードのエージェントが構造化された「引き継ぎ報告書」を出力し、後続エージェントが読む。**何をしたか、なぜそうしたか、何を棄却したか**の情報が保存される。

#### スキーマ

```typescript
const HandoffReportSchema = z.object({
  /** このノードで何をしたかの要約 */
  summary: z.string(),
  /** 行った判断とその理由 */
  decisions: z.array(z.object({
    decision: z.string(),
    rationale: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
  })),
  /** 検討したが棄却した代替案 */
  alternatives: z.array(z.object({
    approach: z.string(),
    rejectionReason: z.string(),
  })),
  /** 検出したリスク */
  risks: z.array(z.object({
    description: z.string(),
    severity: z.enum(["high", "medium", "low"]),
    mitigation: z.string().optional(),
  })),
  /** 未解決の疑問（後続エージェントまたは人間に委ねる） */
  openQuestions: z.array(z.string()),
  /** 変更したファイル */
  filesModified: z.array(z.string()),
  /** テスト結果（該当する場合） */
  testResults: z.object({
    passed: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
  }).optional(),
});
type HandoffReport = z.infer<typeof HandoffReportSchema>;
```

#### 利用パターン

| 引き継ぎ元 → 先 | Handoff Report の活用 |
|----------------|---------------------|
| Analyzer → Planner | 調査結果の構造化引き継ぎ。Planner は `risks` と `openQuestions` を基に DAG を調整 |
| Designer → Implementer | 設計判断の背景を伝達。`alternatives` により「なぜ他の方法を選ばなかったか」を理解 |
| Implementer → Critic | 実装の意図を伝達。Critic は `decisions` を基にレビューの焦点を絞る |
| Critic → Implementer（ループ時） | 指摘事項を構造化して返却。Implementer は `openQuestions` を解消する形で修正 |

#### 保存と参照

- SQLite の `handoff_reports` テーブルに DAG ID + ノード ID をキーとして保存:

```sql
CREATE TABLE handoff_reports (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  dag_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  agent_role TEXT NOT NULL,
  report TEXT NOT NULL,          -- HandoffReport の JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(dag_id, node_id)
);
CREATE INDEX idx_handoff_dag ON handoff_reports(dag_id);
```
- 後続ノードのプロンプトに `前のエージェントの報告:` として自動注入
- Eval Store と連携し、「どの判断が成功/失敗に繋がったか」を分析可能にする

---

### 12.14 適応型プロンプト最適化

#### 概要

Eval Store + PR フィードバック学習のデータを基に、エージェントのシステムプロンプトを**定期的に自動最適化**する。人間レビュー付きの安全な改善サイクル。

#### 最適化サイクル（月次）

```
毎月1日 03:00 (Cron)
    │
    ▼
Optimizer Agent (Opus) が起動
    │
    ▼
過去30日のデータを集計:
  ├── 失敗率の高いパターン（Eval Store）
  ├── 頻出の PR フィードバック（feedback_learnings）
  ├── Critic の品質スコア分布
  └── Handoff Report の openQuestions 傾向
    │
    ▼
各エージェントのプロンプトに対する改善案を生成:
  ├── Designer: 「テストケースの記述が不足する傾向。チェックリストを追加」
  ├── Implementer: 「早期リターンの指摘が多い。コーディングルールに追加」
  └── Critic: 「セキュリティ観点の漏れが3件。チェック項目を追加」
    │
    ▼
PR を作成: 「[PromptOpt] 月次プロンプト最適化 2026-04」
  ├── 変更対象: src/execution/agent-configs.ts
  ├── 各変更に根拠データを添付
  └── A/B テスト結果（可能な場合）
    │
    ▼
人間がレビュー → 承認 → プロンプト更新
```

#### A/B テスト（オプション）

高コスト化を避けるため、A/B テストは以下のタスクでのみ実施:

- 過去に失敗したタスクと同一カテゴリの新タスク
- Cron による夜間レビュータスク（低リスク）

```
旧プロンプトで実行 → 結果 A
新プロンプトで実行 → 結果 B
    │
    ▼
品質スコア + コスト + 所要時間を比較
    │
    ├── B が A より有意に改善 → PR に「A/B テスト: 改善確認済み」を記載
    └── B が A と同等以下 → PR に「A/B テスト: 改善未確認」を記載
```

#### 安全策

| 制約 | 根拠 |
|------|------|
| 月次1回のみ実行 | 頻繁な変更はシステムの安定性を損なう |
| 必ず PR 経由 | 人間がプロンプト変更を承認 |
| ロールバック可能 | Git 管理されているため、いつでも前バージョンに戻せる |
| 変更量制限 | 1回の最適化でプロンプトの20%以上を変更しない |

---

### 12.15 自律的動作の一覧と優先度

| # | 動作パターン | トリガー | 対応エージェント | 人間の操作 |
|---|-------------|---------|----------------|-----------|
| 1 | **Issue ディスカッション** | 不明確な Issue 検知 | Classifier (Haiku) | 質問に回答するだけ |
| 2 | **レビューコメント自動修正** | PR に修正指示コメント | Implementer (Sonnet) | 再レビューするだけ |
| 3 | **レビュー質問への自動回答** | PR に質問コメント | Classifier (Haiku, 分類) + Analyzer (Haiku, 回答生成) | 必要なら追加コメント |
| 4 | **CI 自動修正** | CI 失敗 | Analyzer + Implementer | なし（成功時） |
| 5 | **進捗自動報告** | DAG 実行中 | Orchestrator | なし |
| 6 | **コンフリクト自動解消** | PR コンフリクト検出 | Implementer (Sonnet) | なし（成功時） |
| 7 | **関連 Issue 検出** | 新 Issue 作成時 | Classifier (Haiku) | なし |
| 8 | **Stale PR リマインド** | PR 放置検出 | Orchestrator | レビューする |
| 9 | **設計フィードバック反映** | 設計 PR にフィードバック | Designer (Sonnet) | 再レビューするだけ |
| 10 | **夜間コードレビュー** | Cron (03:00) | Analyzer + Designer | PR 確認するだけ |
| 11 | **自律スキル生成** | 能力ギャップ検出 | ToolForge (Sonnet) | PR レビュー（`read_only` は自動承認） |
| 12 | **Dry Run プレビュー** | `dry-run` ラベル / フラグ | Planner (Opus) | 計画を確認して「実行」 |
| 13 | **Issue 自動トリアージ** | ラベルなし Issue 検知 | Classifier (Haiku) | 必要ならラベル修正 |
| 14 | **コスト・時間の事前表示** | DAG 生成完了時 | Planner (Opus) | なし |
| 15 | **PR フィードバック学習** | PR レビューコメント | Classifier (Haiku) | なし |
| 16 | **Handoff Report** | 各 DAG ノード完了時 | 全エージェント | なし |
| 17 | **適応型プロンプト最適化** | Cron（月次） | Optimizer (Opus) | PR レビュー |

---

## 13. 複数リポジトリ対応

### 13.1 概要

本システムは**複数の対象リポジトリを同時に管理**する汎用エージェントとして設計する。Orchestrator は1つのプロセスで複数リポジトリの Issue を監視し、それぞれ独立にタスクパイプラインを実行する。

### 13.2 設計方針

```
┌─────────────────────────────────────────────────────────┐
│                    Orchestrator                           │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐ │
│  │              Repository Registry                     │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐            │ │
│  │  │ Repo A   │ │ Repo B   │ │ Repo C   │ ...        │ │
│  │  │ owner/a  │ │ owner/b  │ │ org/c    │            │ │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────┘            │ │
│  └───────┼─────────────┼─────────────┼─────────────────┘ │
│          │             │             │                    │
│  ┌───────▼─────────────▼─────────────▼─────────────────┐ │
│  │           共有 Task Queue (SQLite)                   │ │
│  │   repo フィールドで論理分離                           │ │
│  └─────────────────────────────────────────────────────┘ │
│          │             │             │                    │
│  ┌───────▼──┐  ┌───────▼──┐  ┌──────▼───┐              │
│  │Worktrees │  │Worktrees │  │Worktrees │              │
│  │ repo-a/  │  │ repo-b/  │  │ repo-c/  │              │
│  │ ├analyzer│  │ ├analyzer│  │ ├analyzer│              │
│  │ ├designer│  │ ├designer│  │ ├designer│              │
│  │ └impl... │  │ └impl... │  │ └impl... │              │
│  └──────────┘  └──────────┘  └──────────┘              │
└─────────────────────────────────────────────────────────┘
```

### 13.3 リポジトリ設定スキーマ

```typescript
const RepoConfigSchema = z.object({
  /** 一意識別子 */
  id: z.string(),
  /** GitHub リポジトリ (owner/repo 形式) */
  githubRepo: z.string().regex(/^[^/]+\/[^/]+$/),
  /** 対象リポジトリのローカルパス */
  projectDir: z.string(),
  /** worktree のベースディレクトリ */
  worktreeDir: z.string(),
  /** GitHub トークン（リポジトリ固有のトークンが必要な場合） */
  githubToken: z.string().optional(),
  /** 有効/無効 */
  enabled: z.boolean().default(true),
  /** リポジトリ固有のラベルマッピング */
  labelMapping: z.record(z.string()).optional(),
  /** 日次予算上限（リポジトリ単位） */
  dailyBudgetUsd: z.number().optional(),
  /** 最大同時実行数 */
  maxConcurrent: z.number().int().min(1).default(1),
});
type RepoConfig = z.infer<typeof RepoConfigSchema>;
```

### 13.4 設定ファイル（repos.json）

```json
{
  "repositories": [
    {
      "id": "frontend",
      "githubRepo": "myorg/frontend-app",
      "projectDir": "/home/user/repos/frontend-app",
      "worktreeDir": "/home/user/worktrees/frontend-app",
      "enabled": true,
      "dailyBudgetUsd": 10,
      "maxConcurrent": 1
    },
    {
      "id": "backend",
      "githubRepo": "myorg/backend-api",
      "projectDir": "/home/user/repos/backend-api",
      "worktreeDir": "/home/user/worktrees/backend-api",
      "enabled": true,
      "dailyBudgetUsd": 10,
      "maxConcurrent": 1
    }
  ]
}
```

### 13.5 リソース分離

| リソース | 分離方式 |
|---------|---------|
| **Task Queue** | 共有 SQLite、`repo` カラムで論理分離 |
| **Worktree** | リポジトリごとに独立ディレクトリ（`worktrees/{repo-id}/{role}/`） |
| **Budget** | リポジトリごとの `dailyBudgetUsd` + 全体の `DAILY_BUDGET_USD` |
| **Circuit Breaker** | リポジトリ × エージェントロール × タスクタイプ |
| **Eval Store** | 共有テーブル、`repo` カラムで分離 |
| **Pattern Memory** | リポジトリごとに独立（リポジトリの特性が異なるため） |
| **Feedback Learnings** | リポジトリごとに独立 |
| **Skill Library** | **共有**（汎用ツールはリポジトリ横断で再利用） |

### 13.6 Orchestrator のポーリングループ

```typescript
async tick(): Promise<void> {
  for (const repo of this.repos.filter(r => r.enabled)) {
    // リポジトリごとに独立してポーリング
    await this.pollRepo(repo);
  }
  // リポジトリ横断でキューからタスクをディスパッチ
  await this.dispatchTasks();
}

async pollRepo(repo: RepoConfig): Promise<void> {
  const poller = this.getPoller(repo);
  await poller.pollIssues();
  await poller.pollApprovals();
  await poller.pollReviewComments();
}

async dispatchTasks(): Promise<void> {
  // 全リポジトリのタスクを優先度順にデキュー
  // ただしリポジトリごとの maxConcurrent を尊重
  while (this.canDispatch()) {
    const task = this.queue.getNextAcrossRepos(this.repoLoadMap);
    if (!task) break;
    await this.executeTask(task);
  }
}
```

### 13.7 クロスリポジトリの考慮事項

| 課題 | 対応 |
|------|------|
| 異なるリポジトリ間の CLAUDE.md が異なる | `settingSources: ["project"]` でリポジトリ固有の CLAUDE.md をロード |
| 異なる技術スタック | Planner が `package.json` / 設定ファイルを読んで判断 |
| リポジトリ間の依存関係 | 現時点ではスコープ外（将来拡張） |
| 予算の公平配分 | リポジトリごとの `dailyBudgetUsd` + 全体キャップで二重保護 |

---

## 14. 認証・課金設計

### 14.1 認証方式

v2.1 と同様、2つの認証方式をサポート。

| 項目 | Max 20x ($200/月) | API 従量課金 |
|------|-------------------|-------------|
| 認証方式 | `claude login`（OAuth） | `ANTHROPIC_API_KEY` 環境変数 |
| 並行実行 | 1 推奨（枠共有） | 制限なし（RPM内） |
| コスト予測 | 完全に予測可能 | v3.0 で大幅削減（$3-5/タスク） |

### 14.2 モデル別コスト構造

| モデル | 用途 | 入力 | 出力 | 1タスクあたり推定 |
|--------|------|------|------|-----------------|
| Haiku | Analyzer, Classifier, Scribe, Validation | $0.25/M | $1.25/M | $0.05-0.10 |
| Sonnet | Designer, Implementer, Critic | $3/M | $15/M | $0.50-2.00 |
| Opus | Planner（計画のみ） | $15/M | $75/M | $0.50-1.00 |

**v2.1 vs v3.0 コスト比較:**

| 観点 | v2.1 | v3.0 |
|------|------|------|
| 分類 | Opus ($0.50) | Haiku ($0.01) |
| 設計 | Opus ($5.00) | Sonnet ($1.00) |
| 計画 | なし | Opus ($1.00) ← 唯一の Opus 使用 |
| 分析 | なし | Haiku ($0.05) |
| 検証 | なし | Haiku ($0.03) |
| 実装 | Sonnet ($2.00) | Sonnet ($2.00) |
| レビュー | なし | Sonnet ($0.50) |
| **合計** | **$7.50** | **$4.59** (Critic Loop なし) / **$5.59** (Critic Loop あり) |

Haiku への移行と Opus 使用箇所の限定により、品質保証層を追加しても**総コストは削減**される。

---

## 15. ディレクトリ構成

```
~/ai-engineer/                        # 本リポジトリ
├── src/
│   ├── index.ts                      # エントリーポイント
│   ├── orchestrator.ts               # メインループ
│   │
│   ├── intake/                       # Layer 1: Intake
│   │   ├── classifier.ts             # Haiku ベース分類器
│   │   ├── github-poller.ts          # GitHub Issue ポーリング
│   │   ├── cron-scheduler.ts         # 定時タスク生成
│   │   └── manual-cli.ts             # 手動タスク投入
│   │
│   ├── planning/                     # Layer 2: Planning
│   │   ├── planner.ts                # Planner Agent ラッパー
│   │   ├── dag-scheduler.ts          # DAG 実行スケジューラ
│   │   └── plan-schemas.ts           # ExecutionPlan, PlanNode スキーマ
│   │
│   ├── execution/                    # Layer 3: Execution
│   │   ├── agent-configs.ts          # 6エージェントの設定定義
│   │   ├── node-executor.ts          # 個別ノード実行器
│   │   ├── worktree-manager.ts       # Git worktree 管理
│   │   └── role-mapping.ts           # TaskType → AgentRole マッピング
│   │
│   ├── toolforge/                    # ToolForge: 自律スキル生成
│   │   ├── gap-detector.ts           # 能力ギャップ検出
│   │   ├── tool-synthesizer.ts       # ツール生成 (Sonnet)
│   │   ├── sandbox-validator.ts      # サンドボックス検証
│   │   └── skill-registry.ts         # スキルレジストリ (SQLite + FS)
│   │
│   ├── quality/                      # Layer 4: Quality Gate
│   │   ├── validation-gate.ts        # ハンドオフ検証
│   │   ├── critic-loop.ts            # Generator-Critic ループ
│   │   └── quality-schemas.ts        # ValidationResult, CriticResult スキーマ
│   │
│   ├── feedback/                     # Layer 5: Feedback Loop
│   │   ├── eval-store.ts             # 実行結果記録 (SQLite)
│   │   ├── pattern-memory.ts         # 学習パターン管理
│   │   └── model-router.ts           # Adaptive Model Routing
│   │
│   ├── queue/                        # タスクキュー
│   │   ├── task-queue.ts             # SQLite キュー操作
│   │   ├── schema.ts                 # テーブル定義
│   │   └── migrations.ts             # マイグレーション
│   │
│   ├── safety/                       # 安全機構
│   │   ├── circuit-breaker.ts        # Per-Agent Circuit Breaker
│   │   ├── rate-controller.ts        # Rate Controller
│   │   └── budget-guard.ts           # 階層型 Budget Guard
│   │
│   ├── bridges/                      # 外部連携
│   │   ├── result-collector.ts       # PR 作成、GitHub API
│   │   └── context-bridge.ts         # ノード間コンテキスト引き継ぎ
│   │
│   ├── notifications/                # 通知
│   │   └── slack-notifier.ts         # Slack Webhook
│   │
│   ├── logging/                      # ログ
│   │   ├── logger.ts                 # pino ロガー
│   │   └── log-rotation.ts           # ログローテーション
│   │
│   ├── dashboard/                    # ダッシュボード API
│   │   ├── server.ts                 # Express API サーバー
│   │   ├── routes.ts                 # REST エンドポイント
│   │   └── sse.ts                    # Server-Sent Events ストリーム
│   │
│   ├── config/                       # 設定
│   │   ├── env-config.ts             # 環境変数ロード
│   │   └── repo-config.ts            # 複数リポジトリ設定ロード
│   │
│   └── types.ts                      # 共通型定義
│
├── dashboard-ui/                      # ダッシュボード UI (別パッケージ)
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/
│   │   └── hooks/
│   ├── package.json
│   └── vite.config.ts
│
├── skills/                            # ToolForge スキルライブラリ
│   ├── registry.json                  # スキルインデックス
│   └── tools/                         # 各スキルのディレクトリ
│       ├── parse-csv/
│       │   ├── SKILL.md
│       │   ├── handler.ts
│       │   ├── schema.ts
│       │   ├── tests.ts
│       │   └── metadata.json
│       └── .../
│
├── package.json
├── tsconfig.json
├── .env
├── tasks.db                          # タスクDB（自動生成）
└── logs/                             # 構造化ログ
```

---

## 16. 環境変数

```bash
# === 認証 ===
# Max プラン: ANTHROPIC_API_KEY を設定しない
# API 従量課金: ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_API_KEY=

# === GitHub ===
GITHUB_TOKEN=ghp_...
# 単一リポジトリモード（repos.json 未使用時のフォールバック）
GITHUB_REPO=owner/repo

# === パス ===
PROJECT_DIR=/home/user/my-project
WORKTREE_DIR=/home/user/worktrees

# === 複数リポジトリ ===
REPOS_CONFIG_PATH=./repos.json

# === ダッシュボード ===
DASHBOARD_PORT=3100
DASHBOARD_ENABLED=true
DASHBOARD_USERNAME=              # 設定時に Basic 認証を有効化
DASHBOARD_PASSWORD=              # 設定時に Basic 認証を有効化

# === ToolForge ===
TOOLFORGE_ENABLED=true
SKILL_LIBRARY_DIR=./skills

# === Dry Run ===
DRY_RUN_DEFAULT=false            # true にすると全タスクがデフォルトで Dry Run

# === CI Monitor ===
CI_MONITOR_ENABLED=true

# === プロンプト最適化 ===
PROMPT_OPTIMIZATION_CRON=0 3 1 * *   # 毎月1日 03:00

# === Rate Control (Max プラン用) ===
RATE_CONTROL_ENABLED=true
RATE_COOLDOWN_SECONDS=60
MAX_TASKS_PER_WINDOW=150
RATE_LIMIT_WARN_THRESHOLD=0.1

# === 予算 ===
DAILY_BUDGET_USD=20
BUDGET_INTAKE_PCT=5
BUDGET_PLANNING_PCT=20
BUDGET_EXECUTION_PCT=55
BUDGET_QUALITY_PCT=15
BUDGET_RESERVE_PCT=5

# === 並行実行 ===
MAX_CONCURRENT=1

# === 通知 ===
SLACK_WEBHOOK_URL=https://hooks.slack.com/...

# === ログ ===
LOG_LEVEL=info
LOG_RETENTION_DAYS=30
```

---

## 17. 実装ロードマップ

### Phase 1: 基盤強化（即効性・高インパクト）

| # | タスク | 変更量 | コスト削減 | 品質向上 |
|---|--------|--------|-----------|---------|
| 1.1 | Classifier を Opus → Haiku に変更 | S | 大 | — |
| 1.2 | Eval Store の追加（実行結果記録開始） | M | — | 中 |
| 1.3 | Per-Agent Circuit Breaker の導入 | M | — | 中 |
| 1.4 | Validation Gate の追加（ハンドオフ検証） | M | — | 大 |
| 1.5 | 階層型 Budget Guard の導入 | S | 中 | — |

### Phase 2: アーキテクチャ刷新

| # | タスク | 変更量 | コスト削減 | 品質向上 |
|---|--------|--------|-----------|---------|
| 2.1 | Analyzer Agent の追加 | M | 中 | 中 |
| 2.2 | Planner Agent + DAG スキーマ定義 | L | — | 大 |
| 2.3 | DAG Scheduler の実装 | L | — | 大 |
| 2.4 | ディレクトリ構成の再編成（5層構造） | M | — | — |
| 2.5 | Designer（旧 Reviewer）を Sonnet に変更 | S | 大 | — |

### Phase 3: 品質ゲート

| # | タスク | 変更量 | コスト削減 | 品質向上 |
|---|--------|--------|-----------|---------|
| 3.1 | Critic Agent の追加 | M | — | 大 |
| 3.2 | Generator-Critic Loop の実装 | L | — | 大 |
| 3.3 | 適用基準の自動判定ロジック | M | — | 中 |

### Phase 4: 自律的動作パターン

| # | タスク | 変更量 | コスト削減 | 自律性向上 |
|---|--------|--------|-----------|-----------|
| 4.1 | Issue ディスカッション（Clarification Loop） | M | — | 大 |
| 4.2 | PR レビューコメント自動修正（Review Comment Responder） | L | — | 大 |
| 4.3 | レビュー質問への自動回答 | M | — | 中 |
| 4.4 | 自律的な進捗報告（Proactive Status Updates） | S | — | 中 |
| 4.5 | マージコンフリクト自動解消 | M | — | 中 |
| 4.6 | 関連 Issue 自動検出 | S | — | 小 |
| 4.7 | Stale PR リマインド | S | — | 小 |

### Phase 5: 学習・最適化

| # | タスク | 変更量 | コスト削減 | 品質向上 |
|---|--------|--------|-----------|---------|
| 5.1 | Pattern Memory の実装 | M | 中 | 中 |
| 5.2 | Adaptive Model Routing の実装 | M | 大 | 中 |
| 5.3 | Pattern Injection（Planner への注入） | S | — | 中 |
| 5.4 | 日次ダイジェストの強化（品質トレンド） | S | — | — |

### Phase 6: ToolForge — 自律スキル生成

| # | タスク | 変更量 | コスト削減 | 自律性向上 |
|---|--------|--------|-----------|-----------|
| 6.1 | Gap Detector の実装（失敗パターン検出 + エージェント報告） | M | — | 大 |
| 6.2 | Tool Synthesizer の実装（Sonnet によるコード生成） | L | — | 大 |
| 6.3 | Sandbox Validator の実装（隔離環境でのテスト実行） | L | — | — |
| 6.4 | Skill Registry の実装（SQLite + FS + 検索） | M | — | 中 |
| 6.5 | SDK 動的登録（createSdkMcpServer による注入） | M | — | 大 |
| 6.6 | スキル進化サイクル（成功率追跡 + 自動 deprecate + 改良版生成） | M | 中 | 大 |
| 6.7 | スキル PR 自動作成（人間レビューフロー） | S | — | 中 |

### Phase 7: 開発者体験・運用基盤

| # | タスク | 変更量 | インパクト |
|---|--------|--------|-----------|
| 7.1 | リアルタイムダッシュボード（Express + React SPA） | L | 運用可視化 |
| 7.2 | SSE によるリアルタイム更新 | M | UX |
| 7.3 | Issue 自動トリアージ（ラベル・優先度・工数自動判定） | M | 利便性 |
| 7.4 | Dry Run モード（事前プレビュー） | M | 信頼構築 |
| 7.5 | 推定コスト・時間の事前表示 | S | UX |
| 7.6 | 複数リポジトリ対応（Repository Registry + 論理分離） | L | 汎用性 |

### Phase 8: 自己進化

| # | タスク | 変更量 | インパクト |
|---|--------|--------|-----------|
| 8.1 | PR フィードバック学習（feedback_learnings テーブル + 注入） | M | 自己進化 |
| 8.2 | Agent 間 Handoff Report（構造化引き継ぎ） | M | 品質 |
| 8.3 | 適応型プロンプト最適化（月次 Cron + A/B テスト） | L | 長期品質 |

---

## 18. コーディング規約

v2.1 の規約を全て継承する。追加規約は以下の通り。

### 18.1 DAG 関連の命名規則

| 対象 | 規則 | 例 |
|------|------|-----|
| DAG ID | `dag-{taskId}-{timestamp}` | `dag-gh-42-0-1711234567` |
| ノード ID | `{dagId}-{step}-{role}` | `dag-gh-42-0-1711234567-01-analyzer` |
| 検証結果 ID | `val-{nodeId}` | `val-dag-gh-42-0-1711234567-03-implementer` |

### 18.2 新モジュールの配置ルール

| レイヤー | ディレクトリ | 依存可能な対象 |
|---------|------------|--------------|
| L1: Intake | `src/intake/` | queue, types, config |
| L2: Planning | `src/planning/` | queue, execution(configs), feedback, types |
| L3: Execution | `src/execution/` | types, config |
| L4: Quality | `src/quality/` | execution(configs), types |
| L5: Feedback | `src/feedback/` | queue(DB), types |
| Safety | `src/safety/` | types, config |

**上位層 → 下位層への依存のみ許可。** L3(Execution) が L4(Quality) に依存してはならない。DAG Scheduler が Quality Gate を呼び出す形で層間を接続する。

### 18.3 エラーハンドリング追加規約

```typescript
// DAG 実行エラーの分類
const DagErrorCategory = {
  NodeTimeout: "node_timeout",
  NodeBudget: "node_budget",
  NodeCrash: "node_crash",
  ValidationFail: "validation_fail",
  CriticFail: "critic_fail",
  DependencyFail: "dependency_fail",
} as const;
type DagErrorCategory = (typeof DagErrorCategory)[keyof typeof DagErrorCategory];

class DagExecutionError extends Error {
  constructor(
    message: string,
    readonly dagId: string,
    readonly nodeId: string,
    readonly category: DagErrorCategory,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DagExecutionError";
  }
}
```

---

## 19. 設計原則

本システムの設計は以下の原則に基づく。

### 19.1 Anthropic の推奨: シンプルから始めて段階的に複雑化する

> "Start with simple prompts, optimize them with comprehensive evaluation, and add multi-step agentic systems only when simpler solutions fall short."

Phase 1-4 のロードマップはこの原則に従い、即効性のある改善から着手し、段階的に複雑度を上げる。

### 19.2 Google の Composite Pattern

Google が定義する8つのマルチエージェントパターンのうち、本システムは以下を組み合わせる:

1. **Coordinator（Layer 2: Planner）** — タスクを分析し、適切なエージェントに委譲
2. **Parallel Fan-Out（Layer 3: DAG Scheduler）** — 独立サブタスクの並列実行
3. **Generator-Critic（Layer 4: Critic Loop）** — 品質の反復的改善
4. **Hierarchical（Layer 2 + L3）** — 戦略層（Planner）と作業層（Worker Agents）の分離

### 19.3 Production-Grade の信頼性設計

- **Blast Radius 局所化**: Per-Agent Circuit Breaker で障害の伝播を防止
- **Validation Gate**: 全ハンドオフ時の構造的検証でサイレント失敗を防止
- **Event Sourcing**: Eval Store に全実行結果を記録し、障害分析と再現を可能にする
- **Graceful Degradation**: 上位モデルが使えない場合、下位モデルにフォールバック

### 19.4 コスト効率最大化

- **階層型モデルルーティング**: 分析・検証は Haiku、実装は Sonnet、計画のみ Opus
- **Adaptive Model Routing**: 過去データに基づく動的モデル選択
- **Early Termination**: Validation Gate で明らかな失敗を早期検出し、不要な後続処理を省略

---

## 20. 既知の制約と今後の拡張

### 20.1 現在の制約

| 制約 | 影響 | 緩和策 |
|------|------|--------|
| Max プランの5時間ウィンドウ制限 | 集中的なタスク処理時にレート制限に到達 | Rate Controller で消費ペースを制御 |
| worktree が repo × role ごとに1つ | 同一 repo 内の同一 role の並列実行不可 | DAG Scheduler が同一 role ノードを直列化 |
| **単一プロセスアーキテクチャ** | 全コンポーネント（Orchestrator + Dashboard + agents）が1プロセス。メモリ使用量に上限 | ノードごとに独立 `query()` で回避。将来的にワーカープロセス分離を検討 |
| **DAG 実行中のクラッシュ復旧なし** | プロセスクラッシュ時に実行中 DAG の状態が失われる | `recoverFromCrash()` で in_progress → pending にリセット（DAG の途中再開は不可） |
| **CI 監視のポーリング遅延** | CI 完了から検出まで最大30秒の遅延 | 将来的に Webhook 駆動に移行 |
| **SQLite の書き込み直列化** | WAL モードでも同時書き込みは直列化される | 現在の maxConcurrent=1 では問題なし。並行度を上げる場合は要検証 |
| **GitHub API レート制限** | 30秒ポーリング × 複数イベントタイプ × 複数リポジトリで API 消費が増大 | リポジトリ数3以下を推奨。それ以上は Webhook 駆動が必須 |
| Zod v3 の `toJSONSchema` 未対応 | 手動で JSON Schema を定義する必要がある | Zod v4 移行時に解消 |

### 20.2 将来の拡張

| 拡張 | 優先度 | 説明 |
|------|--------|------|
| **Webhook 駆動** | 中 | ポーリング → GitHub Webhook で即応性向上 |
| **Semantic Cache** | 中 | 類似プロンプトの結果再利用でコスト削減20-40% |
| **SDK Native Subagent** | 低 | `agents` オプションを使った native subagent パターン |
| **A2A Protocol** | 低 | Google Agent-to-Agent Protocol による外部エージェント連携 |
| **MCP Tool Server** | 低 | カスタムツールを MCP サーバーとして提供 |
| **クロスリポジトリ依存管理** | 低 | リポジトリ間の依存関係を考慮したタスク実行順序制御 |

---

## 付録 A: 参考文献

- [Google: Eight Essential Multi-Agent Design Patterns](https://developers.googleblog.com/developers-guide-to-multi-agent-patterns-in-adk/)
- [Anthropic: Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
- [Anthropic: Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Anthropic: Building Agents with Claude Agent SDK](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)
- [Anthropic: Multi-Agent Research System](https://www.anthropic.com/engineering/multi-agent-research-system)
- [Claude Agent SDK Documentation](https://platform.claude.com/docs/en/agent-sdk/overview)
- [LangChain: Choosing the Right Multi-Agent Architecture](https://blog.langchain.com/choosing-the-right-multi-agent-architecture/)
- [Confluent: Event-Driven Multi-Agent Systems](https://www.confluent.io/blog/event-driven-multi-agent-systems/)
- [Google: Agent-to-Agent Protocol (A2A)](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
