// ① フォルダ解析: フォルダごとの説明文をAIで生成し、ストレージへ保存する（画面には依存しない）

import { extractFolders } from "./bookmarks.js";
import { describeFolders } from "./ai-tasks.js";
import { ANALYZE_FOLDERS_PER_BATCH, STALE_COUNT_MIN_DIFF, STALE_COUNT_RATIO } from "./config.js";
import { KEYS, getFolderDescriptions, getFolderMeta } from "./storage.js";

/**
 * 再解析が必要なフォルダを、ローカルの比較だけで求める（APIは呼ばない）。
 *   未解析 … 説明文がまだない（新しく作ったフォルダなど）
 *   変更   … 前回の解析後に、ブックマーク数が大きく増減した
 * @returns {{folderId: string, folderName: string, reason: "未解析"|"変更"}[]}
 */
export function findStaleFolders(bookmarkTree, descriptions, metaList) {
  const metaById = new Map(metaList.map(meta => [meta.folder_id, meta]));
  const stale = [];
  for (const folder of extractFolders(bookmarkTree)) {
    if (folder.is_untouchable) continue; // 保護フォルダは解析しない（中身をAIに送らない）
    if (!descriptions[folder.folder_id]) {
      stale.push({ folderId: folder.folder_id, folderName: folder.folder_name, reason: "未解析" });
      continue;
    }
    const analyzedCount = metaById.get(folder.folder_id)?.analyzed_entry_count;
    if (typeof analyzedCount === "number") {
      const threshold = Math.max(STALE_COUNT_MIN_DIFF, Math.ceil(analyzedCount * STALE_COUNT_RATIO));
      if (Math.abs(folder.entries.length - analyzedCount) >= threshold) {
        stale.push({ folderId: folder.folder_id, folderName: folder.folder_name, reason: "変更" });
      }
    }
  }
  return stale;
}

/**
 * フォルダの説明文を生成して保存する。全フォルダを1リクエストに詰め込まず、
 * ANALYZE_FOLDERS_PER_BATCH フォルダずつのバッチで処理し、バッチごとに保存する
 * （途中で中断されても、生成済みの分は失われない）。
 * 生成できなかったフォルダは、以前の説明文があればそれを引き継ぐ。
 * 保護フォルダ（[ ] 囲みとその配下）は、中身をAIに送らないよう解析の対象外にする。
 * @param {object} options
 * @param {Set<string>|null} [options.onlyFolderIds] 指定すると、そのフォルダだけを解析する（増分解析）
 * @param {(progress: {batchNo: number, batchCount: number, done: number, total: number}) => void} [options.onProgress]
 * @returns {Promise<{totalFolders: number, targetCount: number, describedCount: number,
 *   failed: {folderId: string, folderName: string, reason: string}[], fatal: Error|null}>}
 *   totalFolders は解析対象になりうるフォルダ数（保護フォルダを除く）、targetCount は今回実際に解析したフォルダ数
 */
export async function analyzeFolders({ connection, bookmarkTree, privacy, onlyFolderIds = null, onProgress = () => {} }) {
  const extractedFolders = extractFolders(bookmarkTree);
  const allFolders = extractedFolders.filter(folder => !folder.is_untouchable);
  if (extractedFolders.length === 0) throw new Error("解析対象のフォルダが見つかりませんでした。");
  if (allFolders.length === 0) throw new Error("解析できるフォルダがありません（すべて保護フォルダです）。");

  const previousDescriptions = await getFolderDescriptions();
  const previousMeta = new Map((await getFolderMeta()).map(meta => [meta.folder_id, meta]));

  const targets = onlyFolderIds ? allFolders.filter(f => onlyFolderIds.has(f.folder_id)) : allFolders;
  const describedById = new Map();
  const failed = [];
  let fatal = null;
  const batchCount = Math.ceil(targets.length / ANALYZE_FOLDERS_PER_BATCH);

  // 現在のフォルダだけを対象に、フォルダID → 説明文を組み立てる（削除済みフォルダの説明文はここで消える）
  const buildDescriptions = () => {
    const descriptions = {};
    for (const folder of allFolders) {
      const description = describedById.get(folder.folder_id) ?? previousDescriptions[folder.folder_id];
      if (description) descriptions[folder.folder_id] = description;
    }
    return descriptions;
  };

  for (let start = 0; start < targets.length; start += ANALYZE_FOLDERS_PER_BATCH) {
    onProgress({ batchNo: start / ANALYZE_FOLDERS_PER_BATCH + 1, batchCount, done: start, total: targets.length });

    const outcome = await describeFolders(connection, targets.slice(start, start + ANALYZE_FOLDERS_PER_BATCH), privacy);
    outcome.descriptions.forEach((description, folderId) => describedById.set(folderId, description));
    failed.push(...outcome.failed);
    await chrome.storage.local.set({ [KEYS.FOLDER_DESCRIPTIONS]: buildDescriptions() });

    if (outcome.fatal) {
      fatal = outcome.fatal;
      break;
    }
  }

  // 階層パス・属性・件数は、全フォルダ分を最新の状態で保存する。
  // 「解析時の件数」は、今回説明文を生成したフォルダだけ更新する（他は以前の値を保つ）
  await chrome.storage.local.set({
    [KEYS.FOLDER_DESCRIPTIONS]: buildDescriptions(),
    [KEYS.FOLDER_META]: extractedFolders.map(folder => ({
      folder_id: folder.folder_id,
      folder_name: folder.folder_name,
      hierarchical_categories: folder.hierarchical_categories,
      is_quick_access: folder.is_quick_access,
      is_untouchable: folder.is_untouchable,
      entry_count: folder.entries.length,
      analyzed_entry_count: describedById.has(folder.folder_id) ?
        folder.entries.length :
        previousMeta.get(folder.folder_id)?.analyzed_entry_count
    }))
  });

  return {
    totalFolders: allFolders.length,
    targetCount: targets.length,
    describedCount: describedById.size,
    failed,
    fatal
  };
}
