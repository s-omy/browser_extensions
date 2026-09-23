// テスト用ハーネス: chrome.* API と fetch（Gemini）のモック
// ブックマークは実Chromeに近い挙動（parentId/index の再計算、範囲外 index のエラー）で動く。
// 実行方法は tests/README.md を参照。実 Chrome・実 Gemini API へは一切アクセスしない。

export const B = (id, title, url) => ({ id, title, url });
export const F = (id, title, children = []) => ({ id, title, children });

export function createTree(barChildren = [], otherChildren = []) {
  return F("0", "", [F("1", "ブックマーク バー", barChildren), F("2", "その他のブックマーク", otherChildren)]);
}

const realFetch = window.fetch.bind(window); // モックに差し替える前の fetch（DOMの読み込み用）
const clone = value => JSON.parse(JSON.stringify(value));

export function installChrome({ tree, storage = {}, session = {}, permissionsGranted = true } = {}) {
  const root = tree || createTree();
  const calls = { notifications: [], notificationUpdates: [], cleared: [], moves: [], created: [], removed: [], menus: [], storageSets: [] };
  const permissionRequests = []; // chrome.permissions.request() に渡された origins の履歴
  const grantedOrigins = new Set();
  const listeners = { menuClicked: null, command: null, actionClicked: null, buttonClicked: null, storageChanged: [], bmChanged: [], bmRemoved: [], installed: null, startup: null };
  let idCounter = 9000;

  const reindex = () => {
    const map = {};
    (function walk(node, parentId, index) {
      map[node.id] = node; node.parentId = parentId; node.index = index;
      (node.children || []).forEach((child, i) => walk(child, node.id, i));
    })(root, undefined, 0);
    return map;
  };
  const view = n => n && ({ id: n.id, parentId: n.parentId, index: n.index, title: n.title, url: n.url, dateAdded: n.dateAdded });

  const makeArea = (data, notify) => ({
    get: async keys => {
      const list = keys == null ? Object.keys(data) : [].concat(typeof keys === "string" ? [keys] : keys);
      const out = {}; list.forEach(k => { if (k in data) out[k] = clone(data[k]); }); return out;
    },
    set: async items => {
      const changes = {};
      for (const [k, v] of Object.entries(items)) { changes[k] = { oldValue: data[k], newValue: clone(v) }; data[k] = clone(v); }
      notify?.(changes); calls.storageSets.push(Object.keys(items));
    },
    remove: async keys => { [].concat(keys).forEach(k => delete data[k]); }
  });
  const local = makeArea(storage, changes => listeners.storageChanged.forEach(fn => fn(changes, "local")));
  const sessionArea = makeArea(session);

  const bookmarks = {
    getTree: async () => { reindex(); return [root]; },
    get: async id => {
      const m = reindex(); const ids = [].concat(id);
      return ids.map(i => { if (!m[i]) throw new Error("Can't find bookmark for id."); return view(m[i]); });
    },
    search: async query => {
      const m = reindex(); const q = typeof query === "string" ? { query } : query;
      return Object.values(m).filter(n => (q.url ? n.url === q.url : true) && (q.title ? n.title === q.title : true)).map(view);
    },
    create: async ({ parentId, title, url }) => {
      const m = reindex(); const parent = m[parentId];
      if (!parent) throw new Error("Can't find parent bookmark for id.");
      const node = url ? B(String(++idCounter), title, url) : F(String(++idCounter), title);
      parent.children.push(node); calls.created.push({ parentId, title, url }); reindex(); return view(node);
    },
    move: async (id, dest) => {
      const m = reindex(); const node = m[id]; const target = m[dest.parentId];
      if (!node || !target) throw new Error("Can't find bookmark for id.");
      const old = m[node.parentId]; const oldIndex = old.children.indexOf(node);
      old.children.splice(oldIndex, 1);
      if (dest.index !== undefined && dest.index > target.children.length) { old.children.splice(oldIndex, 0, node); throw new Error("Index out of bounds."); }
      target.children.splice(dest.index === undefined ? target.children.length : dest.index, 0, node);
      calls.moves.push({ id, ...dest }); reindex(); return view(node);
    },
    remove: async id => {
      const m = reindex(); const node = m[id]; if (!node) throw new Error("Can't find bookmark for id.");
      const parent = m[node.parentId]; parent.children.splice(parent.children.indexOf(node), 1); calls.removed.push(id); reindex();
    },
    onChanged: { addListener: fn => listeners.bmChanged.push(fn) },
    onRemoved: { addListener: fn => listeners.bmRemoved.push(fn) }
  };

  let menuItems = [];
  window.chrome = {
    runtime: { onInstalled: { addListener: fn => { listeners.installed = fn; } }, onStartup: { addListener: fn => { listeners.startup = fn; } }, openOptionsPage: () => { calls.openedOptions = true; } },
    storage: { local, session: sessionArea, onChanged: { addListener: fn => listeners.storageChanged.push(fn) } },
    bookmarks,
    contextMenus: {
      removeAll: async () => { menuItems = []; },
      create: item => { menuItems.push(item); calls.menus.push(item); },
      onClicked: { addListener: fn => { listeners.menuClicked = fn; } }
    },
    action: { onClicked: { addListener: fn => { listeners.actionClicked = fn; } } },
    commands: { onCommand: { addListener: fn => { listeners.command = fn; } } },
    tabs: { query: async () => [window.__activeTab].filter(Boolean) },
    scripting: { executeScript: async () => { if (window.__scriptError) throw new Error("Cannot access"); return [{ result: window.__pageMeta ?? { description: "", keywords: "" } }]; } },
    notifications: {
      update: async (id, opts) => { const exists = calls.notifications.some(n => n.id === id); if (exists) calls.notificationUpdates.push({ id, ...opts }); return exists; },
      create: async (...args) => { const id = typeof args[0] === "string" ? args[0] : "auto-" + calls.notifications.length; const opts = typeof args[0] === "string" ? args[1] : args[0]; calls.notifications.push({ id, ...opts }); return id; },
      clear: id => { calls.cleared.push(id); },
      onButtonClicked: { addListener: fn => { listeners.buttonClicked = fn; } }
    },
    // 任意のオリジン（自前ホストのLiteLLM Proxy等）への動的な権限付与のモック。
    // permissionsGranted:false にすると、ユーザーが許可ダイアログで「拒否」した状況を再現できる。
    permissions: {
      request: async ({ origins = [] } = {}) => {
        permissionRequests.push(origins);
        if (!permissionsGranted) return false;
        origins.forEach(o => grantedOrigins.add(o));
        return true;
      },
      contains: async ({ origins = [] } = {}) => origins.every(o => grantedOrigins.has(o)),
      remove: async ({ origins = [] } = {}) => { origins.forEach(o => grantedOrigins.delete(o)); return true; }
    }
  };
  return { root, storage, session, calls, listeners, menuItems: () => menuItems, index: reindex, permissionRequests, grantedOrigins };
}

/**
 * window.fetch を差し替える。handler(req) が Response 風オブジェクトを返す。
 * req は Gemini形式（contents/parts）・OpenAI互換形式（messages）のどちらでも、
 * req.texts（送信文字列の結合）・req.schema（構造化出力のスキーマ）を同じ形で読めるようにしてある。
 */
export function mockFetch(handler) {
  const requests = [];
  window.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const req = { url, headers: init.headers, body };
    if (Array.isArray(body.contents)) {
      // Gemini形式
      req.texts = body.contents[0].parts.map(p => p.text).join("\n");
      req.schema = body.generationConfig?.response_schema;
    } else if (Array.isArray(body.messages)) {
      // OpenAI互換形式（LiteLLM Proxy 等）
      req.texts = body.messages.map(m => m.content).join("\n");
      req.schema = body.response_format?.json_schema?.schema;
    }
    requests.push(req);
    return handler(req);
  };
  return requests;
}

// ---- Gemini形式の応答ビルダー ----
export const okJson = (obj, usage = { promptTokenCount: 10, candidatesTokenCount: 2 }) => ({
  ok: true, status: 200, headers: new Headers(),
  json: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(obj) }] } }], usageMetadata: usage })
});
export const okText = text => ({
  ok: true, status: 200, headers: new Headers(),
  json: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 } })
});
export const blocked = reason => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ promptFeedback: { blockReason: reason } }) });

// ---- OpenAI互換形式の応答ビルダー ----
export const okChatJson = (obj, usage = { prompt_tokens: 10, completion_tokens: 2 }) => ({
  ok: true, status: 200, headers: new Headers(),
  json: async () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(obj) } }], usage })
});
export const okChatText = text => ({
  ok: true, status: 200, headers: new Headers(),
  json: async () => ({ choices: [{ finish_reason: "stop", message: { content: text } }], usage: { prompt_tokens: 5, completion_tokens: 1 } })
});
export const chatContentFilter = () => ({
  ok: true, status: 200, headers: new Headers(),
  json: async () => ({ choices: [{ finish_reason: "content_filter", message: { content: null } }] })
});
export const chatTruncated = text => ({
  ok: true, status: 200, headers: new Headers(),
  json: async () => ({ choices: [{ finish_reason: "length", message: { content: text } }] })
});

// ---- HTTPエラー（両形式共通: {error:{message}} の形はGemini・OpenAI互換のどちらも使う） ----
export const httpError = (status, message = "error") => ({ ok: false, status, headers: new Headers(), json: async () => ({ error: { message } }) });

export const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

/** options.html の本文を現在のページに展開する（スクリプトは実行されない） */
export async function loadOptionsDom() {
  const html = await (await realFetch("/options.html", { cache: "no-store" })).text();
  const parsed = new DOMParser().parseFromString(html, "text/html");
  document.body.innerHTML = parsed.body.innerHTML.replace(/<script[\s\S]*?<\/script>/g, "");
}
