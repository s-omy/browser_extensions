// privacy.js / bookmarks.js / storage.js の純粋なロジックを検証する（DOM・Gemini API は使わない）

import { describe, test, assert, assertEqual, lazy } from "../lib/assert.js";
import { B, F, createTree, installChrome } from "../lib/harness.js";

const BASE = location.origin;

describe("privacy.js", () => {
  const mod = lazy(() => import(BASE + "/privacy.js"));

  test("parseDomainList: 大文字・URLの貼り付け・空白・不正なトークンを正規化する", async () => {
    const privacy = await mod();
    const result = privacy.parseDomainList("Example.com, https://Intra.Example.co.jp/path\n  foo.bar  ,,bad host");
    assertEqual(result, ["example.com", "intra.example.co.jp", "foo.bar", "bad", "host"]);
  });

  test("isAiSendableUrl: http/https 以外は送信不可", async () => {
    const privacy = await mod();
    assert(privacy.isAiSendableUrl("https://a.example/x?y=1"), "https は許可されるべき");
    assert(!privacy.isAiSendableUrl("javascript:alert(1)"), "javascript: は拒否されるべき");
    assert(!privacy.isAiSendableUrl("file:///C:/x.txt"), "file: は拒否されるべき");
    assert(!privacy.isAiSendableUrl("chrome://extensions"), "chrome: は拒否されるべき");
    assert(!privacy.isAiSendableUrl("not a url"), "URLとして解釈できない文字列は拒否されるべき");
  });

  test("isAiSendableUrl: 除外ドメインはサブドメインも拒否し、接尾辞が同じだけの別ドメインは拒否しない", async () => {
    const privacy = await mod();
    const settings = { excluded_domains: ["secret.example"] };
    assert(!privacy.isAiSendableUrl("https://secret.example/", settings), "完全一致は拒否されるべき");
    assert(!privacy.isAiSendableUrl("https://a.b.secret.example/", settings), "サブドメインは拒否されるべき");
    assert(privacy.isAiSendableUrl("https://notsecret.example/", settings), "接尾辞が同じだけの別ドメインは許可されるべき");
  });

  test("sanitizeUrlForAi: strip_query のときだけクエリとハッシュを取り除く", async () => {
    const privacy = await mod();
    assertEqual(privacy.sanitizeUrlForAi("https://a.example/p?token=1#frag", { strip_query: false }), "https://a.example/p?token=1#frag");
    assertEqual(privacy.sanitizeUrlForAi("https://a.example/p?token=1#frag", { strip_query: true }), "https://a.example/p");
  });
});

describe("bookmarks.js", () => {
  // 保護フォルダ([保護])の配下・同名フォルダ・システムフォルダ(バー/その他)を含むツリーで検証する
  const ctx = lazy(async () => {
    const bm = await import(BASE + "/bookmarks.js");
    const tree = createTree(
      [
        F("10", "[保護]", [B("100", "p", "https://p.example"), F("11", "サブ", [B("110", "q", "https://q.example")])]),
        F("12", "Web ブックマーク整理", [B("120", "a", "https://a.example"), F("13", "Node.js", [B("130", "n", "https://n.example")])]),
        F("14", "Dup", []),
        F("15", "Dup", [B("150", "d", "https://d.example")])
      ],
      [F("16", "その他直下", [B("160", "o", "https://o.example")])]
    );
    installChrome({ tree });
    const bookmarkTree = await window.chrome.bookmarks.getTree();
    return { bm, tree: bookmarkTree };
  });

  test("extractFolders: 保護フラグは配下へ継承し、空フォルダは対象外、階層パスは › 区切り", async () => {
    const { bm, tree } = await ctx();
    const byId = Object.fromEntries(bm.extractFolders(tree).map(f => [f.folder_id, f]));
    assertEqual(byId["10"].is_untouchable, true, "[保護] 自体は保護される");
    assertEqual(byId["11"].is_untouchable, true, "保護フォルダの配下も継承して保護される");
    assertEqual(byId["12"].is_quick_access, true, "ブックマークバー直下は QuickAccess");
    assertEqual(byId["16"].is_quick_access, false, "その他のブックマーク配下は QuickAccess でない");
    assertEqual(byId["13"].hierarchical_categories, "Web ブックマーク整理 › Node.js");
    assert(!("14" in byId), "ブックマークを含まないフォルダ(空のDup)は抽出対象外");
    assertEqual(byId["15"].folder_name, "Dup", "同名フォルダ(2つ目のDup)はIDで区別されて残る");
  });

  test("getFolderPathMap: ブラケットは除去し、'.'区切りは使わない（フォルダ名と衝突するため）", async () => {
    const { bm, tree } = await ctx();
    const pathMap = bm.getFolderPathMap(tree);
    assertEqual(pathMap.get("10"), "保護", "[ ] は表示パスから除去される");
    // "Node.js" 自体にドットを含むため、パス区切り記号が "." でないことを直接確かめる
    assertEqual(pathMap.get("13"), "Web ブックマーク整理 › Node.js");
    assert(!pathMap.get("13").includes(" . "), "階層の区切りに '.' を使ってはいけない（'Node.js' のようなフォルダ名と衝突するため）");
  });

  test("getProtectedFolderIds: 保護フォルダとその配下のIDだけを返す", async () => {
    const { bm } = await ctx();
    assertEqual([...(await bm.getProtectedFolderIds())].sort(), ["10", "11"]);
  });

  test("buildFolderCandidates: 保護フォルダを除外し、説明文はフォルダIDで引き当てる", async () => {
    const { bm, tree } = await ctx();
    const candidates = bm.buildFolderCandidates(tree, { "12": "説明12" });
    assert(!candidates.some(c => c.folder_id === "10" || c.folder_id === "11"), "保護フォルダは候補に含まれない");
    const c12 = candidates.find(c => c.folder_id === "12");
    assertEqual(c12.description, "説明12");
    assertEqual(c12.is_quick_access, true);
    const c14 = candidates.find(c => c.folder_id === "14");
    assert(c14.description.includes("説明なし"), "説明文が無いフォルダには既定文が入る");
  });

  test("findOrCreateFolderByName: 既存の非保護フォルダを返し、無ければブックマークバー直下に作る", async () => {
    const { bm } = await ctx();
    const existingId = await bm.findOrCreateFolderByName("Dup");
    assertEqual(existingId, "14", "複数ある同名フォルダのうち、ツリーで最初に見つかったものを返す");

    const createdId = await bm.findOrCreateFolderByName("未分類");
    const tree = await window.chrome.bookmarks.getTree();
    const bar = tree[0].children[0];
    assert(
      bar.children.some(c => c.id === createdId && c.title === "未分類"),
      "存在しないフォルダは、ブックマークバー直下に新規作成される"
    );
  });
});

describe("storage.js: 旧形式（フォルダ名キー）からの移行", () => {
  const ctx = lazy(async () => {
    const storage = await import(BASE + "/storage.js");
    const env = installChrome({
      tree: createTree([F("20", "開発", [B("200", "a", "https://a.example")]), F("21", "同名", []), F("22", "同名", []), F("23", "[保護]", [])]),
      storage: { folder_descriptions: { 開発: "開発の説明", 同名: "曖昧", 消えたフォルダ: "x" }, gemini_key: "K" }
    });
    const migrated = await storage.migrateLegacyStorage();
    const again = await storage.migrateLegacyStorage();
    return { env, migrated, again };
  });

  test("一意なフォルダ名だけをIDキーへ移行する（同名・存在しないフォルダは移行しない）", async () => {
    const { env } = await ctx();
    assertEqual(env.storage.folder_descriptions_by_id, { 20: "開発の説明" });
  });

  test("旧キーを削除し、無関係のデータとバージョンは保持する", async () => {
    const { env } = await ctx();
    assert(!("folder_descriptions" in env.storage), "旧キーは削除される");
    assertEqual(env.storage.gemini_key, "K", "無関係のキーは保持される");
    assertEqual(env.storage.storage_version, 2);
  });

  test("2回目以降の呼び出しは何もしない（冪等）", async () => {
    const { migrated, again } = await ctx();
    assert(migrated === true, "1回目は移行を実施したことを返す");
    assert(again === false, "2回目は何もしなかったことを返す");
  });
});
