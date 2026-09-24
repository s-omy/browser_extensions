# Project Structure

## Organization Philosophy

拡張機能のルート直下に**フラットに置く**（`src/` は作らない）。責務ごとに1ファイルとし、次の層で依存する。

```
entry        background.js / options.js
   ↓
ui-*         設定画面の画面処理（DOM を触るのはここだけ）
   ↓
workflow     folder-analysis.js / relocation.js / knowledge.js（計画・実行・適用）
   ↓
ai-tasks     プロンプト・応答スキーマ・応答の検証
   ↓
gemini       callGemini（リトライ・エラー分類・ログ）→ openai-compatible.js（アダプター）

基盤（どの層からも参照可）: config.js / storage.js / bookmarks.js / privacy.js
  ※ background.js は workflow 層を経由せず ai-tasks を直接使ってよい（単発の処理のため）。
  ※ ui-* は、gemini.js のエラー文言・定数など読み取り専用の部品を直接参照してよい。
```

## Directory Patterns

### 共有ロジック（DOM に依存しない）
**Location**: ルート直下の `*.js`（`ui-*` 以外）
**Purpose**: サービスワーカーと設定画面の両方から使える業務ロジック
**Example**: `bookmarks.js`（ツリー走査・保護フォルダ判定）、`privacy.js`（送信可否・URL 整形）

### 設定画面の画面処理
**Location**: `ui-*.js`
**Purpose**: 画面ごとのイベント処理と描画。AI 呼び出しや移動などの業務ロジックは持たず、ワークフローを呼ぶ。設定値の保存や `bookmarks.getTree` のような単純な `chrome.*` 呼び出しは直接行ってよい
**Example**: `ui-relocate.js`（②）、`ui-diff.js`（差分の描画部品）

### テスト
**Location**: `tests/`（`lib/` にハーネス、`specs/` に `*.spec.js`）
**Purpose**: 対象モジュールごとに `*.spec.js` を置く。共通のモックは `tests/lib/harness.js` に集める

### ドキュメント
- `Readme.md`（開発者向けの概要）、`Note.md`（経緯・判断・未解決課題）、`user_guide.html`（利用者向け）
- `.kiro/steering/`（プロジェクトの指針）、`.kiro/specs/`（機能ごとの仕様）

## Naming Conventions

- **Files**: kebab-case（`folder-analysis.js`）。設定画面の画面処理は `ui-` 接頭辞。テストは `<対象>.spec.js`
- **Functions**: camelCase。非同期の取得系は `get*`、AI に依頼するタスクは動詞（`categorizePage`、`describeFolders`）
- **Constants**: UPPER_SNAKE。調整値は `config.js`、ストレージのキーは `storage.js` の `KEYS`
- **Storage keys**: snake_case（`folder_descriptions_by_id`）。追加時は `storage.js` 冒頭のデータ一覧コメントと `Readme.md` §5 も更新する

## Import Organization

```javascript
import { callGemini, processWithBisect } from "./gemini.js"; // 相対パス・拡張子 .js を必ず付ける
import { KEYS, getLlmConnection } from "./storage.js";
```

- 絶対パス・エイリアス・バンドラ前提の解決は使わない（ブラウザがそのまま解決できる形にする）。
- 依存は上表の**上から下への一方向**。下位層が上位層を import しない。

## Code Organization Principles

- **設定画面の DOM を触るのは `ui-*` と `options.js` のみ**。共有ロジックは `chrome.*` には触れてよいが、`document` には触れない。唯一の例外は、`background.js` が `chrome.scripting.executeScript` でページ側に注入する関数（ページの meta を読む。サービスワーカーには `document` がない）。
- **プロバイダ差はアダプターに閉じ込める**: `ai-tasks.js` 以降は `connection` オブジェクトだけを受け取り、Gemini / OpenAI 互換を区別しない。エラーの意味づけ（`GeminiError`）は `gemini.js` に集約する。
- **循環参照を作らない**（現状は無い）: `storage.js` は `gemini.js` の `DEFAULT_PROVIDER` を参照するため、`gemini.js` から `storage.js` を import してはならない（`gemini.js` は動作ログを `chrome.storage.local` へ直接書く）。
- **新しい AI タスク** → `ai-tasks.js` に追加（スキーマは Gemini 方言、候補 ID は `enum` で拘束）。**新しい調整値** → `config.js`。**新しい権限** → 理由を `Readme.md` §6 に記す。
- **保護フォルダは必ず `bookmarks.js` の判定を通す**（移動元・移動先・AI への送信のすべて）。

---
_Document patterns, not file trees. New files following patterns shouldn't require updates_
_updated_at: 2026-09-24（既存のコードと Readme.md から作成。要レビュー）_
