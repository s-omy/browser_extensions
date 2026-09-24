// ③ ページ知識（ナレッジベース）: 同期計画・AIによる推定ナレッジの取得と保存（画面には依存しない）
//
// ナレッジの出所（source）
//   ai_estimate … URLとタイトルからのAI推定。ページ本文は取得していない
//   page_meta   … 右クリック時に実際のページから読み取った meta タグ（description / keywords）

import { collectFolderInfos, getFolderPathMap, UNCLASSIFIED_FOLDER_NAME } from "./bookmarks.js";
import { fetchKnowledgeBatch } from "./ai-tasks.js";
import { isAiSendableUrl } from "./privacy.js";
import { KB_BATCH_SIZE, KB_TTL_MS } from "./config.js";
import { normalizeKeywords } from "./keywords.js";
import { KEYS, getKnowledgeBase } from "./storage.js";

export const KNOWLEDGE_SOURCE = Object.freeze({ AI_ESTIMATE: "ai_estimate", PAGE_META: "page_meta" });
const SUBJECT_MAX_CHARS = 80;
const SUMMARY_MAX_CHARS = 200;

/**
 * ブックマークツリーから、同期対象の一覧をURL単位で重複排除して作る。
 * 同じURLが複数フォルダにある場合は、最初に見つかった1件のフォルダパスを代表として採用する。
 * isProtected は、保護フォルダ（[ ] 囲みとその配下）にあるブックマークか。
 */
export function collectBookmarksForKb(bookmarkTree) {
  const pathMap = getFolderPathMap(bookmarkTree);
  const protectedFolderIds = new Set(collectFolderInfos(bookmarkTree).filter(f => f.isUntouchable).map(f => f.id));
  const bookmarksByUrl = new Map();
  (function walk(nodes) {
    for (const node of nodes) {
      if (node.url && !bookmarksByUrl.has(node.url)) {
        bookmarksByUrl.set(node.url, {
          url: node.url,
          title: node.title,
          hierarchical_categories: pathMap.get(node.parentId) || UNCLASSIFIED_FOLDER_NAME,
          isProtected: protectedFolderIds.has(node.parentId)
        });
      }
      if (node.children) walk(node.children);
    }
  })(bookmarkTree);
  return [...bookmarksByUrl.values()];
}

/**
 * 同期計画を立てる（ローカル計算のみでAPIは呼ばない）。
 *   toFetch       … AIへの問い合わせが必要（新規・期限切れ）
 *   pathOnly      … 内容は最新で、フォルダパスだけが変わった（AI不要。パス欄の更新だけで済む）
 *   staleUrls     … ブックマークから削除済みで、ナレッジだけ残っているURL
 *   excludedCount … AIへ送れない（http/https以外・除外ドメイン・保護フォルダ内）ため対象外にした件数
 */
export async function computeKbSyncPlan(privacy) {
  const knowledgeBase = await getKnowledgeBase();
  const bookmarks = collectBookmarksForKb(await chrome.bookmarks.getTree());
  const now = Date.now();

  const toFetch = [];
  const pathOnly = [];
  const liveUrls = new Set();
  let newCount = 0;
  let expiredCount = 0;
  let excludedCount = 0;

  for (const bookmark of bookmarks) {
    liveUrls.add(bookmark.url);
    const cache = knowledgeBase[bookmark.url];
    const isMissing = !cache;
    const isExpired = !!cache && now - cache.last_updated_at > KB_TTL_MS;

    if (isMissing || isExpired) {
      if (bookmark.isProtected || !isAiSendableUrl(bookmark.url, privacy)) {
        excludedCount++;
        continue;
      }
      toFetch.push(bookmark);
      if (isMissing) newCount++; else expiredCount++;
    } else if (cache.hierarchical_categories !== bookmark.hierarchical_categories) {
      pathOnly.push(bookmark);
    }
  }
  const staleUrls = Object.keys(knowledgeBase).filter(url => !liveUrls.has(url));
  return { toFetch, pathOnly, staleUrls, newCount, expiredCount, excludedCount };
}

// 設定画面でのタグ編集と競合しないよう、保存直前にストレージを読み直してから変更する
async function updateKnowledgeBase(mutate) {
  const knowledgeBase = await getKnowledgeBase();
  if (mutate(knowledgeBase) === false) return; // 変更が無いときは書き込まない
  await chrome.storage.local.set({ [KEYS.KNOWLEDGE_BASE]: knowledgeBase });
}

/** AIを使わない更新（パスのみの変更の反映・削除済みURLの整理）を保存する */
export async function applyLocalKbUpdates(plan) {
  if (plan.pathOnly.length === 0 && plan.staleUrls.length === 0) return;
  await updateKnowledgeBase(knowledgeBase => {
    for (const bookmark of plan.pathOnly) {
      if (knowledgeBase[bookmark.url]) knowledgeBase[bookmark.url].hierarchical_categories = bookmark.hierarchical_categories;
    }
    for (const url of plan.staleUrls) delete knowledgeBase[url];
  });
}

/**
 * ナレッジを現在のブックマークへ整合させる（APIは呼ばない）。削除済みページのナレッジを取り除き、
 * 所属パスを現在の値へ更新する。キーワードなど他の項目（利用者が編集したタグを含む）は変更しない。
 * 変更が無ければ何も書き込まない。
 * @param {ReturnType<typeof collectBookmarksForKb>} bookmarks 現在のブックマーク（collectBookmarksForKb の結果）
 * @returns {Promise<{removed: number, updated: number}>}
 */
export async function reconcileKnowledgeBase(bookmarks) {
  const livePaths = new Map(bookmarks.map(bookmark => [bookmark.url, bookmark.hierarchical_categories]));
  let removed = 0;
  let updated = 0;
  await updateKnowledgeBase(knowledgeBase => {
    removed = 0;
    updated = 0;
    for (const url of Object.keys(knowledgeBase)) {
      if (!livePaths.has(url)) {
        delete knowledgeBase[url];
        removed++;
      } else if (knowledgeBase[url].hierarchical_categories !== livePaths.get(url)) {
        knowledgeBase[url].hierarchical_categories = livePaths.get(url);
        updated++;
      }
    }
    return removed + updated > 0; // false を返すと書き込まない
  });
  return { removed, updated };
}

/**
 * 同期計画の toFetch を、KB_BATCH_SIZE 件ずつAIに問い合わせて保存する。
 * バッチごとに保存する（途中で中断しても、保存済みの分は再課金されない）。
 * @param {object} options
 * @param {() => boolean} [options.shouldStop] trueを返すと、次のバッチの前で停止する
 * @param {(progress: {processed: number, total: number}) => void} [options.onProgress]
 * @returns {Promise<{savedCount: number, failedItems: {url: string, reason: string}[], fatal: Error|null}>}
 */
export async function runKbSync({ connection, plan, privacy, shouldStop = () => false, onProgress = () => {} }) {
  let savedCount = 0;
  let processed = 0;
  const failedItems = [];
  let fatal = null;

  for (let start = 0; start < plan.toFetch.length; start += KB_BATCH_SIZE) {
    if (shouldStop()) break;
    const chunk = plan.toFetch.slice(start, start + KB_BATCH_SIZE);
    const outcome = await fetchKnowledgeBatch(connection, chunk, privacy);

    if (outcome.done.size > 0) {
      const now = Date.now();
      await updateKnowledgeBase(knowledgeBase => {
        for (const bookmark of chunk) {
          const knowledge = outcome.done.get(bookmark.url);
          if (!knowledge) continue;
          knowledgeBase[bookmark.url] = {
            ...knowledge,
            hierarchical_categories: bookmark.hierarchical_categories,
            last_updated_at: now,
            source: KNOWLEDGE_SOURCE.AI_ESTIMATE
          };
        }
      });
    }
    savedCount += outcome.done.size;
    failedItems.push(...outcome.failed);
    processed += chunk.length;
    onProgress({ processed, total: plan.toFetch.length });

    if (outcome.fatal) {
      fatal = outcome.fatal;
      break;
    }
  }
  return { savedCount, failedItems, fatal };
}

/**
 * 右クリック時に読み取れた実際のページの meta 情報を、ナレッジとして保存する（APIは呼ばない）。
 * 同期（③）が同じURLをもう一度AIに問い合わせて課金するのを防ぐ。既にナレッジがあるURLは上書きしない。
 * @param {{description: string, keywords: string}} meta
 * @returns {Promise<boolean>} 保存したか
 */
export async function recordPageMetaKnowledge({ url, title, meta, path }) {
  if (!meta || (!meta.description && !meta.keywords)) return false;
  let saved = false;
  await updateKnowledgeBase(knowledgeBase => {
    if (knowledgeBase[url]) return;
    knowledgeBase[url] = {
      subject: (title || "").slice(0, SUBJECT_MAX_CHARS),
      summary: meta.description.slice(0, SUMMARY_MAX_CHARS),
      description: meta.description,
      keywords: normalizeKeywords(meta.keywords), // サイトごとに書き方（空白・読点・カンマ）が違うため、1語ずつにそろえる
      hierarchical_categories: path || UNCLASSIFIED_FOLDER_NAME,
      last_updated_at: Date.now(),
      source: KNOWLEDGE_SOURCE.PAGE_META
    };
    saved = true;
  });
  return saved;
}
