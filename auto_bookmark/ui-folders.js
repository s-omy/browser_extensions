// ① フォルダ解析: ボタン操作・進捗表示・フォルダ一覧の描画

import { analyzeFolders, findStaleFolders } from "./folder-analysis.js";
import { describeGeminiError } from "./gemini.js";
import { getLlmConnection, getFolderDescriptions, getFolderMeta, getPrivacySettings } from "./storage.js";
import { TONE, h, setStatus } from "./ui-common.js";

const MAX_FAILED_NAMES_SHOWN = 3;
const PROTECTED_DESCRIPTION = "保護フォルダのため、中身をAIに送信せず、解析しません。";

/** @param {{onApiCall: () => void}} hooks */
export function initFolders({ onApiCall }) {
  const analyzeBtn = document.getElementById("analyze-btn");
  const analyzeStaleBtn = document.getElementById("analyze-stale-btn");
  const progressText = document.getElementById("analyze-progress-text");
  const progressPercent = document.getElementById("analyze-progress-percent");
  const statusDiv = document.getElementById("analyze-status");
  const staleInfo = document.getElementById("stale-info");
  const categoryCount = document.getElementById("category-count");
  const tableContainer = document.getElementById("category-table-container");

  /** onlyFolderIds を指定すると、そのフォルダだけを解析する */
  async function runAnalysis(onlyFolderIds) {
    const connection = await getLlmConnection();
    if (!connection.apiKey) {
      setStatus(statusDiv, "エラー: 先にAPIキーを保存してください。", TONE.ERROR);
      return;
    }

    try {
      analyzeBtn.disabled = true;
      analyzeStaleBtn.disabled = true;
      setStatus(statusDiv, "");
      progressText.textContent = "処理中: ブックマーク階層をフルスキャン中...";
      progressPercent.textContent = "(0%)";

      const result = await analyzeFolders({
        connection,
        bookmarkTree: await chrome.bookmarks.getTree(),
        privacy: await getPrivacySettings(),
        onlyFolderIds,
        onProgress: ({ batchNo, batchCount, done, total }) => {
          progressText.textContent = "処理中: フォルダの説明文を生成中 (" + batchNo + "/" + batchCount + ")...";
          progressPercent.textContent = "(" + Math.round(done / total * 100) + "%)";
        }
      });
      reportResult(result);
    } catch (error) {
      console.error(error);
      setStatus(statusDiv, "エラー: 解析エラー: " + error.message, TONE.ERROR);
    } finally {
      analyzeBtn.disabled = false;
      progressText.textContent = "";
      progressPercent.textContent = "";
      await refresh();
      onApiCall();
    }
  }

  function reportResult({ targetCount, describedCount, failed, fatal, totalFolders }) {
    const notes = [];
    if (failed.length > 0) {
      const shown = failed.slice(0, MAX_FAILED_NAMES_SHOWN).map(f => "「" + f.folderName + "」").join("");
      const rest = failed.length - MAX_FAILED_NAMES_SHOWN;
      notes.push(failed.length + " 件のフォルダは説明文を生成できませんでした（以前の説明文があれば維持しています）: " +
        shown + (rest > 0 ? " ほか" + rest + "件" : "") + " 理由: " + failed[0].reason);
    }
    if (fatal) {
      const notReached = Math.max(targetCount - describedCount - failed.length, 0);
      notes.push("APIエラーのため中断しました（" + describeGeminiError(fatal) + "）。残り " + notReached + " 件のフォルダは未解析です");
    }
    const scope = targetCount === totalFolders ? totalFolders + " 件" : targetCount + " 件（全 " + totalFolders + " 件のうち）";
    setStatus(statusDiv,
      (fatal ? "中断: " : "完了: ") + describedCount + " / " + scope + "のフォルダの説明文を生成しました。" +
      (notes.length > 0 ? " (※ " + notes.join(" / ") + ")" : ""),
      notes.length > 0 ? TONE.WARNING : TONE.SUCCESS);
  }

  analyzeBtn.addEventListener("click", () => runAnalysis(null));
  analyzeStaleBtn.addEventListener("click", async () => {
    const stale = findStaleFolders(await chrome.bookmarks.getTree(), await getFolderDescriptions(), await getFolderMeta());
    await runAnalysis(new Set(stale.map(s => s.folderId)));
  });

  // 再解析が必要なフォルダ（説明文がない・ブックマーク数が大きく変わった）を、ローカルの比較だけで数える
  async function refreshStaleInfo() {
    const stale = findStaleFolders(await chrome.bookmarks.getTree(), await getFolderDescriptions(), await getFolderMeta());
    analyzeStaleBtn.disabled = stale.length === 0;
    if (stale.length === 0) {
      staleInfo.textContent = "すべてのフォルダが最新の状態で解析されています。";
      return;
    }
    const unanalyzed = stale.filter(s => s.reason === "未解析").length;
    staleInfo.textContent = "再解析が必要なフォルダ: " + stale.length + " 件（未解析 " + unanalyzed + " 件 / ブックマーク数が変化 " +
      (stale.length - unanalyzed) + " 件）。新しく作ったフォルダは、解析するまで「説明なし」としてAIに渡されます。";
  }

  async function renderCategoryTable() {
    const [descriptions, metaList] = [await getFolderDescriptions(), await getFolderMeta()];
    categoryCount.textContent = String(metaList.length);
    tableContainer.replaceChildren();
    if (metaList.length === 0) {
      tableContainer.textContent = "同期されたフォルダ構造データはありません。ボタンを押して解析してください。";
      return;
    }

    const rows = metaList.flatMap(folder => {
      const rowClass = folder.is_untouchable ? "category-row-untouchable" : "category-row-normal";
      const badges = [
        folder.is_quick_access ? h("span", { className: "attr-badge attr-badge-bar", text: "Bookmarkバー" }) : null,
        folder.is_untouchable ? h("span", { className: "attr-badge attr-badge-lock", text: "保護" }) : null
      ];
      return [
        // 上段: フォルダ名と属性バッジ | 説明文（2行ぶち抜き）
        h("tr", { className: rowClass },
          h("td", { className: "no-bottom-border" }, h("div", { className: "category-name" }, folder.folder_name, badges)),
          h("td", { className: "category-desc", text: descriptions[folder.folder_id] || (folder.is_untouchable ? PROTECTED_DESCRIPTION : "説明文未生成"), attrs: { rowspan: "2" } })),
        // 下段: 階層パス（折り返さず、溢れたら省略記号）
        h("tr", { className: rowClass },
          h("td", { className: "category-path no-top-border", text: folder.hierarchical_categories }))
      ];
    });

    tableContainer.append(h("table", { className: "category-table" },
      h("thead", {}, h("tr", {},
        h("th", { text: "カテゴリ", attrs: { style: "width: 40%" } }),
        h("th", { text: "説明文", attrs: { style: "width: 60%" } }))),
      h("tbody", {}, rows)));
  }

  async function refresh() {
    await Promise.all([renderCategoryTable(), refreshStaleInfo()]);
  }
  return { refresh };
}
