// ① フォルダ解析（バッチ処理・保護フォルダの除外・増分解析）を検証する

import { describe, test, assert, assertEqual, lazy } from "../lib/assert.js";
import { B, F, createTree, blocked, httpError, okJson, wait } from "../lib/harness.js";
import { boot, $, text, cleanseEcho } from "../lib/options-boot.js";

const BASE = location.origin;

// F1〜F19（各2件）と Big（75件、うち1件は除外ドメイン）、保護フォルダ[保護]（1件）。
// F7 のタイトルだけ "BLOCKME" にして、説明文生成がブロックされる状況を作る。
function buildTree() {
  const bar = [];
  for (let i = 1; i <= 19; i++) {
    bar.push(
      F(String(100 + i), "F" + i, [B("x" + i + "a", i === 7 ? "BLOCKME" : "記事" + i, "https://f" + i + ".example/a"), B("x" + i + "b", "記事b" + i, "https://f" + i + ".example/b")])
    );
  }
  const big = F("200", "Big", []);
  for (let i = 1; i <= 75; i++) big.children.push(B("g" + i, "大" + i, i === 1 ? "https://secret.example/1" : "https://big" + i + ".example/"));
  bar.push(big, F("300", "[保護]", [B("pp", "保護", "https://pp.example/")]));
  return createTree(bar);
}

function replyHandler(descReqs) {
  return req => {
    const c = cleanseEcho(req);
    if (c) return c;
    if (!req.texts.includes("解析対象メタデータ")) return okJson({});
    const folders = JSON.parse(req.texts.split("【解析対象メタデータ】\n")[1]);
    descReqs.push({ ids: folders.map(f => f.folder_id), enumIds: req.schema.properties.analyzed_folders.items.properties.folder_id.enum, folders });
    if (JSON.stringify(folders).includes("BLOCKME")) return blocked("PROHIBITED_CONTENT");
    return okJson({ analyzed_folders: folders.map(f => ({ folder_id: f.folder_id, description: "説明:" + f.folder_name })) });
  };
}

const ctx = lazy(async () => {
  const descReqs = [];
  const { env } = await boot(BASE, {
    tree: buildTree(),
    storage: {
      gemini_key: "K",
      privacy_settings: { strip_query: false, excluded_domains: ["secret.example"] },
      folder_descriptions_by_id: { 107: "以前のF7", 999: "消えたフォルダ" } // 107=F7。999は現存しないフォルダの説明文
    },
    handler: replyHandler(descReqs)
  });

  const initial = {
    staleInfo: text("stale-info"),
    staleBtnDisabled: $("analyze-stale-btn").disabled,
    tableRows: document.querySelectorAll("#category-table-container tbody tr").length
  };

  $("analyze-btn").click();
  await wait(2500);

  const desc = env.storage.folder_descriptions_by_id;
  const meta = env.storage.folder_meta_tree;
  const bigReq = descReqs.flatMap(r => r.folders).find(f => f.folder_id === "200");
  const full = {
    batchSizes: descReqs.map(r => r.ids.length),
    enumMatches: descReqs.every(r => JSON.stringify(r.ids) === JSON.stringify(r.enumIds)),
    describedCount: Object.keys(desc).length,
    F7keepsPrevious: desc["107"],
    goneFolderRemoved: !("999" in desc),
    protectedIncludedInMeta: meta.find(m => m.folder_id === "300")?.is_untouchable,
    protectedDescribed: "300" in desc,
    protectedSent: JSON.stringify(descReqs).includes("pp.example"),
    protectedDescriptionShown: document.body.textContent.includes("保護フォルダのため、中身をAIに送信せず"),
    metaKeys: Object.keys(meta[0]).sort(),
    bigTotal: bigReq.total_entry_count,
    bigSampleCount: bigReq.sample_entries.length,
    bigExcludedDomainSent: JSON.stringify(bigReq).includes("secret.example"),
    f1AnalyzedCount: meta.find(m => m.folder_id === "101").analyzed_entry_count,
    f7AnalyzedCount: meta.find(m => m.folder_id === "107").analyzed_entry_count,
    f1AnalyzedAt: { name: meta.find(m => m.folder_id === "101").analyzed_name, path: meta.find(m => m.folder_id === "101").analyzed_path },
    f7AnalyzedAt: { name: meta.find(m => m.folder_id === "107").analyzed_name, path: meta.find(m => m.folder_id === "107").analyzed_path },
    status: text("analyze-status"),
    staleInfoAfter: text("stale-info")
  };

  // 増分解析: F1 に7件追加（変化大）、新フォルダ「New」を追加 → その2つだけが再解析の対象になるはず
  const barNode = env.root.children[0];
  for (let i = 0; i < 7; i++) barNode.children.find(f => f.id === "101").children.push(B("add" + i, "追加" + i, "https://add" + i + ".example/"));
  barNode.children.push(F("400", "New", [B("nw", "新規", "https://new.example/")]));
  descReqs.length = 0;

  // 画面を再描画して「再解析が必要」の表示を更新するため、再度起動する（増分検知はローカル計算のみでAPIは呼ばない）。
  // boot() は毎回ストレージの新しいコピーを作るため、戻り値の env2 から読み直す（元の env は古いまま更新されない）。
  const { env: env2 } = await boot(BASE, {
    tree: env.root,
    storage: { gemini_key: "K", folder_descriptions_by_id: desc, folder_meta_tree: meta, privacy_settings: { strip_query: false, excluded_domains: ["secret.example"] } },
    handler: replyHandler(descReqs)
  });
  const staleAfterChange = { info: text("stale-info"), btnDisabled: $("analyze-stale-btn").disabled };

  $("analyze-stale-btn").click();
  await wait(1500);
  const incremental = {
    requestedFolderIds: descReqs.flatMap(r => r.ids).sort(),
    status: text("analyze-status"),
    f2untouched: env2.storage.folder_descriptions_by_id["102"],
    newDescribed: env2.storage.folder_descriptions_by_id["400"],
    f1count: env2.storage.folder_meta_tree.find(m => m.folder_id === "101").analyzed_entry_count
  };

  return { initial, full, incremental, staleAfterChange };
});

describe("フォルダ解析: 再解析が必要なフォルダの検出（ローカル計算のみ）", () => {
  test("画面を開いただけではAPIを呼ばず、未解析のフォルダ数を数える", async () => {
    const c = await ctx();
    assertEqual(c.initial.tableRows, 0);
    assert(c.initial.staleInfo.startsWith("再解析が必要なフォルダ: 19 件（未解析 19 件"), "既に説明文があるF7は、変化を比較する記録が無ければ未解析扱いにしない: " + c.initial.staleInfo);
    assert(!c.initial.staleBtnDisabled);
  });
});

describe("フォルダ解析: バッチ処理とブロックの切り分け", () => {
  test("8フォルダずつのバッチで処理する", async () => {
    const c = await ctx();
    assertEqual(c.full.batchSizes[0], 8, "最初のバッチは8フォルダ");
  });

  test("ブロックされたバッチは二分割して再試行し、原因のフォルダだけを切り分ける", async () => {
    const c = await ctx();
    // F1-F8のバッチでF7だけがブロックされる: 8→4+4→(4は成功)→4→2+2→(2は成功)→2→1(F7失敗)+1(成功)
    assertEqual(c.full.batchSizes, [8, 4, 4, 2, 2, 1, 1, 8, 4]);
  });

  test("各バッチの応答スキーマは、そのバッチのフォルダIDだけに拘束する", async () => {
    const c = await ctx();
    assert(c.full.enumMatches);
  });

  test("ブロックされたフォルダは、以前の説明文を維持する", async () => {
    const c = await ctx();
    assertEqual(c.full.F7keepsPrevious, "以前のF7");
  });

  test("完了メッセージに、失敗件数とフォルダ名・理由を含める", async () => {
    const c = await ctx();
    assert(c.full.status.includes("フォルダの説明文を生成しました"));
    assert(c.full.status.includes("「F7」"));
    assert(c.full.status.includes("AIの応答がブロックされました (PROHIBITED_CONTENT)"));
  });
});

describe("フォルダ解析: 保護フォルダの除外", () => {
  test("保護フォルダはメタ情報には含まれるが、説明文の生成対象にはしない", async () => {
    const c = await ctx();
    assert(c.full.protectedIncludedInMeta, "フォルダ一覧・件数の把握には保護フォルダも含む");
    assert(!c.full.protectedDescribed, "説明文は生成しない");
  });

  test("保護フォルダの中身（URL）はAIに送信しない", async () => {
    const c = await ctx();
    assert(!c.full.protectedSent);
  });

  test("画面には、保護フォルダ向けの説明を表示する", async () => {
    const c = await ctx();
    assert(c.full.protectedDescriptionShown);
  });
});

describe("フォルダ解析: 大きいフォルダのサンプリング", () => {
  test("全件数を記録しつつ、サンプルは既定件数に絞る", async () => {
    const c = await ctx();
    assertEqual(c.full.bigTotal, 75);
    assertEqual(c.full.bigSampleCount, 30);
  });

  test("プライバシー設定で除外したドメインは、サンプルにも含めない", async () => {
    const c = await ctx();
    assert(!c.full.bigExcludedDomainSent);
  });
});

describe("フォルダ解析: 解析時の件数を記録し、削除済みフォルダの説明文は消す", () => {
  test("説明文を生成したフォルダには、そのときの件数を記録する", async () => {
    const c = await ctx();
    assertEqual(c.full.f1AnalyzedCount, 2);
  });

  test("説明文を生成したフォルダには、そのときの名前と階層パス（analyzed_name / analyzed_path）も記録する", async () => {
    const c = await ctx();
    assertEqual(c.full.f1AnalyzedAt, { name: "F1", path: "F1" });
  });

  test("失敗したフォルダは、名前・階層パスも更新しない（初回なので記録なし）", async () => {
    const c = await ctx();
    assertEqual(c.full.f7AnalyzedAt, { name: undefined, path: undefined });
  });

  test("失敗したフォルダは、件数を更新しない（初回なので記録なし）", async () => {
    const c = await ctx();
    assert(c.full.f7AnalyzedCount == null);
  });

  test("ブックマークから消えたフォルダの説明文は保存から取り除く", async () => {
    const c = await ctx();
    assert(c.full.goneFolderRemoved);
  });
});

const fatalCtx = lazy(async () => {
  // 2バッチ目（9〜16番目のフォルダ）で致命的なAPIエラーを起こし、1バッチ目の結果は残ることを確かめる
  const bar = [];
  for (let i = 1; i <= 16; i++) bar.push(F(String(100 + i), "F" + i, [B("y" + i, "記事" + i, "https://fatal" + i + ".example/")]));
  let batchNo = 0;
  const { env } = await boot(BASE, {
    tree: createTree(bar),
    storage: { gemini_key: "K", privacy_settings: { strip_query: false, excluded_domains: [] } },
    handler: req => {
      const c = cleanseEcho(req);
      if (c) return c;
      if (!req.texts.includes("解析対象メタデータ")) return okJson({});
      batchNo++;
      if (batchNo === 2) return httpError(401, "API key not valid");
      const folders = JSON.parse(req.texts.split("【解析対象メタデータ】\n")[1]);
      return okJson({ analyzed_folders: folders.map(f => ({ folder_id: f.folder_id, description: "説明:" + f.folder_name })) });
    }
  });
  $("analyze-btn").click();
  await wait(1500);
  return { savedNames: Object.keys(env.storage.folder_descriptions_by_id).sort(), status: text("analyze-status") };
});

describe("フォルダ解析: APIエラーで中断しても、それまでの結果は保存されている", () => {
  test("1バッチ目の説明文は保存され、2バッチ目以降は未解析のまま中断する", async () => {
    const c = await fatalCtx();
    assertEqual(c.savedNames, ["101", "102", "103", "104", "105", "106", "107", "108"]);
  });

  test("中断したことと理由を、画面に表示する", async () => {
    const c = await fatalCtx();
    assert(c.status.startsWith("中断:"));
    assert(c.status.includes("APIエラー (HTTP 401)"));
  });
});

describe("フォルダ解析: 増分解析", () => {
  test("件数が大きく変わったフォルダと新規フォルダを検出し、ボタンを有効にする", async () => {
    const c = await ctx();
    assert(c.staleAfterChange.info.startsWith("再解析が必要なフォルダ: 2 件"), c.staleAfterChange.info);
    assert(!c.staleAfterChange.btnDisabled);
  });

  test("件数が大きく変わったフォルダと、新規フォルダだけを対象にする", async () => {
    const c = await ctx();
    assertEqual(c.incremental.requestedFolderIds, ["101", "400"]);
  });

  test("対象外のフォルダの説明文は変更しない", async () => {
    const c = await ctx();
    assertEqual(c.incremental.f2untouched, "説明:F2");
  });

  test("新規フォルダの説明文を生成し、件数を更新する", async () => {
    const c = await ctx();
    assertEqual(c.incremental.newDescribed, "説明:New");
    assertEqual(c.incremental.f1count, 9);
  });
});
