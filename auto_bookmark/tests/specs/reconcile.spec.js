// 保存データの整合（reconcile.js）・再解析の要否判定（findStaleFolders）・設定画面での表示と実行タイミングを検証する

import { describe, test, assert, assertEqual, lazy } from "../lib/assert.js";
import { B, F, createTree, installChrome, mockFetch, okJson, httpError, wait, loadOptionsDom } from "../lib/harness.js";
import { boot, $, text, cleanseEcho } from "../lib/options-boot.js";

const BASE = location.origin;
const mods = lazy(async () => ({
  reconcile: await import(BASE + "/reconcile.js"),
  analysis: await import(BASE + "/folder-analysis.js"),
  bookmarks: await import(BASE + "/bookmarks.js")
}));

const clone = value => JSON.parse(JSON.stringify(value));
const kbEntry = (path, extra = {}) => ({ subject: "s", summary: "s", description: "d", keywords: ["x"], hierarchical_categories: path, last_updated_at: Date.now(), source: "ai_estimate", ...extra });
const metaEntry = (id, name, path, extra = {}) => ({
  folder_id: id, folder_name: name, hierarchical_categories: path, is_quick_access: true, is_untouchable: false, entry_count: 1, analyzed_entry_count: 1, ...extra
});

// 「以前の解析・同期の後に、ブックマークが変更された」状態を作る。
//   現在のツリー: 10「開発-新」（旧: 開発）／13「投資」（旧: 「生活」の子。バー直下へ移動）／14「[秘密]」（旧: 秘密。保護になった）／15「空」（空のフォルダ）
//   12「生活」は削除済み。ページ https://gone.example/ も削除済み
function buildScenario() {
  const tree = createTree([
    F("10", "開発-新", [B("b1", "React", "https://react.dev/")]),
    F("13", "投資", [B("b3", "NISA", "https://nisa.example/")]),
    F("14", "[秘密]", [B("b4", "秘密のページ", "https://secret.example/")]),
    F("15", "空", [])
  ]);
  const storage = {
    gemini_key: "K",
    folder_descriptions_by_id: { 10: "開発の説明", 12: "生活の説明", 13: "投資の説明", 14: "秘密の説明", 15: "空フォルダの説明" },
    folder_meta_tree: [
      metaEntry("10", "開発", "開発"),
      metaEntry("12", "生活", "生活"),
      metaEntry("13", "投資", "生活 › 投資"),
      metaEntry("14", "秘密", "秘密")
    ],
    page_knowledge_base: {
      "https://react.dev/": kbEntry("開発", { keywords: ["手動で編集したタグ"] }),
      "https://gone.example/": kbEntry("生活"),
      "https://nisa.example/": kbEntry("生活 › 投資")
    },
    quick_folders: ["12", "10"]
  };
  return { tree, storage };
}

describe("reconcile.js: 保存データを現在のブックマークへ整合させる", () => {
  const ctx = lazy(async () => {
    const { reconcile } = await mods();
    const { tree, storage } = buildScenario();
    const env = installChrome({ tree, storage });
    const requests = mockFetch(() => okJson({}));
    const before = clone(env.storage);
    const first = await reconcile.reconcileStorage();
    const afterFirst = clone(env.storage);
    const writesAfterFirst = env.calls.storageSets.length;
    const second = await reconcile.reconcileStorage();
    return { env, requests, before, first, afterFirst, second, secondWrites: env.calls.storageSets.length - writesAfterFirst, reconcile };
  });

  test("存在しなくなったフォルダの説明文とフォルダ構造の記録を削除する", async () => {
    const { afterFirst, first } = await ctx();
    assert(!("12" in afterFirst.folder_descriptions_by_id));
    assert(!afterFirst.folder_meta_tree.some(m => m.folder_id === "12"));
    assertEqual(first.removedFolders, 1);
  });

  test("保護フォルダになったフォルダの説明文は削除し、フォルダ構造の記録（保護の表示用）は残す", async () => {
    const { afterFirst } = await ctx();
    assert(!("14" in afterFirst.folder_descriptions_by_id));
    assertEqual(afterFirst.folder_meta_tree.find(m => m.folder_id === "14").is_untouchable, true);
  });

  test("存在し保護されていないフォルダの説明文は、空のフォルダも含めて削除しない", async () => {
    const { afterFirst } = await ctx();
    assertEqual(Object.keys(afterFirst.folder_descriptions_by_id).sort(), ["10", "13", "15"]);
  });

  test("改名・移動があったフォルダの記録を、現在の名前・階層パス・件数へ更新する（説明文は残す）", async () => {
    const { afterFirst, first } = await ctx();
    const m10 = afterFirst.folder_meta_tree.find(m => m.folder_id === "10");
    const m13 = afterFirst.folder_meta_tree.find(m => m.folder_id === "13");
    assertEqual([m10.folder_name, m10.hierarchical_categories], ["開発-新", "開発-新"]);
    assertEqual([m13.folder_name, m13.hierarchical_categories], ["投資", "投資"]);
    assertEqual(afterFirst.folder_descriptions_by_id["10"], "開発の説明");
    assertEqual(first.changedFolders, 3, "10（名前・パス）、13（パス）、14（名前）");
  });

  test("説明文を生成した時点の名前・パス（analyzed_*）は、無い旧形式のデータでは更新前の値で補う", async () => {
    const { afterFirst } = await ctx();
    const m10 = afterFirst.folder_meta_tree.find(m => m.folder_id === "10");
    assertEqual([m10.analyzed_name, m10.analyzed_path], ["開発", "開発"]);
    const m13 = afterFirst.folder_meta_tree.find(m => m.folder_id === "13");
    assertEqual([m13.analyzed_name, m13.analyzed_path], ["投資", "生活 › 投資"]);
  });

  test("解析時の件数（analyzed_entry_count）は変更しない", async () => {
    const { before, afterFirst } = await ctx();
    for (const meta of afterFirst.folder_meta_tree) {
      assertEqual(meta.analyzed_entry_count, before.folder_meta_tree.find(m => m.folder_id === meta.folder_id).analyzed_entry_count);
    }
  });

  test("削除済みページのナレッジを削除し、所属パスを更新する。利用者が編集したキーワードは保持する", async () => {
    const { afterFirst, first } = await ctx();
    const kb = afterFirst.page_knowledge_base;
    assertEqual(Object.keys(kb).sort(), ["https://nisa.example/", "https://react.dev/"]);
    assertEqual(kb["https://react.dev/"].hierarchical_categories, "開発-新");
    assertEqual(kb["https://nisa.example/"].hierarchical_categories, "投資");
    assertEqual(kb["https://react.dev/"].keywords, ["手動で編集したタグ"]);
    assertEqual([first.removedKnowledge, first.updatedKnowledge], [1, 2]);
  });

  test("クイック保存先から、存在しないフォルダを除く", async () => {
    const { afterFirst, first } = await ctx();
    assertEqual(afterFirst.quick_folders, ["10"]);
    assertEqual(first.removedQuickFolders, 1);
  });

  test("AIを呼ばず、ブックマークも変更しない", async () => {
    const { env, requests } = await ctx();
    assertEqual(requests.length, 0, "AIへのリクエストは発行しない");
    assertEqual([env.calls.moves.length, env.calls.created.length, env.calls.removed.length], [0, 0, 0]);
  });

  test("繰り返し実行しても同じ結果になり、2回目は何も書き込まない（冪等）", async () => {
    const { afterFirst, env, second, secondWrites } = await ctx();
    assertEqual(env.storage, afterFirst);
    assertEqual(secondWrites, 0);
    assertEqual(second, { removedFolders: 0, changedFolders: 0, removedKnowledge: 0, updatedKnowledge: 0, removedQuickFolders: 0 });
  });

  test("反映した内容が無いときは通知文が空になり、あるときは件数を含める", async () => {
    const { reconcile, first, second } = await ctx();
    assertEqual(reconcile.describeReconcile(second), "");
    const message = reconcile.describeReconcile(first);
    for (const part of ["削除済みフォルダ 1 件", "名前・場所が変わったフォルダ 3 件", "削除済みページのナレッジ 1 件", "所属パス 2 件", "クイック保存先から削除済みフォルダ 1 件"]) {
      assert(message.includes(part), "通知文に「" + part + "」を含む: " + message);
    }
  });
});

describe("reconcile.js: 実行中の排他と失敗時の挙動", () => {
  test("①③の実行中を表す排他がかかっている間は整合を始めず、解除後は実行する", async () => {
    const { reconcile } = await mods();
    const { tree, storage } = buildScenario();
    const env = installChrome({ tree, storage });
    const before = clone(env.storage);
    reconcile.operationLock.enter("analyze");
    const skipped = await reconcile.reconcileStorage();
    const untouched = JSON.stringify(env.storage) === JSON.stringify(before);
    reconcile.operationLock.leave("analyze");
    const resumed = await reconcile.reconcileStorage();
    assertEqual(skipped, { skipped: true });
    assert(untouched, "排他中は保存データを変更しない");
    assertEqual(resumed.removedFolders, 1);
  });

  test("整合に失敗したときは例外を投げず { error } を返し、保存データを壊さない", async () => {
    const { reconcile } = await mods();
    const { tree, storage } = buildScenario();
    const env = installChrome({ tree, storage });
    const before = clone(env.storage);
    window.chrome.bookmarks.getTree = async () => {
      throw new Error("ツリーを取得できません");
    };
    const result = await reconcile.reconcileStorage();
    assert(result.error instanceof Error && result.error.message === "ツリーを取得できません");
    assertEqual(env.storage, before);
  });
});

describe("folder-analysis.js: 再解析が必要なフォルダの判定（名称変更・場所の変更）", () => {
  const run = async (tree, descriptions, metaList) => {
    const { analysis } = await mods();
    installChrome({ tree, storage: {} });
    const bookmarkTree = await window.chrome.bookmarks.getTree();
    return analysis.findStaleFolders(bookmarkTree, descriptions, metaList);
  };
  const folderWith = (id, name, children = [B("b" + id, "t", "https://x" + id + ".example/")]) => F(id, name, children);

  test("説明文を生成した時点から名前が変わっているフォルダは「名称変更」になる", async () => {
    const stale = await run(createTree([folderWith("10", "開発-新")]), { 10: "d" }, [metaEntry("10", "開発-新", "開発-新", { analyzed_name: "開発", analyzed_path: "開発" })]);
    assertEqual(stale, [{ folderId: "10", folderName: "開発-新", reason: "名称変更" }]);
  });

  test("名前は同じで階層パスだけが変わっている（移動・親の改名）フォルダは「場所の変更」になる", async () => {
    const tree = createTree([F("20", "暮らし", [folderWith("13", "投資")])]);
    const stale = await run(tree, { 13: "d" }, [metaEntry("13", "投資", "暮らし › 投資", { analyzed_name: "投資", analyzed_path: "生活 › 投資" })]);
    assertEqual(stale, [{ folderId: "13", folderName: "投資", reason: "場所の変更" }]);
  });

  test("複数の理由が重なるときの優先順位は、名称変更 > 場所の変更 > 件数の変化（1フォルダにつき理由は1つ）", async () => {
    const many = Array.from({ length: 12 }, (_, i) => B("m" + i, "t", "https://many" + i + ".example/"));
    const meta = (extra = {}) => metaEntry("10", "開発-新", "開発-新", { analyzed_entry_count: 1, ...extra });
    const nameAndCount = await run(createTree([folderWith("10", "開発-新", many)]), { 10: "d" }, [meta({ analyzed_name: "開発", analyzed_path: "開発" })]);
    assertEqual(nameAndCount.map(s => s.reason), ["名称変更"]);
    const pathAndCount = await run(createTree([folderWith("10", "開発-新", many)]), { 10: "d" }, [meta({ analyzed_name: "開発-新", analyzed_path: "旧 › 開発-新" })]);
    assertEqual(pathAndCount.map(s => s.reason), ["場所の変更"]);
    const countOnly = await run(createTree([folderWith("10", "開発-新", many)]), { 10: "d" }, [meta({ analyzed_name: "開発-新", analyzed_path: "開発-新" })]);
    assertEqual(countOnly.map(s => s.reason), ["変更"]);
  });

  test("説明文が無いフォルダは、名前や場所によらず「未解析」になる", async () => {
    const stale = await run(createTree([folderWith("10", "開発-新")]), {}, [metaEntry("10", "開発", "開発")]);
    assertEqual(stale.map(s => s.reason), ["未解析"]);
  });

  test("旧形式のデータ（analyzed_* なし）は、保存されていた名前・パスを解析時の値とみなす（変わっていなければ誤検知しない）", async () => {
    const unchanged = await run(createTree([folderWith("10", "開発")]), { 10: "d" }, [metaEntry("10", "開発", "開発")]);
    assertEqual(unchanged, []);
    const renamed = await run(createTree([folderWith("10", "開発-新")]), { 10: "d" }, [metaEntry("10", "開発", "開発")]);
    assertEqual(renamed.map(s => s.reason), ["名称変更"]);
  });

  test("保護フォルダは、改名・移動があっても再解析の対象にしない", async () => {
    const stale = await run(createTree([folderWith("14", "[秘密]")]), { 14: "d" }, [metaEntry("14", "秘密", "秘密")]);
    assertEqual(stale, []);
  });
});

describe("bookmarks.js: listFolderStates", () => {
  test("システムフォルダ・空のフォルダを含む全フォルダの、現在の名前・階層パス・属性・直下の件数を返す", async () => {
    const { bookmarks } = await mods();
    const env = installChrome({ tree: createTree([F("20", "開発", [F("21", "[保護]", [B("p", "t", "https://p.example/")]), B("q", "t", "https://q.example/")])], [F("30", "他", [])]), storage: {} });
    const states = bookmarks.listFolderStates(await window.chrome.bookmarks.getTree());
    assertEqual(states.get("20"), { id: "20", name: "開発", path: "開発", isQuickAccess: true, isUntouchable: false, entryCount: 1, isSystemRoot: false });
    assertEqual(states.get("21").isUntouchable, true);
    assertEqual(states.get("21").isQuickAccess, true);
    assertEqual(states.get("30").entryCount, 0);
    assertEqual(states.get("30").isQuickAccess, false);
    assertEqual([states.get("1").isSystemRoot, states.get("2").isSystemRoot], [true, true]);
  });
});

// ---- 設定画面 ----

describe("設定画面: 削除・改名・移動のあと、画面を開いたときの表示", () => {
  const ctx = lazy(async () => {
    const { tree, storage } = buildScenario();
    const { env } = await boot(BASE, { tree, storage });
    const table = document.querySelector("#category-table-container");
    return {
      env,
      tableText: table.textContent.replace(/\s+/g, ""),
      names: [...table.querySelectorAll(".category-name")].map(n => n.firstChild.textContent),
      paths: [...table.querySelectorAll(".category-path")].map(n => n.textContent),
      badges: [...table.querySelectorAll(".attr-badge-warn")].map(n => n.textContent),
      count: text("category-count"),
      staleInfo: text("stale-info"),
      notice: text("reconcile-status"),
      kbText: document.querySelector("#kb-table-container").textContent,
      quickLabels: [...document.querySelectorAll("#quick-folder-list label")].map(l => l.textContent)
    };
  });

  test("① フォルダ一覧には、現在存在するフォルダだけを、現在の名前・階層パスで表示する", async () => {
    const { names, paths, count, tableText } = await ctx();
    assertEqual(names, ["開発-新", "投資", "[秘密]"]);
    assertEqual(paths, ["開発-新", "投資", "秘密"]);
    assertEqual(count, "3", "総数から削除済みのフォルダを除く");
    assert(!tableText.includes("生活"), "削除済みの「生活」は表示しない");
  });

  test("説明文は、名前・場所が変わったフォルダでもそのまま表示する。保護フォルダは保護の旨を表示する", async () => {
    const { tableText } = await ctx();
    assert(tableText.includes("開発の説明") && tableText.includes("投資の説明"));
    assert(tableText.includes("保護フォルダのため、中身をAIに送信せず"));
    assert(!tableText.includes("秘密の説明"));
  });

  test("再解析の案内に理由ごとの件数を示し、名称変更・場所の変更のフォルダに印を付ける", async () => {
    const { staleInfo, badges } = await ctx();
    assertEqual(staleInfo.startsWith("再解析が必要なフォルダ: 2 件（未解析 0 件 / ブックマーク数が変化 0 件 / 名称変更 1 件 / 場所の変更 1 件）"), true, staleInfo);
    assertEqual(badges, ["名称変更（再解析推奨）", "場所の変更（再解析推奨）"]);
  });

  test("反映した内容を件数つきで通知する", async () => {
    const { notice } = await ctx();
    assert(notice.startsWith("保存データを現在のブックマークに合わせました"), notice);
    assert(notice.includes("削除済みフォルダ 1 件") && notice.includes("削除済みページのナレッジ 1 件"), notice);
  });

  test("③ ナレッジ一覧に削除済みページを出さず、所属パスは現在の名前で表示する", async () => {
    const { kbText } = await ctx();
    assert(!kbText.includes("未登録のURL"), "削除済みページは表示しない");
    assert(kbText.includes("開発-新 (1 件)") && kbText.includes("投資 (1 件)"), kbText);
  });

  test("クイック保存先の選択から削除済みフォルダを除く", async () => {
    const { env } = await ctx();
    assertEqual(env.storage.quick_folders, ["10"]);
  });
});

describe("設定画面: ①②③の実行前に整合が行われる（AIを呼ぶ前）", () => {
  // 画面を開いたあとにブックマークを削除し、各ボタンを押す。実行前の整合でしか消えないデータで確かめる
  //   ① は説明文・記録・ページ知識のうち、ページ知識を触らない   → 削除したページのナレッジが消えていれば、実行前に整合している
  //   ③ は説明文・記録を触らない                                → 削除したフォルダの説明文が消えていれば、実行前に整合している
  //   ② は説明文・ページ知識を触らない（シミュレーションをキャンセル） → 削除したフォルダの説明文が消えていれば、実行前に整合している
  const ctx = lazy(async () => {
    const tree = createTree([
      F("10", "開発", [B("b1", "React", "https://react.dev/")]),
      F("13", "投資", [B("b3", "NISA", "https://nisa.example/")]),
      F("20", "予備", [B("b5", "予備", "https://spare.example/")])
    ]);
    const storage = {
      gemini_key: "K",
      folder_descriptions_by_id: { 10: "開発の説明", 13: "投資の説明", 20: "予備の説明" },
      folder_meta_tree: [metaEntry("10", "開発", "開発"), metaEntry("13", "投資", "投資"), metaEntry("20", "予備", "予備")],
      page_knowledge_base: { "https://react.dev/": kbEntry("開発"), "https://nisa.example/": kbEntry("投資") }
    };
    const { env } = await boot(BASE, { tree, storage, handler: () => httpError(401, "API key not valid"), confirmAnswer: false });
    const bar = env.root.children[0];
    const results = {};

    // ①: ブックマークを削除してから解析ボタンを押す（AI は 401 で失敗する）
    bar.children.find(f => f.id === "10").children = [];
    $("analyze-btn").click();
    await wait(800);
    results.analyzePurgedKnowledge = !("https://react.dev/" in env.storage.page_knowledge_base);

    // ③: フォルダを削除してから同期ボタンを押す（同期対象が無いので、AIは呼ばれない）
    bar.children = bar.children.filter(f => f.id !== "13");
    $("kb-sync-btn").click();
    await wait(600);
    results.syncPurgedDescription = !("13" in env.storage.folder_descriptions_by_id);

    // ②: フォルダを削除してから再カテゴライズのボタンを押す（確認ダイアログでキャンセル）
    bar.children = bar.children.filter(f => f.id !== "20");
    $("relocate-btn").click();
    await wait(600);
    results.relocatePurgedDescription = !("20" in env.storage.folder_descriptions_by_id);
    return results;
  });

  test("① フォルダ解析の実行前に、削除済みページのナレッジが整理される", async () => {
    assert((await ctx()).analyzePurgedKnowledge);
  });

  test("③ ナレッジ同期の実行前に、削除済みフォルダの説明文が整理される", async () => {
    assert((await ctx()).syncPurgedDescription);
  });

  test("② 再カテゴライズの実行前に、削除済みフォルダの説明文が整理される", async () => {
    assert((await ctx()).relocatePurgedDescription);
  });
});

describe("設定画面: 実行中の排他と、整合が失敗したときの表示", () => {
  test("① フォルダ解析の実行中は整合を始めず、完了後は実行できる", async () => {
    const { reconcile } = await mods();
    let release;
    const gate = new Promise(resolve => {
      release = resolve;
    });
    const tree = createTree([F("10", "開発", [B("b1", "React", "https://react.dev/")])]);
    await boot(BASE, {
      tree,
      storage: { gemini_key: "K" },
      handler: async req => {
        await gate;
        return cleanseEcho(req) || okJson({ analyzed_folders: [{ folder_id: "10", description: "説明" }] });
      }
    });
    $("analyze-btn").click();
    await wait(300);
    const during = await reconcile.reconcileStorage();
    release();
    await wait(800);
    const after = await reconcile.reconcileStorage();
    assertEqual(during, { skipped: true }, "実行中");
    assert(!after.skipped && !after.error, "完了後は実行される");
  });

  test("整合に失敗しても、警告を表示して画面の表示と各ブロックは続けて動く", async () => {
    await loadOptionsDom();
    const { tree, storage } = buildScenario();
    installChrome({ tree, storage: { storage_version: 3, ...storage } });
    mockFetch(() => okJson({}));
    const originalGetTree = window.chrome.bookmarks.getTree;
    let first = true;
    window.chrome.bookmarks.getTree = async () => {
      if (first) {
        first = false;
        throw new Error("最初の1回だけ失敗");
      }
      return originalGetTree();
    };
    window.confirm = () => true;
    await import(BASE + "/options.js?v=" + Date.now() + Math.random());
    await wait(500);
    assert(text("reconcile-status").includes("失敗") && text("reconcile-status").includes("続けられます"), text("reconcile-status"));
    assert(text("category-count") !== "0", "一覧は表示される（現在のツリーを基準に描画するため、記録が古くても表示できる）");
    assert(text("kb-plan-text").length > 0, "ナレッジの計画も表示される");
  });
});
