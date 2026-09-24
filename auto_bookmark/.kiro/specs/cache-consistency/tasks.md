# Implementation Plan

- [x] 1. 現在のフォルダの状態を取得する部品を作る
- [x] 1.1 `bookmarks.js` に `listFolderStates(tree)` を追加する（テスト先行）
  - 全フォルダの現在の名前・階層パス・クイックアクセス・保護・直下のブックマーク数を返す。システムフォルダも ID として含める
  - 完了条件: `tests/specs/reconcile.spec.js` の `listFolderStates` のテストが成功する
  - _Requirements: 1.2, 2.5_

- [x] 2. 整合処理を実装する
- [x] 2.1 `knowledge.js` に `reconcileKnowledgeBase(bookmarks)` を追加する
  - 削除済みページの除去とパスの更新のみ行い、キーワード等は保持する。再読み込みしてから書き込む
  - 完了条件: 削除・パス変更・保持のテストが成功する
  - _Requirements: 2.6, 4.3_
- [x] 2.2 `reconcile.js` に `reconcileStorage` / `operationLock` / `describeReconcile` を実装する
  - 説明文・構造記録・ページ知識・クイック保存先の整合、`analyzed_name` / `analyzed_path` の補完、変更が無ければ書き込まない、排他中はスキップ、失敗は `{error}`
  - 完了条件: 削除・保護化・改名・移動・旧データ補完・冪等・保全・排他・失敗のテストが成功する
  - _Requirements: 2.1, 2.3, 2.4, 2.5, 2.7, 2.8, 2.9, 2.10, 2.11, 4.1, 4.2, 4.3, 4.4_

- [x] 3. 再解析の要否判定を拡張する
- [x] 3.1 `findStaleFolders` に「名称変更」「場所の変更」を追加し、`analyzeFolders` が `analyzed_name` / `analyzed_path` を保存する
  - 理由の優先順位は 未解析 > 名称変更 > 場所の変更 > 変更（件数）。旧データは `folder_name` / `hierarchical_categories` で代用し、誤検知しない
  - 完了条件: 判定のテストと、①の実行後に `analyzed_*` が保存されるテストが成功する
  - _Requirements: 3.1, 3.2, 3.4, 3.5, 3.6_

- [x] 4. 画面に組み込む
- [x] 4.1 `ui-reconcile.js` と `options.html` の通知欄を追加し、`options.js` の起動時に整合を実行する
  - 結果の件数を通知し、失敗時は警告を表示して続行する
  - 完了条件: 削除・改名後に画面を開くと通知欄に件数が出て、クイック保存先の一覧から削除済みフォルダが消える
  - _Requirements: 2.1, 2.7, 2.8, 2.10_
- [x] 4.2 `ui-folders.js` の一覧を現在のツリー基準で描画し、案内文に理由別の件数を出す
  - 削除済みは非表示・総数から除外、現在の名前・パスを表示、名称変更・場所の変更の印を出す、説明文は保持して表示
  - 完了条件: 一覧のテストで、削除・改名後の表示と案内文の件数が期待どおり
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 3.1, 3.2, 3.3_
- [x] 4.3 ①②③ の実行前に整合を呼び、①③ の実行中は排他にする
  - 完了条件: 実行前の整合のテストと、実行中は整合が走らないテストが成功する
  - _Requirements: 2.2, 2.9_

- [x] 5. 既存テストの更新と文書の反映
- [x] 5.1 全テストを実行して成功させる
  - 完了条件: `tests/run.html` が全件成功
  - _Requirements: 1.1, 2.1_
- [x] 5.2 `Readme.md`（データモデル・処理・制限事項）、`storage.js` のコメント、`user_guide.html` を更新する
  - 完了条件: 整合処理・再解析の理由・既知の制限（旧説明文の使用）が文書に反映されている
  - _Requirements: 1.1, 3.3_
