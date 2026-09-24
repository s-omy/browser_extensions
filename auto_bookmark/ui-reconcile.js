// 保存データの整合処理の呼び出しと、結果の通知（設定画面用）

import { describeReconcile, reconcileStorage } from "./reconcile.js";
import { TONE, setStatus } from "./ui-common.js";

/**
 * @returns {{run: () => Promise<import("./reconcile.js").ReconcileResult>}}
 *   run … 整合を実行し、反映した内容（または失敗）を通知欄に表示する。失敗しても例外は投げない
 */
export function initReconcile() {
  const statusDiv = document.getElementById("reconcile-status");

  async function run() {
    const result = await reconcileStorage();
    if (result.error) {
      console.warn("保存データの整合に失敗しました:", result.error);
      setStatus(statusDiv, "保存データを現在のブックマークに合わせる処理に失敗しました（" + (result.error.message || result.error) +
        "）。表示と各操作は続けられます。", TONE.WARNING);
    } else {
      const text = describeReconcile(result);
      if (text) setStatus(statusDiv, text, TONE.MUTED); // 変更が無かったときは、直前の通知を消さない
    }
    return result;
  }
  return { run };
}
