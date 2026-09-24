// 設定画面のエントリポイント。各ブロックの画面処理は ui-*.js に分けてあり、ここでは初期化だけを行う。
//
//   ui-settings.js  APIキー・接続テスト・プライバシー設定・クイック保存先
//   ui-folders.js   ① フォルダ解析
//   ui-relocate.js  ② 再カテゴライズ（差分の描画は ui-diff.js）
//   ui-knowledge.js ③ ページ知識（ナレッジベース）
//   ui-log.js       ④ 動作ログ

import { migrateLegacyStorage } from "./storage.js";
import { initFolders } from "./ui-folders.js";
import { initKnowledge } from "./ui-knowledge.js";
import { initLog } from "./ui-log.js";
import { initRelocate } from "./ui-relocate.js";
import { initSettings } from "./ui-settings.js";

async function start() {
  // 旧形式のデータを、各ブロックが読み込む前に現行形式へ移行しておく
  await migrateLegacyStorage();

  const log = initLog();
  const hooks = { onApiCall: () => log.refresh() };

  initSettings(hooks);
  const folders = initFolders(hooks);
  const relocate = initRelocate(hooks);
  const knowledge = initKnowledge(hooks);

  // 画面を開いただけではAPIを呼ばない（課金が発生する処理は、ボタン操作を経て実行する）
  await Promise.all([folders.refresh(), relocate.refresh(), knowledge.refresh(), log.refresh()]);
}

// モジュールスクリプトは DOMContentLoaded より前に実行されるが、読み込みタイミングによらず動くようにしておく
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
