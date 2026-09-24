# Implementation Plan

- [x] 1. キーワードの正規化を作る
- [x] 1.1 `keywords.js` に `normalizeKeywords` / `getKeywords` を実装する（テスト先行）
  - 区切り・重複・空・`_` `-` 保持・配列入力・旧形式読み取りの単体テストを先に書き、すべて通す
  - 完了条件: `tests/specs/keywords.spec.js` が全件成功する
  - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6_

- [x] 2. 保存形式を配列に変更し、既存データを移行する
- [x] 2.1 `storage.js` の移行（`storage_version` 3）を実装する
  - 旧 `keyword` を `keywords` に変換して `keyword` を削除する。他の項目は変更しない。冪等。失敗時は何も書かない
  - 完了条件: 移行のテスト（各形式・不変項目・冪等・失敗時不変）が成功し、`tests/lib/options-boot.js` の既定バージョンが 3 になる
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

- [x] 3. 入力元ごとに正規化を適用する
- [x] 3.1 AI の応答（`ai-tasks.js`）を配列スキーマ＋書式指示にする
  - スキーマを `keywords: ARRAY<STRING>` にし、プロンプトに 1 語ずつ・`machine_learning` / `MachineLearning` の指示を追加する。応答は正規化して保存する
  - 完了条件: ③ 同期のテストで、リクエストに書式指示と配列スキーマが含まれ、要素内に空白を含む応答も語ごとに保存される
  - _Requirements: 1.1, 2.1, 2.2, 2.3_
- [x] 3.2 右クリック保存のページ meta（`knowledge.js`）を正規化する
  - 空白・読点・カンマ区切りの meta が語の配列で保存され、空・区切りのみは空配列になる
  - 完了条件: 右クリック保存のテストで期待どおりの `keywords` が保存される
  - _Requirements: 3.1, 3.2_
- [x] 3.3 ナレッジ一覧（`ui-knowledge.js`）のタグを配列で扱う
  - 表示・追加（正規化して複数タグ・重複しない）・削除を配列で行い、保存内容が再表示後も残る
  - 完了条件: 一覧のテストで、空白区切りの旧データが語ごとのタグで表示され、追加・削除が保存される
  - _Requirements: 1.1, 4.1, 4.2, 4.3, 4.4_

- [x] 4. ② 再カテゴライズへの引き渡しを揃える
- [x] 4.1 `ai-tasks.js` の `ai_knowledge_context` を `keywords`（語の配列）にする
  - キーワードなしは空配列を渡す。旧形式が残っていても `getKeywords` で読める
  - 完了条件: ② のテストで AI への入力に `keywords` が含まれ、語の内容が変換前と同じ
  - _Requirements: 6.1, 6.2_

- [x] 5. 既存テストの更新と文書の反映
- [x] 5.1 既存テストの `keyword` を `keywords` に更新し、全テストを実行して成功させる
  - 完了条件: `tests/run.html` が全件成功
  - _Requirements: 1.1, 5.1_
- [x] 5.2 `storage.js` のデータ一覧コメント、`Readme.md` §5、`user_guide.html`（タグの説明）を更新する
  - 完了条件: 文書の `keyword` の記述が `keywords` の配列と `_` の書き方の説明に置き換わっている
  - _Requirements: 1.1, 1.6_
