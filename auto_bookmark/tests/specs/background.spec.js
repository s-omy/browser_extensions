// background.js（右クリック・ツールバー・ショートカットからのブックマーク登録）を検証する

import { describe, test, assert, assertEqual, assertMatch, lazy } from "../lib/assert.js";
import { B, F, createTree, installChrome, mockFetch, okJson, okText, httpError, blocked, wait } from "../lib/harness.js";

const BASE = location.origin;

// 一連の操作を1回だけ実行し、各ステップの結果を steps オブジェクトに記録する。
// 個々の test() は、この共有結果（lazy でキャッシュされる）の別々の側面を検証する。
const ctx = lazy(async () => {
  const tree = createTree([
    F("13", "開発", [B("130", "既存", "https://existing.example/")]),
    F("14", "生活", []),
    F("10", "[保護]", [F("11", "サブ", [])])
  ]);
  const env = installChrome({ tree, storage: { gemini_key: "K", storage_version: 2, folder_descriptions_by_id: { 13: "開発資料" } } });
  const { calls, listeners } = env;

  let categorizeReply = () => okJson({ folder_id: "13", confidence: 90 });
  // クレンジング応答は入力をそのままエコーする（無毒化なしと同じ）。
  // 固定文字列を返すと、後段のプロンプトが本来の分岐（meta有無など）を反映しなくなるため。
  const requests = mockFetch(req => {
    if (req.texts.includes("データクレンジング")) return okText(req.texts.split("# 入力\n")[1] ?? req.texts);
    return categorizeReply(req);
  });

  await import(BASE + "/background.js?v=" + Date.now() + Math.random());
  const tab = { id: 1, title: "テストページ", url: "https://x.example/page?utm=1" };
  const reset = () => {
    calls.notifications.length = 0;
    calls.notificationUpdates.length = 0;
    calls.cleared.length = 0;
    calls.created.length = 0;
    requests.length = 0;
  };
  const summary = () => ({
    created: calls.created.map(c => c.parentId + ":" + c.title),
    notes: calls.notifications
      .filter(n => n.type !== "progress")
      .map(n => n.title + " | " + (n.message || "").replace(/\n/g, " / ") + (n.buttons ? " [" + n.buttons.map(b => b.title).join(",") + "]" : "")),
    requests: requests.length
  });
  const click = async (menuItemId, t = tab) => {
    reset();
    await listeners.menuClicked({ menuItemId, pageUrl: t.url }, t);
    return summary();
  };

  const steps = {};

  // ---- メニュー構築 ----
  await listeners.installed({ reason: "install" });
  await wait(100);
  steps.menuInitial = env.menuItems().map(m => m.id + (m.parentId ? "" : "(root)"));
  steps.openedOptionsOnInstall = !!calls.openedOptions;

  await chrome.storage.local.set({ quick_folders: ["13", "999", "14"] }); // 999 は削除済みフォルダ
  await wait(150);
  steps.menuWithQuick = env.menuItems().map(m => m.id + (m.title ? ":" + m.title : ""));

  env.root.children[0].children.find(f => f.id === "14").title = "A&B";
  listeners.bmChanged.forEach(fn => fn("14", {}));
  await wait(100);
  steps.menuEscapedTitle = env.menuItems().find(m => m.id === "quick:14").title;

  // ---- 明示的な保存先（AIを呼ばない） ----
  steps.quickFolder = await click("quick:13");
  steps.unclassifiedMenu = await click("unclassified");
  steps.quickDeleted = await click("quick:999");

  // ---- 自動振り分け: 正常系 ----
  window.__pageMeta = { description: "開発向けの記事", keywords: "js, node" };
  steps.autoOk = await click("auto-sort", { ...tab, url: "https://ok.example/a?token=SECRET" });
  const okRequest = requests.find(r => r.texts.includes("カテゴリ候補"));
  steps.autoOkDetail = {
    progressUpdates: calls.notificationUpdates.map(u => u.progress),
    progressCleared: calls.cleared.length,
    schemaEnumIncludesUnclassified: okRequest.schema.properties.folder_id.enum.includes("UNCLASSIFIED"),
    schemaEnumHasNoProtected: !okRequest.schema.properties.folder_id.enum.some(id => id === "10" || id === "11"),
    promptHasNoProtected: !/"(10|11)"/.test(okRequest.texts.split("カテゴリ候補")[1]),
    keyInHeaderNotUrl: okRequest.headers["x-goog-api-key"] === "K" && !okRequest.url.includes("K="),
    kbSource: env.storage.page_knowledge_base?.["https://ok.example/a?token=SECRET"]?.source,
    kbKeywords: env.storage.page_knowledge_base?.["https://ok.example/a?token=SECRET"]?.keywords
  };

  // ---- 通知ボタン ----
  const okNote = calls.notifications.find(n => n.buttons);
  const okBookmarkId = Object.keys(env.index()).find(k => env.index()[k].url === "https://ok.example/a?token=SECRET");
  await listeners.buttonClicked(okNote.id, 1); // 「未分類」へ移動
  const unclassifiedId = Object.keys(env.index()).find(k => env.index()[k].title === "未分類");
  steps.buttonMove = { movedToUnclassified: env.index()[okBookmarkId].parentId === unclassifiedId };
  calls.notifications.length = 0;
  await listeners.buttonClicked(okNote.id, 0); // 記録は消えているので何もしない
  steps.buttonAfterConsumed = { removed: calls.removed.length };

  await click("auto-sort", { ...tab, url: "https://undo.example/" });
  const undoNote = calls.notifications.find(n => n.buttons);
  await listeners.buttonClicked(undoNote.id, 0); // 元に戻す
  steps.buttonUndo = { removed: calls.removed.length, stillExists: Object.values(env.index()).some(n => n.url === "https://undo.example/") };

  // ---- 自動振り分け: 確信度不足・失敗系 ----
  categorizeReply = () => okJson({ folder_id: "13", confidence: 40 });
  steps.lowConfidence = await click("auto-sort", { ...tab, url: "https://low.example/" });
  categorizeReply = () => okJson({ folder_id: "UNCLASSIFIED", confidence: 0 });
  steps.aiUnclassified = await click("auto-sort", { ...tab, url: "https://none.example/" });
  categorizeReply = () => httpError(400, "bad");
  steps.apiError = await click("auto-sort", { ...tab, url: "https://err.example/" });
  categorizeReply = () => blocked("SAFETY");
  steps.blocked = await click("auto-sort", { ...tab, url: "https://blk.example/" });
  categorizeReply = () => okJson({ folder_id: "10", confidence: 99 }); // 保護フォルダIDを返された想定
  steps.protectedIdReturned = await click("auto-sort", { ...tab, url: "https://prot.example/" });
  categorizeReply = () => okJson({ folder_id: "13", confidence: 90 });

  // ---- 重複 ----
  steps.duplicate = await click("auto-sort", { ...tab, url: "https://existing.example/" });

  // ---- プライバシー ----
  await chrome.storage.local.set({ privacy_settings: { strip_query: true, excluded_domains: ["secret.example"] } });
  steps.excludedDomain = await click("auto-sort", { ...tab, url: "https://a.secret.example/x" });
  steps.nonHttp = await click("auto-sort", { ...tab, url: "chrome://extensions" });

  window.__pageMeta = { description: "", keywords: "" };
  await click("auto-sort", { ...tab, url: "https://strip.example/p?token=SECRET#h" });
  const stripReq = requests.find(r => r.texts.includes("カテゴリ候補"));
  steps.stripQueryDetail = {
    urlSentHasQuery: /token=SECRET/.test(stripReq.texts),
    urlSentPrefix: (stripReq.texts.match(/URL: (\S+)/) || [])[1],
    kbWrittenWithoutMeta: !!env.storage.page_knowledge_base?.["https://strip.example/p?token=SECRET#h"]
  };

  // ---- ページのDOMに触れない場合（タブ右クリック等）: タイトル・URLだけで判定 ----
  window.__scriptError = true;
  steps.scriptBlocked = await click("auto-sort", { ...tab, url: "https://noscript.example/" });
  steps.scriptBlockedDetail = { usedUrlContext: requests.find(r => r.texts.includes("カテゴリ候補")).texts.includes("URL情報") };
  window.__scriptError = false;

  // ---- キー未設定・ショートカット・ツールバーアイコン ----
  const savedKey = env.storage.gemini_key;
  delete env.storage.gemini_key;
  steps.noKey = await click("auto-sort", { ...tab, url: "https://nokey.example/" });
  env.storage.gemini_key = savedKey;

  window.__activeTab = { id: 2, title: "ショートカット", url: "https://cmd.example/" };
  reset();
  await listeners.command("auto-sort-current-tab");
  steps.command = summary();
  reset();
  await listeners.command("other");
  steps.commandIgnored = summary();
  reset();
  await listeners.actionClicked({ id: 3, title: "アイコン", url: "https://icon.example/" });
  steps.actionClick = summary();

  return steps;
});

describe("background.js: 右クリックメニューの構築", () => {
  test("インストール時に基本メニューを作り、設定画面を開く", async () => {
    const s = await ctx();
    assertEqual(s.menuInitial, ["parent-bookmark(root)", "auto-sort", "unclassified"]);
    assert(s.openedOptionsOnInstall, "初回インストール時は設定画面を開く");
  });

  test("クイック保存先の変更を、区切り線つきでメニューに反映する（削除済みフォルダは載せない）", async () => {
    const s = await ctx();
    assertEqual(s.menuWithQuick, [
      "parent-bookmark:📑ブックマーク",
      "auto-sort:最適カテゴリへ追加",
      "unclassified:未分類に追加",
      "separator",
      "quick:13:開発",
      "quick:14:生活"
    ]);
  });

  test("フォルダ名の & はメニュー項目としてエスケープする", async () => {
    const s = await ctx();
    assertEqual(s.menuEscapedTitle, "A&&B");
  });
});

describe("background.js: 明示的な保存先（AIを呼ばない）", () => {
  test("クイック保存先へ、AIを呼ばずに保存する", async () => {
    const s = await ctx();
    assert(s.quickFolder.created.some(c => c === "13:テストページ"));
    assertEqual(s.quickFolder.requests, 0);
  });

  test("「未分類に追加」は、未分類フォルダが無ければ自動作成する", async () => {
    const s = await ctx();
    assert(s.unclassifiedMenu.created.some(c => c.endsWith(":未分類")), "未分類フォルダが作られる");
    assert(s.unclassifiedMenu.created.some(c => c.endsWith(":テストページ")), "その下にブックマークが作られる");
  });

  test("削除済みのクイック保存先を選ぶと、保存に失敗したことを通知する", async () => {
    const s = await ctx();
    assertEqual(s.quickDeleted.created, []);
    assert(s.quickDeleted.notes[0].includes("保存先のフォルダが見つかりません"));
  });
});

describe("background.js: 自動振り分け（正常系）", () => {
  test("AIが選んだフォルダへ保存し、進捗通知を出してから消す", async () => {
    const s = await ctx();
    assertEqual(s.autoOk.notes, ["「開発」にブックマークしました。 | テストページ [元に戻す,「未分類」へ移動]"]);
    assertEqual(s.autoOkDetail.progressUpdates, [30, 60]);
    assertEqual(s.autoOkDetail.progressCleared, 1);
  });

  test("候補フォルダのIDをスキーマのenumに拘束し、保護フォルダは候補から除く", async () => {
    const s = await ctx();
    assert(s.autoOkDetail.schemaEnumIncludesUnclassified);
    assert(s.autoOkDetail.schemaEnumHasNoProtected, "保護フォルダIDが候補のenumに含まれてはいけない");
    assert(s.autoOkDetail.promptHasNoProtected, "保護フォルダの情報がプロンプト本文に出てはいけない");
  });

  test("APIキーはURLではなくヘッダで送る", async () => {
    const s = await ctx();
    assert(s.autoOkDetail.keyInHeaderNotUrl);
  });

  test("読み取れたページmetaを、ナレッジとして保存する（source: page_meta）", async () => {
    const s = await ctx();
    assertEqual(s.autoOkDetail.kbSource, "page_meta");
    assertEqual(s.autoOkDetail.kbKeywords, ["js", "node"], "ページのキーワード情報は、語の配列として保存する");
  });
});

describe("background.js: 保存完了の通知ボタン", () => {
  test("「未分類へ移動」ボタンで、保存したブックマークを未分類へ移す", async () => {
    const s = await ctx();
    assert(s.buttonMove.movedToUnclassified);
  });

  test("消費済みの通知ボタンをもう一度押しても何もしない", async () => {
    const s = await ctx();
    assertEqual(s.buttonAfterConsumed.removed, 0);
  });

  test("「元に戻す」ボタンで、保存したブックマークを削除する", async () => {
    const s = await ctx();
    assertEqual(s.buttonUndo.removed, 1);
    assert(!s.buttonUndo.stillExists);
  });
});

describe("background.js: 自動振り分けが未分類に落ちる各ケース", () => {
  test("確信度が閾値未満なら未分類にし、確信度を通知する", async () => {
    const s = await ctx();
    assertEqual(s.lowConfidence.notes, ["「未分類」に追加しました（確信度が低いため） | テストページ / AIの確信度: 40% [元に戻す]"]);
  });

  test("AIが「適合なし」と判断したら未分類にする", async () => {
    const s = await ctx();
    assertEqual(s.aiUnclassified.notes, ["「未分類」に追加しました（適合するフォルダなし） | テストページ [元に戻す]"]);
  });

  test("APIエラー時は理由つきで未分類にする", async () => {
    const s = await ctx();
    assertEqual(s.apiError.notes, ["AI判定に失敗したため「未分類」に追加しました | テストページ / 理由: APIエラー (HTTP 400) [元に戻す]"]);
  });

  test("AIの応答がブロックされたら理由つきで未分類にする", async () => {
    const s = await ctx();
    assertEqual(s.blocked.notes, ["AI判定に失敗したため「未分類」に追加しました | テストページ / 理由: AIの応答がブロックされました (SAFETY) [元に戻す]"]);
  });

  test("候補にないフォルダIDが返っても、そのフォルダは作らず未分類にする", async () => {
    const s = await ctx();
    assertEqual(s.protectedIdReturned.notes, ["AI判定に失敗したため「未分類」に追加しました | テストページ / 理由: 候補にないフォルダIDが返されました [元に戻す]"]);
  });

  test("APIキー未設定時は、保存に失敗したことを通知する（AIは呼ばない）", async () => {
    const s = await ctx();
    assertEqual(s.noKey.created, []);
    assert(s.noKey.notes[0].includes("APIキーが設定されていません"));
  });
});

describe("background.js: 重複検出", () => {
  test("既にブックマーク済みのURLは、AIを呼ばずに保存先を知らせる", async () => {
    const s = await ctx();
    assertEqual(s.duplicate.created, []);
    assertEqual(s.duplicate.requests, 0);
    assertEqual(s.duplicate.notes, ["すでにブックマーク済みです | 「開発」に保存されています。 / テストページ"]);
  });
});

describe("background.js: プライバシー設定", () => {
  test("除外ドメインのページは、AIを呼ばず未分類にする", async () => {
    const s = await ctx();
    assertEqual(s.excludedDomain.requests, 0);
    assert(s.excludedDomain.notes[0].includes("AI判定の対象外"));
  });

  test("http/https 以外のページは、AIを呼ばず未分類にする", async () => {
    const s = await ctx();
    assertEqual(s.nonHttp.requests, 0);
    assert(s.nonHttp.notes[0].includes("AI判定の対象外"));
  });

  test("strip_query 設定時は、AIへ送るURLからクエリとハッシュを取り除く", async () => {
    const s = await ctx();
    assert(!s.stripQueryDetail.urlSentHasQuery, "送信したURLにクエリが残ってはいけない");
    assertEqual(s.stripQueryDetail.urlSentPrefix, "https://strip.example/p");
    assert(!s.stripQueryDetail.kbWrittenWithoutMeta, "meta情報が無ければナレッジを書き込まない");
  });
});

describe("background.js: ページのDOMに触れない場合のフォールバック", () => {
  test("executeScript が失敗したら、タイトルとURLだけで判定する", async () => {
    const s = await ctx();
    assertEqual(s.scriptBlocked.notes, ["「開発」にブックマークしました。 | テストページ [元に戻す,「未分類」へ移動]"]);
    assert(s.scriptBlockedDetail.usedUrlContext, "meta情報が取れないときは、プロンプトにURL情報を含める");
  });
});

describe("background.js: ツールバーアイコン・ショートカット", () => {
  test("ショートカットは、現在アクティブなタブを対象に自動振り分けを実行する", async () => {
    const s = await ctx();
    assertMatch(s.command.notes[0], /^「.+」にブックマークしました。 \| ショートカット/);
  });

  test("未対応のコマンドは無視する", async () => {
    const s = await ctx();
    assertEqual(s.commandIgnored, { created: [], notes: [], requests: 0 });
  });

  test("ツールバーアイコンのクリックは、自動振り分けを実行する", async () => {
    const s = await ctx();
    assertMatch(s.actionClick.notes[0], /^「.+」にブックマークしました。 \| アイコン/);
  });
});
