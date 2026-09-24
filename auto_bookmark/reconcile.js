// 保存データの整合処理: ブックマークの削除・改名・移動を、AIを呼ばずに保存データへ反映する（画面には依存しない）
//
// ブックマークの現在の状態を「正」とし、次の保存データを揃える。実行するのは、設定画面を開いたときと、
// ①②③の実行前だけ（ブックマークの変更イベントを契機とした即時の整理はしない）。
//   folder_descriptions_by_id … 存在しない・保護された（説明文を持たない）フォルダの説明文を削除
//   folder_meta_tree          … 存在しないフォルダの記録を削除。存在するフォルダは名前・パス・属性・件数を現在の値へ更新
//   page_knowledge_base       … 削除済みページのナレッジを削除、所属パスを現在の値へ更新（キーワード等は保持）
//   quick_folders             … 存在しないフォルダのIDを除外
// ブックマーク自体は一切変更しない。変更が無ければ何も書き込まない（何度実行しても同じ結果になる）。

import { listFolderStates } from "./bookmarks.js";
import { collectBookmarksForKb, reconcileKnowledgeBase } from "./knowledge.js";
import { KEYS } from "./storage.js";

// ---- 排他 ----
// ①フォルダ解析・③ナレッジ同期の実行中は、それぞれが保存データを書き換えるため、整合処理を開始しない
const runningOperations = new Set();
export const operationLock = Object.freeze({
  enter: name => runningOperations.add(name),
  leave: name => runningOperations.delete(name),
  isBusy: () => runningOperations.size > 0
});

/**
 * @typedef {{skipped: true}
 *   | {error: Error}
 *   | {removedFolders: number, changedFolders: number, removedKnowledge: number, updatedKnowledge: number, removedQuickFolders: number}} ReconcileResult
 *   removedFolders   … 削除済みフォルダの記録・説明文を取り除いた件数
 *   changedFolders   … 名前または階層パスが変わっていたため記録を更新したフォルダ数
 *   removedKnowledge … 削除済みページのナレッジを取り除いた件数
 *   updatedKnowledge … 所属パスを更新したナレッジの件数
 *   removedQuickFolders … クイック保存先から除いたフォルダ数
 */

/**
 * 保存データを現在のブックマークへ整合させる。失敗しても例外は投げず、{ error } を返す。
 * ①③の実行中は何もせず { skipped: true } を返す。
 * @returns {Promise<ReconcileResult>}
 */
export async function reconcileStorage() {
  if (operationLock.isBusy()) return { skipped: true };
  try {
    const tree = await chrome.bookmarks.getTree();
    const states = listFolderStates(tree);
    const stored = await chrome.storage.local.get([KEYS.FOLDER_DESCRIPTIONS, KEYS.FOLDER_META, KEYS.QUICK_FOLDERS]);
    const changes = {};
    const removedFolderIds = new Set(); // 存在しなくなったフォルダのID（説明文・記録の両方を通して重複なく数える）

    // 説明文: 現在存在し、保護されていないフォルダの分だけ残す（保護フォルダの中身は解析・送信しないため、説明文も持たない）
    const descriptions = stored[KEYS.FOLDER_DESCRIPTIONS] || {};
    const keptDescriptions = {};
    for (const [folderId, description] of Object.entries(descriptions)) {
      const state = states.get(folderId);
      if (state && !state.isUntouchable) keptDescriptions[folderId] = description;
      else if (!state) removedFolderIds.add(folderId);
    }
    if (Object.keys(keptDescriptions).length !== Object.keys(descriptions).length) changes[KEYS.FOLDER_DESCRIPTIONS] = keptDescriptions;

    // フォルダ構造の記録: 存在するものだけを残し、現在の値へ更新する。
    // analyzed_name / analyzed_path（説明文を生成した時点の値）は、無ければ更新前の値で補う（旧形式のデータで誤検知しないため）
    const metaList = Array.isArray(stored[KEYS.FOLDER_META]) ? stored[KEYS.FOLDER_META] : [];
    const nextMetaList = [];
    let changedFolders = 0;
    let metaNeedsWrite = false;
    for (const meta of metaList) {
      const state = states.get(meta.folder_id);
      if (!state) {
        removedFolderIds.add(meta.folder_id);
        metaNeedsWrite = true;
        continue;
      }
      const next = {
        ...meta,
        folder_name: state.name,
        hierarchical_categories: state.path,
        is_quick_access: state.isQuickAccess,
        is_untouchable: state.isUntouchable,
        entry_count: state.entryCount,
        analyzed_name: meta.analyzed_name ?? meta.folder_name,
        analyzed_path: meta.analyzed_path ?? meta.hierarchical_categories
      };
      if (meta.folder_name !== next.folder_name || meta.hierarchical_categories !== next.hierarchical_categories) changedFolders++;
      if (JSON.stringify(meta) !== JSON.stringify(next)) metaNeedsWrite = true;
      nextMetaList.push(next);
    }
    if (metaNeedsWrite) changes[KEYS.FOLDER_META] = nextMetaList;

    // クイック保存先: 存在しないフォルダを除く
    const quickFolders = Array.isArray(stored[KEYS.QUICK_FOLDERS]) ? stored[KEYS.QUICK_FOLDERS] : null;
    let removedQuickFolders = 0;
    if (quickFolders) {
      const kept = quickFolders.filter(folderId => states.has(folderId));
      removedQuickFolders = quickFolders.length - kept.length;
      if (removedQuickFolders > 0) changes[KEYS.QUICK_FOLDERS] = kept;
    }

    if (Object.keys(changes).length > 0) await chrome.storage.local.set(changes);

    // ページ知識（保存直前に読み直して更新するため、設定画面でのタグ編集と競合しない）
    const knowledge = await reconcileKnowledgeBase(collectBookmarksForKb(tree));

    return {
      removedFolders: removedFolderIds.size,
      changedFolders,
      removedKnowledge: knowledge.removed,
      updatedKnowledge: knowledge.updated,
      removedQuickFolders
    };
  } catch (error) {
    return { error };
  }
}

/** 整合の結果を、利用者向けの通知文にする。反映した内容が無ければ空文字 */
export function describeReconcile(result) {
  if (!result || result.skipped || result.error) return "";
  const parts = [];
  if (result.removedFolders > 0) parts.push("削除済みフォルダ " + result.removedFolders + " 件の保存データを整理");
  if (result.changedFolders > 0) parts.push("名前・場所が変わったフォルダ " + result.changedFolders + " 件を最新化");
  if (result.removedKnowledge > 0) parts.push("削除済みページのナレッジ " + result.removedKnowledge + " 件を整理");
  if (result.updatedKnowledge > 0) parts.push("ナレッジの所属パス " + result.updatedKnowledge + " 件を更新");
  if (result.removedQuickFolders > 0) parts.push("クイック保存先から削除済みフォルダ " + result.removedQuickFolders + " 件を除外");
  return parts.length > 0 ? "保存データを現在のブックマークに合わせました（" + parts.join("、") + "）。" : "";
}
