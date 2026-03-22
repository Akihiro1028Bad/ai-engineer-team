# Feature Specification: AI Agent Orchestrator — 自律AIエージェントチームによる開発タスク自動処理システム

**Feature Branch**: `001-ai-agent-orchestrator`
**Created**: 2026-03-22
**Status**: Draft
**Input**: User description: "AI_Engineering_Team_設計書_v2.1.md — 4つの専門AIエージェント（Reviewer, Fixer, Builder, Scribe）を24時間稼働のWindows PC + WSL2上で動かし、ソフトウェア開発タスクを自律的に処理するシステム"

## Clarifications

### Session 2026-03-22

- Q: クラッシュ時に `in_progress` 状態のまま残ったタスクをどう扱うか → A: `pending` にリセットし、リトライカウント+1 で再実行する
- Q: 対象リポジトリのスコープ（単一 vs 複数） → A: 単一リポジトリ固定（環境変数 `PROJECT_DIR` で指定）
- Q: GitHub API 障害・レート制限時のポーリング動作 → A: ログ記録のみで次回ポーリング（5分後）で自動リトライ。ポーリング失敗には Circuit Breaker を適用しない
- Q: パイプライン中の人間承認ゲートの配置 → A: Reviewer 完了後に設計PR を作成し、人間が承認してから Fixer/Builder に進む。実装完了後に最終 PR を作成する
- Q: 設計PRの承認イベントの検出方法 → A: GitHub PR の approve/reject ステータスを既存のポーリング周期（5分間隔）で監視する
- Q: テスト・動作確認のエビデンス方針 → A: ブラウザでの動作確認が必要なタスクは必ず実施しスクリーンショットをPRに含める。その他のテスト・動作確認のエビデンス（テスト実行結果、ログ出力等）もPRに含めること

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 単体エージェントによるコードレビュー自動実行 (Priority: P1)

開発者として、GitHub Issue に `ai-task` ラベルを付けるか、cron スケジュールで指定した時間に、Reviewer エージェントが対象コードを自動的にレビューし、問題点を構造化された形式で報告してほしい。これにより、人間のレビュー前に機械的に検出可能な問題が事前に洗い出され、レビュー品質が向上する。

**Why this priority**: システムの最小動作単位であり、1エージェントの起動→実行→結果回収の全フローを検証できる。タスクキュー、Orchestrator のメインループ、エージェント実行の基盤がすべて含まれるため、後続の全ストーリーの土台となる。

**Independent Test**: Orchestrator を起動し、手動またはcronでレビュータスクを投入する。Reviewer エージェントが対象ファイルを読み取り、構造化された指摘結果を出力し、タスクのステータスが完了に遷移することを確認する。

**Acceptance Scenarios**:

1. **Given** Orchestrator が起動している状態で、**When** 手動でレビュータスクをキューに投入する、**Then** Reviewer エージェントが起動し、指摘結果を構造化形式で出力し、タスクステータスが「completed」に遷移する
2. **Given** cron で毎晩 3:00 にレビュータスクが設定されている状態で、**When** 指定時刻になる、**Then** Reviewer エージェントが自動的に起動し、`src/` 配下のコード品質レビューを実行する
3. **Given** Reviewer エージェントが実行中の状態で、**When** 設定されたタイムアウト（10分）を超過する、**Then** AbortController によりエージェントが強制終了され、タスクがリトライキューに戻る
4. **Given** Reviewer エージェントが実行中の状態で、**When** 許可されていないツール（Edit, Bash）を使用しようとする、**Then** ツール呼び出しが自動的に拒否される

---

### User Story 2 - 複数エージェントのパイプライン連携（Reviewer → Fixer） (Priority: P2)

開発者として、バグ報告の Issue を投稿すると、Classifier が自動分類し、Reviewer がコード調査 → Fixer がバグ修正 → テスト実行という一連のパイプラインが自動的に流れ、修正結果が PR として作成されてほしい。エージェント間の分析結果は Context Bridge で引き継がれ、前工程の成果を後工程が活用できる。

**Why this priority**: エージェント間連携（Context Bridge）、タスク分解（Classifier）、依存関係付きキュー管理という中核機能を検証できる。単体エージェント（P1）が動いた上で、複数エージェントの協調動作を実現する。

**Independent Test**: `ai-task` + `bug` ラベル付きの GitHub Issue を作成する。Classifier がタスクを分解し、Reviewer → Fixer の順で実行され、Fixer が Reviewer の指摘を Context Bridge 経由で参照して修正を行い、PR が自動作成されることを確認する。

**Acceptance Scenarios**:

1. **Given** `ai-task` ラベル付きの Bug Issue が存在する状態で、**When** Orchestrator がポーリングで Issue を検出する、**Then** Classifier がタスク種別を「pipeline」と判定し、依存関係付きのサブタスク（review → fix）をキューに投入する
2. **Given** Reviewer タスクが完了し handoff JSON が保存されている状態で、**When** 設計PRが自動作成される、**Then** パイプラインは `awaiting_approval` 状態に遷移し、Slack に承認依頼が通知される
3. **Given** 設計PRが `awaiting_approval` 状態の場合、**When** 人間がPRを承認（approve）する、**Then** Fixer タスクが Reviewer の指摘を読み込んだプロンプトで起動し、修正とテスト実行を行う
4. **Given** Fixer タスクが完了した状態で、**When** Result Collector が結果を受け取る、**Then** 修正内容を含む最終PRが GitHub に自動作成され、Slack に完了通知が送信される
5. **Given** Classifier が Issue の内容を判断できない状態で、**When** 分類結果が「unclear」となる、**Then** GitHub Issue にコメントで質問が自動投稿される

---

### User Story 3 - 4エージェントフルチームによる新機能実装 (Priority: P3)

開発者として、「新機能を追加してほしい」という Issue を投稿すると、Reviewer（設計レビュー）→ Builder（実装）→ Scribe（ドキュメント更新）の全エージェントが協調して作業し、実装・テスト・ドキュメント更新が揃った PR が作成されてほしい。

**Why this priority**: 4エージェント全体の協調動作、Builder の新機能実装能力、Scribe のドキュメント自動生成を検証する。P1・P2 の基盤の上に、最も複雑なユースケースを実現する。

**Independent Test**: `ai-task` + `feature` ラベル付きの Issue を作成する。Classifier が 3 ステップのパイプライン（review → build → document）に分解し、各エージェントが順次実行され、コード変更とドキュメント更新を含む PR が作成されることを確認する。

**Acceptance Scenarios**:

1. **Given** `ai-task` + `feature` ラベル付き Issue が存在する状態で、**When** Classifier が分類する、**Then** review → build → document の 3 ステップパイプラインが依存関係付きでキューに投入される
2. **Given** Reviewer が設計レビューを完了した状態で、**When** 設計PRが自動作成される、**Then** パイプラインは `awaiting_approval` 状態に遷移し、Slack に承認依頼が通知される
3. **Given** 設計PRが承認された状態で、**When** Builder タスクが起動する、**Then** Builder が Reviewer の設計方針に基づいて新機能を実装する
4. **Given** Builder エージェントが実装を完了した状態で、**When** Scribe タスクの依存条件が満たされる、**Then** Scribe が Builder の変更内容を基にドキュメント（README、API ドキュメント等）を自動更新する
5. **Given** Builder エージェントの変更が 500 行を超える状態で、**When** PR 作成を試みる、**Then** diff サイズ制限により PR 作成が拒否され、分割が要求される

---

### User Story 4 - 安全な24時間無人運用 (Priority: P4)

運用者として、システムが24時間無人で安定稼働し、異常時には自動復旧またはSlack通知で人間に報告してほしい。Rate Controller が Max プランの枠消費を制御し、Circuit Breaker が連続失敗を検出して自動停止し、systemd がプロセスクラッシュ時に自動再起動する。

**Why this priority**: 本番運用に必要な安全機構・監視・復旧機能を実現する。P1-P3 の機能が動作した上で、長時間安定運用に必要な非機能要件を満たす。

**Independent Test**: Orchestrator を systemd サービスとして起動し、意図的にエージェント失敗を発生させる。Circuit Breaker が発動して停止し、Slack 通知が届くことを確認する。プロセスを強制終了し、systemd が自動再起動することを確認する。

**Acceptance Scenarios**:

1. **Given** Max プランで運用中の状態で、**When** 5時間ウィンドウ内のタスク数が上限に近づく、**Then** Rate Controller がクールダウンを挿入し、枠超過を防止する
2. **Given** エージェントが連続して 5 回失敗した状態で、**When** Circuit Breaker が OPEN 状態に遷移する、**Then** 全エージェントの実行が 1 時間停止され、Slack に緊急通知が送信される
3. **Given** Circuit Breaker が OPEN 状態で 1 時間経過した状態で、**When** HALF-OPEN 状態に遷移する、**Then** 試行タスクが成功すれば CLOSED に戻り、失敗すれば再度 OPEN になる
4. **Given** Orchestrator プロセスがクラッシュした状態で、**When** systemd が異常終了を検出する、**Then** 30 秒後にプロセスが自動再起動され、`in_progress` 状態のタスクは `pending` にリセット（リトライカウント+1）されて再実行される
5. **Given** 毎日 08:00 になった状態で、**When** Daily digest が生成される、**Then** 完了数・失敗数・コスト・PR 数・平均所要時間のサマリが Slack に送信される

---

### Edge Cases

- GitHub Issue のタイトル・本文が空、または極端に短い場合、Classifier は `unclear` と分類し、Issue にコメントで詳細を求める
- 同じ Issue に対して重複してタスクが生成されるケース → Issue ID ベースの冪等性チェックで重複投入を防止する
- Context Bridge の handoff JSON が不正な形式の場合 → バリデーションで検出し、タスクを失敗として処理する
- OAuth トークンが期限切れになった場合 → 認証エラーを検出し、Slack で `claude login` 再実行を通知して一時停止する
- worktree のブランチが既に存在する場合（前回のタスク残骸） → worktree のクリーンアップ処理で既存ブランチを検出・削除してから作成する
- 対象リポジトリに CLAUDE.md が存在しない場合 → デフォルトのコーディング規約を適用する
- Fixer のテスト実行が無限ループする場合 → コマンドタイムアウト + maxTurns で強制終了する
- Max プランと API Key が同時に設定されている場合 → 起動時のバリデーションでエラーとし、明確なエラーメッセージを表示する
- Orchestrator クラッシュ後に `in_progress` タスクが残存する場合 → 再起動時に `pending` にリセットし、リトライカウント+1 で再実行する
- GitHub API が一時的に利用不能の場合 → ポーリング失敗をログに記録し、次回ポーリング（5分後）で自動リトライする。Circuit Breaker は適用しない
- 設計PRが長期間承認されない場合 → `awaiting_approval` 状態のまま保持し、後続タスクは実行しない。Daily digest に未承認PR の件数と経過時間を含める
- 設計PRが却下（reject / close）された場合 → パイプライン全体の後続タスクをキャンセルし、タスクステータスを `failed` に遷移させ、Slack に通知する

## Requirements *(mandatory)*

### Functional Requirements

**タスク取り込み・分類:**

- **FR-001**: システムは GitHub Issues を 5 分間隔でポーリングし、`ai-task` ラベルが付いた Issue を自動的にタスクとして取り込まなければならない。対象リポジトリは環境変数 `PROJECT_DIR` で指定する単一リポジトリに限定する
- **FR-001a**: GitHub API の一時障害（5xx, レート制限）時はログ記録のみ行い、次回ポーリング周期（5分後）で自動リトライする。ポーリング失敗には Circuit Breaker を適用しない
- **FR-002**: システムは Issue のタイトル・本文・ラベルを基に、タスク種別（review / fix / build / document）を自動分類しなければならない
- **FR-003**: 複合的な Issue は複数のサブタスクに分解し、依存関係を設定してキューに投入しなければならない
- **FR-004**: 分類不可能な Issue に対しては、GitHub Issue にコメントで質問を自動投稿しなければならない
- **FR-005**: cron スケジュールによる定期タスク（夜間レビュー、週次ドキュメント同期）を設定できなければならない
- **FR-006**: 手動でのタスク投入（CLI スクリプト）をサポートしなければならない

**タスクキュー管理:**

- **FR-007**: タスクはステータス（pending → in_progress → completed / failed / awaiting_approval）で管理され、永続化されなければならない
- **FR-008**: 依存関係のあるタスクは、先行タスクが完了するまで実行されてはならない
- **FR-008a**: パイプラインタスクにおいて、Reviewer（設計/分析）完了後にシステムは設計PRを自動作成し、タスクステータスを `awaiting_approval` に遷移させなければならない。後続の実装タスク（Fixer/Builder）は人間がPRを承認するまで実行されてはならない
- **FR-008b**: `awaiting_approval` 状態のタスクに紐づく GitHub PR の approve/reject ステータスを、既存のポーリング周期（5分間隔）で監視しなければならない。approve 検出時は後続タスクを `pending` に遷移させ、reject/close 検出時はパイプライン全体の後続タスクをキャンセルしなければならない
- **FR-009**: タスクには優先度（1〜10）を設定でき、優先度順にディスパッチされなければならない
- **FR-010**: 失敗したタスクは最大 3 回まで exponential backoff でリトライされなければならない（30秒 → 120秒 → 480秒）
- **FR-010a**: Orchestrator 再起動時、`in_progress` 状態のタスクは `pending` にリセットし、リトライカウントを 1 増加して再実行しなければならない

**エージェント実行:**

- **FR-011**: 各エージェント（Reviewer, Fixer, Builder, Scribe）は、許可されたツールのみ使用可能でなければならない（ホワイトリスト方式）
- **FR-012**: 各エージェントにはターン数上限（15/30/50/20）、予算上限、タイムアウトが設定されなければならない
- **FR-013**: エージェントは専用の Git worktree 上で作業し、互いの変更が干渉してはならない
- **FR-014**: エージェントの出力は構造化された形式でバリデーションされなければならない

**エージェント間連携:**

- **FR-015**: 前工程エージェントの結果は JSON ファイルとして保存され、後工程エージェントのプロンプトに自動挿入されなければならない
- **FR-016**: handoff ファイルにはタスクID、エージェント名、タイムスタンプ、結果データを含まなければならない

**結果出力:**

- **FR-017**: エージェントの変更は GitHub PR として自動作成されなければならない
- **FR-017a**: ブラウザでの動作確認が必要なタスク（GitHub PR 画面、Slack 通知表示等）は、エージェントまたは人間が実施し、スクリーンショットを PR の説明に含めなければならない
- **FR-017b**: すべてのテスト・動作確認のエビデンス（テスト実行結果のログ、構造化出力のサンプル、Slack 通知のスクリーンショット等）を PR の説明に添付しなければならない
- **FR-018**: タスクの完了・失敗・緊急イベントは Slack に通知されなければならない
- **FR-019**: 毎日 08:00 に Daily digest（完了数、失敗数、コスト、PR 数、平均所要時間）が送信されなければならない

**安全設計:**

- **FR-020**: Max プラン利用時は Rate Controller がタスク間にクールダウン（デフォルト60秒）を挿入しなければならない
- **FR-021**: 連続 5 回の失敗で Circuit Breaker が発動し、全エージェントを 1 時間停止しなければならない
- **FR-022**: API 従量課金時は日次予算上限を超えた場合にエージェントを停止しなければならない
- **FR-023**: PR の diff サイズが 500 行を超える場合、PR 作成を拒否し分割を要求しなければならない
- **FR-024**: Git の main ブランチへの直接 push は禁止され、すべての変更は PR + CI 経由でなければならない

**監視・ログ:**

- **FR-025**: すべてのイベント（タスク開始・完了・失敗、ツール呼び出し、レート制限）を構造化ログとして記録しなければならない
- **FR-026**: ログには taskId、agentRole、timestamp をコンテキスト情報として含まなければならない
- **FR-027**: ログは 30 日間保持され、それ以上は自動削除されなければならない

**常駐化:**

- **FR-028**: Orchestrator は systemd user service として常駐化され、クラッシュ時に自動再起動されなければならない

### Key Entities

- **Task**: システムが処理する作業単位。ID、種別（review/fix/build/document）、タイトル、説明、ソース、優先度、ステータス（pending/in_progress/completed/failed/awaiting_approval）、依存関係、リトライ回数、コスト、所要ターン数を持つ
- **Agent**: タスクを実行する専門AIエージェント。役割（Reviewer/Fixer/Builder/Scribe）、許可ツールリスト、予算上限、ターン上限、タイムアウトを持つ
- **Handoff**: エージェント間の結果引き継ぎデータ。タスクID、エージェント名、タイムスタンプ、構造化された結果データを持つ
- **Classification**: Classifier の分類結果。複雑度（single/pipeline/unclear）、サブタスク定義、依存関係を持つ

### Assumptions

- GitHub Issue のポーリング間隔 5 分はリアルタイム性と API レート制限のバランスとして妥当と判断
- Max プランの 5 時間ウィンドウあたり 150 タスク上限は安全マージンを含んだ推定値
- タスクの最大リトライ回数 3 回は、一時的障害の復旧に十分かつ無限リトライを防止するバランス
- Classifier には軽量モデルを使用し、分類精度よりもコスト効率を優先
- Slack Webhook は通知用途に十分であり、双方向通信は不要と判断
- 初期運用では同時実行数 1（Max プラン）または 2（API 課金）で十分と判断
- 対象リポジトリは単一（`PROJECT_DIR` で指定）に固定。マルチリポジトリ対応は将来の拡張スコープとする

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: タスク投入から PR 作成までの所要時間が、単体タスクで 15 分以内、パイプラインタスクで 60 分以内に収まる
- **SC-002**: Reviewer エージェントの実行成功率が 90% 以上（タイムアウト・予算超過による失敗を除く）
- **SC-003**: パイプライン全体（分類 → エージェント実行 → PR 作成）の成功率が 80% 以上
- **SC-004**: 異常検出後のシステム自動復旧率が 95% 以上（人間の介入なしで復旧）
- **SC-005**: 構造化ログにより、任意のタスクの実行経過（開始・ツール呼び出し・完了/失敗）を事後追跡できる
- **SC-006**: Max プラン利用時に 5 時間ウィンドウの枠を使い切らずに 1 日分のタスクを処理できる
- **SC-007**: Daily digest により、運用者が毎朝 1 分以内でシステムの前日稼働状況を把握できる
- **SC-008**: プロセス再起動後、未完了タスクが pending 状態から再開され、データの喪失がない
