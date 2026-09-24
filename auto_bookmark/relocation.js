// ② 再カテゴライズ: シミュレーション（AIによる移動案の作成）・実適用・取り消し（画面には依存しない）

import { buildFolderCandidates, extractFolders, getProtectedFolderIds } from "./bookmarks.js";
import { judgeRelocationChunk } from "./ai-tasks.js";
import { GeminiError, describeGeminiError } from "./gemini.js";
import { isAiSendableUrl } from "./privacy.js";
import { RELOCATE_CHUNK_SIZE, MAX_CONSECUTIVE_API_FAILURES, UNDO_SAVE_INTERVAL } from "./config.js";
import { KEYS } from "./storage.js";

const REASON_NOT_SENDABLE = "AI送信対象外のURL（http/https以外、または除外ドメイン）のため現状維持";
const REASON_BLOCKED = "【判定不能】コンテンツがAIセーフティに検知されたため、安全のために現状維持としました。";
const REASON_TARGET_NOT_CANDIDATE = "移動先が候補にないフォルダのため現状維持";

/**
 * 判定できなかったブックマークを「現状維持・未評価」として表す。
 * confidence_score を null にすることで、失敗を「適合率100%」と誤認させない。
 */
function keepInPlace(bookmark, reason) {
  return {
    id: bookmark.id,
    title: bookmark.title,
    url: bookmark.url,
    current_category: bookmark.current_category,
    current_folder_id: bookmark.current_folder_id,
    target_category: bookmark.current_category,
    target_folder_id: bookmark.current_folder_id,
    confidence_score: null,
    reason
  };
}

/** 移動案が「移動あり」か。同名フォルダ間の移動も検出できるよう、名前ではなくフォルダIDで比べる */
export function isMoved(decision) {
  return decision.current_folder_id !== decision.target_folder_id;
}

/**
 * シミュレーションの実行計画を立てる（ローカル計算のみでAPIは呼ばない）。
 * 保護フォルダは対象から外し、AIへ送れないURLのブックマークは判定せず現状維持にする。
 * @throws {Error} 処理対象がない場合
 */
export function planRelocation(bookmarkTree, privacy) {
  const extracted = extractFolders(bookmarkTree);
  if (extracted.length === 0) throw new Error("処理対象のエントリが存在しません。");

  const targetFolders = extracted.filter(folder => !folder.is_untouchable);
  if (targetFolders.length === 0) throw new Error("移動対象のブックマークがありません（すべて保護フォルダです）。");

  let totalBookmarks = 0;
  let chunkTotal = 0;
  const folderPlans = targetFolders.map(folder => {
    const sendable = folder.entries.filter(entry => isAiSendableUrl(entry.url, privacy));
    const unsendable = folder.entries.filter(entry => !isAiSendableUrl(entry.url, privacy));
    totalBookmarks += folder.entries.length;
    chunkTotal += Math.ceil(sendable.length / RELOCATE_CHUNK_SIZE);
    return { folder, sendable, unsendable };
  });

  return {
    bookmarkTree,
    folderPlans,
    totalBookmarks,
    chunkTotal,
    protectedSkippedCount: extracted.length - targetFolders.length
  };
}

/**
 * 計画に沿って、フォルダ内を RELOCATE_CHUNK_SIZE 件ずつのチャンクに分けてAIに判定させる。
 * 失敗したチャンクは現状維持（未評価）にし、APIが連続して失敗したら残りを中断する。
 * @param {object} options
 * @param {Object<string, string>} options.descriptions フォルダID → 説明文
 * @param {Object<string, object>} options.knowledgeBase URL → ページ知識
 * @param {(progress: {processedChunks: number, chunkTotal: number, folderName: string}) => void} [options.onProgress]
 * @returns {Promise<{decisions: object[], stats: {prohibitedFolderIds: Set<string>, failedFolders: Map<string, string>,
 *   abortedRemainingBookmarks: number, excludedCount: number}}>}
 */
export async function runRelocationSimulation({ connection, plan, descriptions, knowledgeBase, privacy, onProgress = () => {} }) {
  const categories = buildFolderCandidates(plan.bookmarkTree, descriptions);
  const candidateFolderIds = categories.map(c => c.folder_id);
  const folderNameById = new Map(categories.map(c => [c.folder_id, c.folder_name]));

  const decisions = [];
  const stats = { prohibitedFolderIds: new Set(), failedFolders: new Map(), abortedRemainingBookmarks: 0, excludedCount: 0 };
  let consecutiveApiFailures = 0;
  let processedChunks = 0;
  let processedBookmarks = 0;
  const sendableTotal = plan.folderPlans.reduce((sum, p) => sum + p.sendable.length, 0);

  const toBookmark = (folder, entry) => ({
    id: entry.id, // 物理ブックマークID（chrome.bookmarks.move に渡す本物のID）
    title: entry.title,
    url: entry.url,
    current_category: folder.folder_name,
    current_folder_id: folder.folder_id
  });

  folderLoop:
  for (const { folder, sendable, unsendable } of plan.folderPlans) {
    for (const entry of unsendable) {
      decisions.push(keepInPlace(toBookmark(folder, entry), REASON_NOT_SENDABLE));
      stats.excludedCount++;
    }

    for (let start = 0; start < sendable.length; start += RELOCATE_CHUNK_SIZE) {
      onProgress({ processedChunks, chunkTotal: plan.chunkTotal, folderName: folder.folder_name });

      // チャンク内のアイテムに、このリクエスト内でだけ有効な連番（seq）を振る。
      // AIには連番だけを渡し、返ってきた連番から実ブックマークIDを引き当てる
      // （URLやタイトルの一致に頼らないため、重複URL・同名フォルダでも取り違えない）
      const chunk = sendable.slice(start, start + RELOCATE_CHUNK_SIZE)
        .map((entry, index) => ({ ...toBookmark(folder, entry), seq: String(index + 1) }));

      try {
        const relocations = await judgeRelocationChunk({ connection, chunk, categories, candidateFolderIds, knowledgeBase, privacy });
        consecutiveApiFailures = 0;

        const bookmarkBySeq = new Map(chunk.map(b => [b.seq, b]));
        for (const r of relocations) {
          const source = bookmarkBySeq.get(r.id);
          const targetName = folderNameById.get(r.target_folder_id);
          if (!targetName) {
            // 保護フォルダや存在しないフォルダが返された場合は移動させない
            decisions.push(keepInPlace(source, REASON_TARGET_NOT_CANDIDATE));
            continue;
          }
          // 項目のID・title・url・現在フォルダは、AIの返答ではなくコード側の元データから復元する
          decisions.push({
            id: source.id,
            title: source.title,
            url: source.url,
            current_category: source.current_category,
            current_folder_id: source.current_folder_id,
            target_category: targetName,
            target_folder_id: r.target_folder_id,
            confidence_score: r.confidence_score,
            reason: r.reason
          });
        }
      } catch (chunkError) {
        console.warn("チャンク単位のシミュレーション失敗:", folder.folder_name, chunkError);
        if (chunkError instanceof GeminiError && chunkError.kind === "blocked") {
          // セーフティ拒否。判定不能なエントリは、現状維持（target = current）・未評価として安全に救済
          stats.prohibitedFolderIds.add(folder.folder_id);
          consecutiveApiFailures = 0;
          chunk.forEach(b => decisions.push(keepInPlace(b, REASON_BLOCKED)));
        } else {
          // 通信・応答エラー。現状維持（未評価）で救済し、失敗したフォルダとして記録する
          const failReason = describeGeminiError(chunkError) + "のため判定できず現状維持";
          stats.failedFolders.set(folder.folder_id, folder.folder_name);
          chunk.forEach(b => decisions.push(keepInPlace(b, failReason)));

          // APIが連続して失敗する場合（キー不正・上限超過など）は、残りを試しても無駄なので中断する
          const isApiFailure = chunkError instanceof GeminiError && (chunkError.kind === "http" || chunkError.kind === "network");
          consecutiveApiFailures = isApiFailure ? consecutiveApiFailures + 1 : 0;
          if (consecutiveApiFailures >= MAX_CONSECUTIVE_API_FAILURES) {
            stats.abortedRemainingBookmarks = sendableTotal - processedBookmarks - chunk.length;
            break folderLoop;
          }
        }
      }
      processedChunks++;
      processedBookmarks += chunk.length;
    }
  }

  return { decisions, stats };
}

// ---- 実適用と取り消し ----

/** @returns {Promise<{applied_at: number, moves: object[]}|null>} 直前の一括適用の記録 */
export async function getUndoRecord() {
  const stored = await chrome.storage.local.get(KEYS.UNDO);
  const record = stored[KEYS.UNDO];
  return record && record.moves && record.moves.length > 0 ? record : null;
}

async function saveUndoRecord(appliedAt, moves) {
  await chrome.storage.local.set({ [KEYS.UNDO]: { applied_at: appliedAt, moves } });
}

/**
 * 選択された移動案を、実際のブックマークへ適用する。
 * 1件の失敗（削除済みなど）で残りを止めないよう、項目ごとに処理する。
 * 適用直前の最新ツリーから保護フォルダを再計算し、移動元・移動先が保護フォルダなら移動しない。
 * 移動前の親フォルダ・位置を1件ずつ記録し、取り消せるようにする。
 * @returns {Promise<{movedCount: number, guardedCount: number, failedCount: number}>}
 */
export async function applyRelocation(tasks) {
  const appliedAt = Date.now();
  const undoMoves = [];
  let guardedCount = 0;
  let failedCount = 0;

  try {
    const protectedIds = await getProtectedFolderIds();
    for (const task of tasks) {
      try {
        const [current] = await chrome.bookmarks.get(task.id);
        if (protectedIds.has(current.parentId) || protectedIds.has(task.target_folder_id)) {
          guardedCount++;
          continue;
        }
        // 移動先はIDで指定した既存フォルダのみ（フォルダの新規作成は行わない）
        await chrome.bookmarks.move(task.id, { parentId: task.target_folder_id });
        undoMoves.push({
          id: task.id,
          title: task.title,
          fromParentId: current.parentId,
          fromIndex: current.index,
          toParentId: task.target_folder_id
        });
        // タブを閉じられても取り消せるよう、一定件数ごとに途中経過を保存する
        if (undoMoves.length % UNDO_SAVE_INTERVAL === 0) await saveUndoRecord(appliedAt, undoMoves);
      } catch (itemError) {
        failedCount++;
        console.warn("ブックマークの移動に失敗:", task.id, itemError);
      }
    }
  } finally {
    if (undoMoves.length > 0) await saveUndoRecord(appliedAt, undoMoves);
  }
  return { movedCount: undoMoves.length, guardedCount, failedCount };
}

/**
 * 直前の一括適用を取り消す。適用と逆の順序で戻すことで、記録した位置（index）を正しく復元できる。
 * 適用後にユーザー自身が動かした項目は上書きしない。
 * @returns {Promise<{restoredCount: number, changedSinceCount: number, guardedCount: number, failedCount: number}>}
 */
export async function undoRelocation() {
  const record = await getUndoRecord();
  if (!record) return { restoredCount: 0, changedSinceCount: 0, guardedCount: 0, failedCount: 0 };

  let restoredCount = 0;
  let changedSinceCount = 0;
  let guardedCount = 0;
  let failedCount = 0;
  const protectedIds = await getProtectedFolderIds();

  for (const move of [...record.moves].reverse()) {
    try {
      const [current] = await chrome.bookmarks.get(move.id);
      if (current.parentId !== move.toParentId) {
        changedSinceCount++;
        continue;
      }
      if (protectedIds.has(move.fromParentId) || protectedIds.has(current.parentId)) {
        guardedCount++;
        continue;
      }
      try {
        await chrome.bookmarks.move(move.id, { parentId: move.fromParentId, index: move.fromIndex });
      } catch (indexError) {
        // 位置が範囲外になっていた場合は、元のフォルダの末尾に戻す
        await chrome.bookmarks.move(move.id, { parentId: move.fromParentId });
      }
      restoredCount++;
    } catch (itemError) {
      failedCount++;
      console.warn("取り消しに失敗:", move.id, itemError);
    }
  }
  await chrome.storage.local.remove(KEYS.UNDO);
  return { restoredCount, changedSinceCount, guardedCount, failedCount };
}
