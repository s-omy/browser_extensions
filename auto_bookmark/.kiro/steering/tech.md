# Technology Stack

## Architecture

Chrome 拡張（Manifest V3）。**ビルド工程のない素の ES モジュール**構成で、`package.json`・バンドラ・フレームワークは使わない。

- **サービスワーカー**（`background.js`）: 右クリック・アイコン・ショートカットからの保存、通知。
- **設定画面**（`options.html` + `options.js`）: ①②③ の実行、設定、動作ログ。
- **共有モジュール**: DOM に依存しない業務ロジック。サービスワーカーと設定画面の両方から使う。
- **AI 呼び出し**: 単一の入口 `callGemini`（`gemini.js`）が、プロバイダごとのアダプターへ委譲する。

## Core Technologies

- **Language**: JavaScript（ES2022 モジュール）。型は JSDoc で表現し、関数の仕様は JSDoc を正とする。
- **Runtime**: Chrome（MV3）。`chrome.bookmarks` / `storage` / `contextMenus` / `notifications` / `commands` / `action` / `scripting` / `permissions`。
- **AI**: 既定は Gemini（`gemini-3.6-flash`）。OpenAI 互換（Chat Completions、Structured Outputs）は LiteLLM Proxy 等を想定。
- **Storage**: `chrome.storage.local`（設定・解析結果・ナレッジ・ログ）、`chrome.storage.session`（通知の取り消し用の一時記録）。

## Development Standards

### Code Quality
- `.editorconfig` / `.prettierrc.json` に従う（**CRLF**、インデント2スペース、`printWidth: 140`、末尾カンマなし、アロー関数の引数括弧は省略）。
- コメントは「何のために・なぜ」を書く。変更履歴風のコメントは書かない（履歴は git と `Note.md`）。
- マジックナンバーは `config.js` に集約する。
- DOM は `h()` ヘルパーで構築し、HTML 文字列を組み立てない。

### Error Handling
- AI 呼び出しの失敗は、`GeminiError` の種別（`no_key` / `config` / `http` / `network` / `blocked` / `truncated` / `empty` / `parse`）に**一箇所で**分類する。呼び出し側は種別で分岐し、ユーザー向けの文言は `describeGeminiError` で作る。
- リトライは 429/5xx/通信エラーのみ（指数バックオフ＋ジッター）。ブロック・途切れ・JSON 不正は対象を二分割して再試行し、原因の項目だけを切り分ける。

### Testing
- 自動テストは `tests/`。**Node 不要**のブラウザ実行式で、`chrome.*` と `fetch` をモックし、実モジュールを `import` して検証する。
- 実 Chrome・実 AI API・見た目・OS 依存挙動は自動テストの対象外（手動確認）。

## Development Environment

### Required Tools
- Windows + Chrome。テスト用サーバーに Python 3。GitHub 操作に `gh`。
- Node.js（fnm で管理、LTS）は **cc-sdd などの開発補助ツール専用**。拡張機能自体の実行・ビルドには不要。
- 任意: 自前 LLM 検証用に LiteLLM Proxy + Ollama（WSL2 上）。

### Common Commands
```bash
# Test:  python tests/serve.py 8765   → http://localhost:8765/tests/run.html を開く（python -m http.server は不可：キャッシュで古い .js が返る）
# Run:   chrome://extensions/ → デベロッパーモード → 「パッケージ化されていない拡張機能を読み込む」でこのフォルダを選ぶ
# Reload: 拡張機能カードの更新ボタン
```

## Key Technical Decisions

- **ID で同定する**: AI にはブックマークの連番だけを渡し、実 ID はコード側で保持して引き当てる。移動先は応答スキーマの `enum`（候補フォルダ ID）に拘束し、存在しないフォルダを作らせない。
- **スキーマは Gemini 方言で1回だけ書く**: `ai-tasks.js` の定義を、OpenAI 互換側は `openai-compatible.js` が標準 JSON Schema（strict）へ変換する。呼び出し側はプロバイダを意識しない。
- **最小権限**: `activeTab` + `scripting`（`<all_urls>`・`tabs` は使わない）。OpenAI 互換の接続先は `optional_host_permissions` で宣言し、保存時に**入力された1オリジンだけ**を `chrome.permissions.request` で許可してもらう。
- **API キーはヘッダで送る**（URL に載せない）。ただしストレージには**平文**保存（既知の制約）。動作ログには URL・タイトルを記録しない。
- **課金の制御**: ナレッジ同期は手動＋確認ダイアログ＋バッチ化＋バッチごとの保存。フォルダ名の変更だけなら AI を呼ばない。
- **フォルダの識別は `folder_id`**。階層パスの区切りは ` › `（`.` だとフォルダ名と衝突する）。

---
_Document standards and patterns, not every dependency_
_updated_at: 2026-09-24（既存の Readme.md / Note.md / コードから作成。要レビュー）_
