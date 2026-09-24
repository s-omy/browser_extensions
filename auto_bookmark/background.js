// サービスワーカー: 右クリックメニュー・ショートカット・ツールバーアイコンからのブックマーク登録
//
// 登録の流れ（自動振り分け）
//   重複チェック → 送信可否チェック → ページmeta取得 → 無毒化 → AIで振り分け先を判定 → 登録 → 通知
// 判定に失敗した場合や確信度が低い場合は、推測で振り分けず「未分類」に入れ、その理由を通知する。

import { cleanseText, categorizePage } from "./ai-tasks.js";
import {
  UNCLASSIFIED_FOLDER_NAME,
  UNTITLED_LABEL,
  buildFolderCandidates,
  findOrCreateFolderByName,
  getFolderPathMap
} from "./bookmarks.js";
import { KEYS, getLlmConnection, getFolderDescriptions, getPrivacySettings, getQuickFolderIds, migrateLegacyStorage } from "./storage.js";
import { isAiSendableUrl, sanitizeUrlForAi } from "./privacy.js";
import { recordPageMetaKnowledge } from "./knowledge.js";
import { MAX_QUICK_FOLDERS, MIN_AUTO_FILE_CONFIDENCE, RECENT_ACTIONS_LIMIT } from "./config.js";

const MENU_ROOT = "parent-bookmark";
const MENU_AUTO = "auto-sort";
const MENU_UNCLASSIFIED = "unclassified";
const MENU_QUICK_PREFIX = "quick:";
const MENU_SEPARATOR = "separator";
const COMMAND_AUTO_SORT = "auto-sort-current-tab";
const MENU_CONTEXTS = ["page", "tab"];
const SESSION_RECENT_ACTIONS = "recent_actions"; // 通知の「元に戻す」用に、直近の保存を覚えておく（ブラウザ終了で消える）

// ---- 右クリックメニュー ----

// メニューの作り直しが重なって項目が重複しないよう、直列に実行する
let menuQueue = Promise.resolve();
function queueMenuRebuild() {
  menuQueue = menuQueue.then(rebuildContextMenus).catch(error => console.warn("メニューの構築に失敗:", error));
  return menuQueue;
}

// 「&」はメニューのアクセスキーを表す記号になるため、フォルダ名に含まれる場合はエスケープする
const escapeMenuTitle = title => title.replace(/&/g, "&&");

async function rebuildContextMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: MENU_ROOT, title: "📑ブックマーク", contexts: MENU_CONTEXTS });
  chrome.contextMenus.create({ id: MENU_AUTO, parentId: MENU_ROOT, title: "最適カテゴリへ追加", contexts: MENU_CONTEXTS });
  chrome.contextMenus.create({ id: MENU_UNCLASSIFIED, parentId: MENU_ROOT, title: UNCLASSIFIED_FOLDER_NAME + "に追加", contexts: MENU_CONTEXTS });

  // クイック保存先は、設定画面で選んだフォルダ（IDで保持しているため、フォルダ名を変えても追従する）
  let hasSeparator = false;
  for (const folderId of (await getQuickFolderIds()).slice(0, MAX_QUICK_FOLDERS)) {
    let node;
    try {
      [node] = await chrome.bookmarks.get(folderId);
    } catch (error) {
      continue; // 削除済みのフォルダは載せない
    }
    if (node.url) continue;
    if (!hasSeparator) {
      chrome.contextMenus.create({ id: MENU_SEPARATOR, parentId: MENU_ROOT, type: "separator", contexts: MENU_CONTEXTS });
      hasSeparator = true;
    }
    chrome.contextMenus.create({
      id: MENU_QUICK_PREFIX + folderId,
      parentId: MENU_ROOT,
      title: escapeMenuTitle(node.title),
      contexts: MENU_CONTEXTS
    });
  }
}

chrome.runtime.onInstalled.addListener(details => {
  queueMenuRebuild();
  migrateLegacyStorage().catch(error => console.warn("データ移行に失敗:", error));
  if (details.reason === "install") chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => queueMenuRebuild());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[KEYS.QUICK_FOLDERS]) queueMenuRebuild();
});
chrome.bookmarks.onChanged.addListener(() => queueMenuRebuild());
chrome.bookmarks.onRemoved.addListener(() => queueMenuRebuild());

chrome.contextMenus.onClicked.addListener((info, tab) => handleBookmarkRequest(info.menuItemId, tab, info.pageUrl));

// ツールバーアイコンのクリックとショートカットキーは、どちらも「最適カテゴリへ追加」を実行する
chrome.action.onClicked.addListener(tab => handleBookmarkRequest(MENU_AUTO, tab));
chrome.commands.onCommand.addListener(async command => {
  if (command !== COMMAND_AUTO_SORT) return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) await handleBookmarkRequest(MENU_AUTO, tab);
});

// ---- ブックマーク登録 ----

/**
 * メニュー項目に応じてブックマークを登録し、結果を通知する。
 * @param {string} menuItemId MENU_AUTO / MENU_UNCLASSIFIED / "quick:<フォルダID>"
 */
async function handleBookmarkRequest(menuItemId, tab, pageUrl) {
  const url = pageUrl || tab?.url;
  const title = tab?.title || UNTITLED_LABEL;
  if (!url) {
    await showNotification("ブックマークできませんでした", "ページのURLを取得できませんでした。");
    return;
  }

  const progressId = "bookmark-progress-" + Date.now();
  try {
    await migrateLegacyStorage();
    const target = await resolveTarget(menuItemId, { tab, url, title, progressId });

    if (target.duplicate) {
      chrome.notifications.clear(progressId);
      await showNotification("すでにブックマーク済みです", "「" + target.duplicate.folderName + "」に保存されています。\n" + title);
      return;
    }

    // ブックマークの物理登録
    const created = await chrome.bookmarks.create({ parentId: target.folderId, title, url });
    chrome.notifications.clear(progressId);

    // 実際のページから読み取れたmeta情報は、ナレッジとして保存する（③の同期で同じURLを再課金しないため）
    if (target.pageMeta) {
      const tree = await chrome.bookmarks.getTree();
      await recordPageMetaKnowledge({ url, title, meta: target.pageMeta, path: getFolderPathMap(tree).get(target.folderId) });
    }

    await notifySaved({
      created,
      folderName: target.folderName,
      title: target.notice ? target.notice.title : "「" + target.folderName + "」にブックマークしました。",
      message: target.notice ? target.notice.message : title
    });
  } catch (error) {
    // 想定外の例外でも進捗通知を残さず、失敗を成功と誤認させない
    console.error(">> ブックマーク登録処理でエラーが発生しました:", error);
    chrome.notifications.clear(progressId);
    await showNotification("ブックマークの保存に失敗しました", title + "\n理由: " + error.message);
  }
}

/**
 * 保存先フォルダを決める。
 * @returns {Promise<{folderId: string, folderName: string, notice?: {title: string, message: string}, pageMeta?: object}
 *   | {duplicate: {folderName: string}}>}
 */
async function resolveTarget(menuItemId, { tab, url, title, progressId }) {
  if (menuItemId === MENU_AUTO) return resolveAutoTarget({ tab, url, title, progressId });

  await showProgress(progressId, "ブックマーク保存中", title, 50);
  if (menuItemId === MENU_UNCLASSIFIED) {
    return { folderId: await findOrCreateFolderByName(UNCLASSIFIED_FOLDER_NAME), folderName: UNCLASSIFIED_FOLDER_NAME };
  }
  if (menuItemId.startsWith(MENU_QUICK_PREFIX)) {
    const folderId = menuItemId.slice(MENU_QUICK_PREFIX.length);
    try {
      const [folder] = await chrome.bookmarks.get(folderId);
      return { folderId, folderName: folder.title };
    } catch (error) {
      throw new Error("保存先のフォルダが見つかりません（削除された可能性があります）。");
    }
  }
  throw new Error("不明なメニュー項目です: " + menuItemId);
}

async function resolveAutoTarget({ tab, url, title, progressId }) {
  const connection = await getLlmConnection();
  if (!connection.apiKey) throw new Error("APIキーが設定されていません。オプション画面から設定してください。");

  // すでにブックマーク済みなら、AIを呼ばずに知らせる（APIコストの節約と、重複の防止）
  const existing = await chrome.bookmarks.search({ url });
  if (existing.length > 0) {
    const [parent] = await chrome.bookmarks.get(existing[0].parentId);
    return { duplicate: { folderName: parent.title } };
  }

  const unclassified = async notice => ({
    folderId: await findOrCreateFolderByName(UNCLASSIFIED_FOLDER_NAME),
    folderName: UNCLASSIFIED_FOLDER_NAME,
    notice
  });

  // AIへ送れないURL（http/https以外・除外ドメイン）は、判定せず未分類に入れる
  const privacy = await getPrivacySettings();
  if (!isAiSendableUrl(url, privacy)) {
    return unclassified({
      title: "「" + UNCLASSIFIED_FOLDER_NAME + "」に追加しました（AI判定の対象外）",
      message: title + "\nプライバシー設定により、このURLはAIに送信しません。"
    });
  }

  console.log(">> 最適カテゴリの自動判定を開始します...");
  await showProgress(progressId, "自動カテゴライズブックマーク", title, 10);

  let pageMeta = null;
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: getPageMetaData });
    pageMeta = results?.[0]?.result || null;
  } catch (scriptError) {
    console.log(">> ページDOMへのアクセスが制限されているため、ブラウザ情報に切り替えます。");
  }
  const hasPageMeta = !!pageMeta && (!!pageMeta.description || !!pageMeta.keywords);

  const combinedInputText = hasPageMeta ?
    "タイトル: " + title + "\n概要情報: [Description]: " + (pageMeta.description || "無し") + " | [Keywords]: " + (pageMeta.keywords || "無し") :
    "タイトル: " + title + "\nURL情報: " + sanitizeUrlForAi(url, privacy) + "\n概要情報: メタデータ取得不可。タイトルとURLから推測してください。";

  // 進捗更新: 30% (クレンジング開始)
  await showProgress(progressId, "自動カテゴライズブックマーク", title, 30);
  const cleansedContext = await cleanseText(connection, combinedInputText, "Webページのコンテキスト（タイトル・メタデータ）");

  // 進捗更新: 60% (AI推論開始)
  await showProgress(progressId, "自動カテゴライズブックマーク", title, 60);
  const tree = await chrome.bookmarks.getTree();
  const candidates = buildFolderCandidates(tree, await getFolderDescriptions()); // 保護フォルダは含まれない
  const result = await categorizePage({ connection, url: sanitizeUrlForAi(url, privacy), cleansedContext, candidates });

  const meta = hasPageMeta ? pageMeta : null;
  if (result.status === "ok" && result.confidence >= MIN_AUTO_FILE_CONFIDENCE) {
    return {
      folderId: result.folderId,
      folderName: candidates.find(c => c.folder_id === result.folderId).folder_name,
      pageMeta: meta
    };
  }

  // AIの「未分類」判断・確信度不足・判定失敗をユーザーが区別できるよう、通知の文言を分ける
  let notice;
  if (result.status === "ok") {
    notice = { title: "「" + UNCLASSIFIED_FOLDER_NAME + "」に追加しました（確信度が低いため）", message: title + "\nAIの確信度: " + result.confidence + "%" };
  } else if (result.status === "unclassified") {
    notice = { title: "「" + UNCLASSIFIED_FOLDER_NAME + "」に追加しました（適合するフォルダなし）", message: title };
  } else {
    console.warn(">> 自動判定に失敗したため「" + UNCLASSIFIED_FOLDER_NAME + "」に保存します: " + result.reason);
    notice = { title: "AI判定に失敗したため「" + UNCLASSIFIED_FOLDER_NAME + "」に追加しました", message: title + "\n理由: " + result.reason };
  }
  return { ...(await unclassified(notice)), pageMeta: meta };
}

// アクティブなWEBページでメタタグを抽出する軽量関数
// ※ ページ内へ注入して実行されるため、外側の変数や関数を参照してはいけない
function getPageMetaData() {
  const descTag = document.querySelector('meta[name="description"]') || document.querySelector('meta[property="og:description"]');
  const keyTag = document.querySelector('meta[name="keywords"]');
  return {
    description: descTag ? (descTag.getAttribute("content") || "").trim() : "",
    keywords: keyTag ? (keyTag.getAttribute("content") || "").trim() : ""
  };
}

// ---- 通知 ----

// 進捗通知。最初の1回だけ作成し、以降は update で更新する（作り直すと再ポップアップしてしまうため）
async function showProgress(notificationId, title, message, progress) {
  try {
    const updated = await chrome.notifications.update(notificationId, { title, message, progress });
    if (!updated) {
      await chrome.notifications.create(notificationId, { type: "progress", iconUrl: "icon.png", title, message, progress, priority: 2 });
    }
  } catch (error) {
    console.warn("進捗通知の更新に失敗:", error);
  }
}

async function showNotification(title, message) {
  try {
    await chrome.notifications.create({ type: "basic", iconUrl: "icon.png", title, message, priority: 2 });
  } catch (error) {
    console.warn("通知の表示に失敗:", error);
  }
}

// 保存完了の通知。判定が外れたときに、その場で「元に戻す」「未分類へ移動」ができるようボタンを付ける
async function notifySaved({ created, folderName, title, message }) {
  const notificationId = "bookmark-saved-" + Date.now();
  const buttons = [{ title: "元に戻す" }];
  const actions = ["undo"];
  if (folderName !== UNCLASSIFIED_FOLDER_NAME) {
    buttons.push({ title: "「" + UNCLASSIFIED_FOLDER_NAME + "」へ移動" });
    actions.push("unclassified");
  }
  await rememberAction(notificationId, { bookmarkId: created.id, title: created.title, actions });
  try {
    await chrome.notifications.create(notificationId, { type: "basic", iconUrl: "icon.png", title, message, priority: 2, buttons });
  } catch (error) {
    console.warn("通知の表示に失敗:", error);
  }
}

async function readRecentActions() {
  const stored = await chrome.storage.session.get(SESSION_RECENT_ACTIONS);
  return stored[SESSION_RECENT_ACTIONS] || {};
}

async function rememberAction(notificationId, action) {
  const recent = await readRecentActions();
  recent[notificationId] = action;
  const ids = Object.keys(recent);
  for (const oldId of ids.slice(0, Math.max(0, ids.length - RECENT_ACTIONS_LIMIT))) delete recent[oldId];
  await chrome.storage.session.set({ [SESSION_RECENT_ACTIONS]: recent });
}

chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  const recent = await readRecentActions();
  const action = recent[notificationId];
  if (!action) return; // ブラウザの再起動などで、操作の記録が失われている

  try {
    if (action.actions[buttonIndex] === "undo") {
      await chrome.bookmarks.remove(action.bookmarkId);
      await showNotification("ブックマークを取り消しました", action.title);
    } else if (action.actions[buttonIndex] === "unclassified") {
      const folderId = await findOrCreateFolderByName(UNCLASSIFIED_FOLDER_NAME);
      await chrome.bookmarks.move(action.bookmarkId, { parentId: folderId });
      await showNotification("「" + UNCLASSIFIED_FOLDER_NAME + "」へ移動しました", action.title);
    }
  } catch (error) {
    await showNotification("操作に失敗しました", "ブックマークが既に削除または移動されている可能性があります。");
  }
  chrome.notifications.clear(notificationId);
  delete recent[notificationId];
  await chrome.storage.session.set({ [SESSION_RECENT_ACTIONS]: recent });
});
