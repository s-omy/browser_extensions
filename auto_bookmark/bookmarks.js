// ブックマークツリーの走査・保護フォルダの判定など、画面（DOM）に依存しない共通処理

export const UNCLASSIFIED_FOLDER_NAME = "未分類";
export const UNTITLED_LABEL = "無題のページ";
// 階層パスの区切り文字。「Node.js」のようにドットを含むフォルダ名と区別できるよう、名前に現れにくい文字にする
export const PATH_SEPARATOR = " › ";

/** [ ] で囲まれたフォルダ名は「アンタッチャブル（保護）」を表す */
export function isUntouchableName(title) {
  return !!title && title.startsWith("[") && title.endsWith("]");
}

function stripBrackets(title) {
  return isUntouchableName(title) ? title.slice(1, -1) : title;
}

/** ブックマークバーのID。ツリーの根の最初の子（Chromeでは "1"）を指す */
export function getBookmarksBarId(bookmarkTree) {
  return bookmarkTree[0]?.children?.[0]?.id ?? "1";
}

/**
 * ツリーの全フォルダ（ID・名前・保護フラグ）を再帰的に抽出する。
 * 保護フラグは親フォルダから継承される（保護フォルダの配下も保護対象）。
 * @param {chrome.bookmarks.BookmarkTreeNode[]} nodes 走査の起点（ツリー全体なら getTree() の戻り値）
 * @returns {{id: string, name: string, isUntouchable: boolean}[]}
 */
export function collectFolderInfos(nodes, list = [], parentUntouchable = false) {
  for (const node of nodes) {
    if (node.url) continue;
    const isUntouchable = parentUntouchable || isUntouchableName(node.title);
    if (node.title) list.push({ id: node.id, name: node.title, isUntouchable });
    if (node.children) collectFolderInfos(node.children, list, isUntouchable);
  }
  return list;
}

/** 最新のツリーから、保護フォルダ（[ ] 囲みとその配下）のIDの集合を求める */
export async function getProtectedFolderIds() {
  const folders = collectFolderInfos(await chrome.bookmarks.getTree());
  return new Set(folders.filter(f => f.isUntouchable).map(f => f.id));
}

/**
 * 全フォルダの階層パス（例: "開発 › Node.js"）を求める。ブラケットは除去し、システムフォルダ
 * （ブックマークバー等）自体はパスに含めない。
 * @returns {Map<string, string>} フォルダID → 階層パス
 */
export function getFolderPathMap(bookmarkTree) {
  const rootId = bookmarkTree[0].id;
  const pathMap = new Map();
  (function walk(nodes, parentPath) {
    for (const node of nodes) {
      if (node.url || !node.title) continue;
      const isSystemRoot = node.parentId === rootId;
      const cleanName = stripBrackets(node.title);
      let path = "";
      if (!isSystemRoot) path = parentPath ? parentPath + PATH_SEPARATOR + cleanName : cleanName;
      pathMap.set(node.id, path);
      if (node.children) walk(node.children, path);
    }
  })(bookmarkTree[0].children, "");
  return pathMap;
}

/**
 * ブックマークバー配下（QuickAccess）のフォルダIDの集合。日常的に使うフォルダとして、AIの判断材料にする。
 */
function getQuickAccessFolderIds(bookmarkTree) {
  const ids = new Set();
  const bar = bookmarkTree[0]?.children?.[0];
  (function walk(nodes) {
    for (const node of nodes || []) {
      if (node.url) continue;
      ids.add(node.id);
      walk(node.children);
    }
  })(bar?.children);
  return ids;
}

const NO_DESCRIPTION_TEXT = "説明なし（新規フォルダまたは未解析）";

/**
 * AIに提示する「振り分け先の候補フォルダ」の一覧を作る。保護フォルダとその配下は含まない。
 * 同名フォルダをAIが区別できるよう、フォルダIDと階層パスを添える。
 * @param {Object<string, string>} descriptions フォルダID → 説明文
 */
export function buildFolderCandidates(bookmarkTree, descriptions = {}) {
  const pathMap = getFolderPathMap(bookmarkTree);
  const quickAccessIds = getQuickAccessFolderIds(bookmarkTree);
  return collectFolderInfos(bookmarkTree)
    .filter(folder => !folder.isUntouchable)
    .map(folder => ({
      folder_id: folder.id,
      folder_name: folder.name,
      hierarchical_categories: pathMap.get(folder.id) || folder.name,
      is_quick_access: quickAccessIds.has(folder.id),
      description: descriptions[folder.id] || NO_DESCRIPTION_TEXT
    }));
}

/**
 * ブックマークを1件以上含むユーザーのフォルダを、属性付きで抽出する。
 * 属性: 階層パス / QuickAccess（ブックマークバー配下） / Untouchable（保護。親から継承）。
 * 件数の上限は設けない（AIへ渡す側でチャンク分割・サンプリングする）。
 * @returns {{folder_id: string, folder_name: string, hierarchical_categories: string,
 *   is_quick_access: boolean, is_untouchable: boolean, entries: {id: string, title: string, url: string}[]}[]}
 */
export function extractFolders(bookmarkTree) {
  const rootId = bookmarkTree[0].id;
  const barId = getBookmarksBarId(bookmarkTree);
  const pathMap = getFolderPathMap(bookmarkTree);
  const result = [];

  (function walk(nodes, parentQuickAccess, parentUntouchable) {
    for (const node of nodes) {
      if (node.url || !node.title) continue;

      // システムフォルダ（ブックマークバー等）は、名前ではなく「ルート直下」であることで判定する
      const isSystemRoot = node.parentId === rootId;
      const isQuickAccess = node.parentId === barId || parentQuickAccess;
      const isUntouchable = parentUntouchable || isUntouchableName(node.title);

      const entries = (node.children || [])
        .filter(child => child.url)
        .map(child => ({ id: child.id, title: child.title || "", url: child.url }));

      if (entries.length > 0 && !isSystemRoot) {
        result.push({
          folder_id: node.id,
          folder_name: node.title,
          hierarchical_categories: pathMap.get(node.id) || node.title,
          is_quick_access: isQuickAccess,
          is_untouchable: isUntouchable,
          entries
        });
      }
      if (node.children) walk(node.children, isQuickAccess, isUntouchable);
    }
  })(bookmarkTree[0].children, false, false);

  return result;
}

/**
 * 指定した名前の（保護されていない）フォルダのIDを返す。無ければブックマークバー直下に作成する。
 * 「未分類」のような、名前で決まる既定の保存先にだけ使う。
 */
export async function findOrCreateFolderByName(name) {
  const tree = await chrome.bookmarks.getTree();
  const found = collectFolderInfos(tree).find(f => f.name === name && !f.isUntouchable);
  if (found) return found.id;
  const created = await chrome.bookmarks.create({ parentId: getBookmarksBarId(tree), title: name });
  return created.id;
}
