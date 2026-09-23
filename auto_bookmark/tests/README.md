# 自動テスト

Node.js を使わない、ブラウザだけで動く自動テストです。`chrome.*` API と AI API（`fetch`。Gemini形式・OpenAI互換形式の両方）をすべてモックし、実際の各 JS ファイルを ES モジュールとして `import` して検証します。実際の Chrome や外部 API へは一切アクセスしません。

## 実行方法

1. プロジェクトのルート（`manifest.json` があるフォルダ）で、キャッシュ無効化ヘッダーつきの簡易サーバーを立てます。

```bash
cd C:\work\chrome_ex\auto_bookmark
python tests/serve.py 8765
```

2. ブラウザで `http://localhost:8765/tests/run.html` を開きます。数十秒で結果が表示されます（差分プレビューやナレッジ同期のチャンク処理、リトライの待機を実際に走らせるため、多少時間がかかります）。
3. 緑（✓）が全件そろえば成功です。赤（✗）が出た項目は、失敗理由とスタックトレースがその場に表示されます。開発者ツールのコンソールにも `console.table` で失敗一覧が出ます。

**`python -m http.server` は使わないでください。** キャッシュを許可してしまうため、ソースを編集して再実行しても、ブラウザが古い `.js` をキャッシュから返し続けて失敗が再現することがあります（`tests/serve.py` はすべての応答に `Cache-Control: no-store` を付けて、これを避けます）。それでも古い結果が出るときは、サーバーのポート番号を変えて（例: `python tests/serve.py 8766`）ブラウザで新しいポートを開き直してください（同一オリジンに対する既存のキャッシュエントリは、後から `no-store` を付けても無効になりません）。

Node.js が入っている環境なら、同じ仕組みのまま `npx http-server -c-1`（キャッシュ無効化オプションつき）などに置き換えても構いません。専用のテストランナー（Jest 等）は使っていません。

## 構成

```
tests/
  README.md          このファイル
  serve.py            テスト用の簡易サーバー（Cache-Control: no-store つき）
  run.html            テストランナー本体（このページを開く）
  lib/
    assert.js          最小のテストレジストリ（describe/test/lazy）とアサーション
    harness.js          chrome.*（bookmarks/storage/notifications/permissions/…）と fetch（Gemini形式・OpenAI互換形式）のモック
    options-boot.js      options.html + options.js を、モックの上で起動する共通ヘルパー（②③④で使用）
  specs/
    unit.spec.js             privacy.js / bookmarks.js / storage.js の純粋なロジック
    gemini-client.spec.js     gemini.js の callGemini（リトライ・エラー分類・動作ログ・プロバイダ切替）
    openai-compatible.spec.js openai-compatible.js（LiteLLM Proxy 等向けアダプター）の純粋関数
    background.spec.js       background.js（右クリック・アイコン・ショートカットからの保存）
    settings.spec.js         設定画面: プロバイダ切替・APIキー・接続テスト・プライバシー設定・クイック保存先
    analyze.spec.js          ① フォルダ解析（バッチ処理・保護フォルダ除外・増分解析）
    relocate.spec.js         ② 再カテゴライズ（シミュレーション・差分操作・適用・取り消し）
    knowledge.spec.js        ③ ナレッジ同期
```

`describe()`/`test()`/`lazy()` の使い方は `lib/assert.js` のコメントを参照してください。重い共通セットアップ（`boot()` や `installChrome()` など）は `lazy()` で1回だけ実行してキャッシュし、その結果を複数の `test()` から検証する構成にしています（同じ画面操作を何度もやり直すと、遅くなるため）。

## 何を検証していないか

- 実際の Chrome（`chrome://extensions/` に読み込んだ拡張機能の動作）
- 実際の AI API（Gemini・LiteLLM Proxy 等）のレスポンス内容・レート制限・料金
- 実際の LiteLLM Proxy に対する疎通（`openai-compatible.js` はモック応答に対する純粋関数のテストのみ）
- 見た目（CSS・レイアウト）
- タブ右クリック時の `activeTab` 付与や、通知ボタンの表示など、OS・ブラウザの実装に依存する挙動

これらは `Readme.md` §11「制限事項」および `Note.md` §4 に記載のとおり、実機での確認が別途必要です。
