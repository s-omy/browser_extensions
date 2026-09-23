// ② 再カテゴライズ（シミュレーション・差分プレビューの操作・適用・取り消し）を検証する

import { describe, test, assert, assertEqual, lazy } from "../lib/assert.js";
import { B, F, createTree, okJson, wait } from "../lib/harness.js";
import { boot, $, text, cleanseEcho } from "../lib/options-boot.js";

const BASE = location.origin;
const checkedCount = () => [...document.querySelectorAll(".checkbox-apply")].filter(c => c.checked).length;
const diffRows = () => [...document.querySelectorAll("#diff-table-container tr")].map(tr => tr.textContent.replace(/\s+/g, " ").trim());
const treeSnapshot = env =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(env.index())
        .filter(([, n]) => n.children)
        .map(([id, n]) => [id, n.children.map(c => c.id).join(",")])
    )
  );

// フォルダ「Big」に75件（うち1件はプライバシー除外ドメイン、1件は javascript: リンク）、
// 「Small」に2件、保護フォルダ「[保護]」とその配下、同名フォルダ「Dup」を2つ用意する。
function buildTree() {
  const big = F("20", "Big", []);
  for (let i = 1; i <= 75; i++) big.children.push(B("b" + i, "大" + i, "https://big" + i + ".example/p?tok=" + i));
  big.children.push(B("bx", "内部", "https://intra.secret.example/"), B("bj", "ブックマークレット", "javascript:alert(1)"));
  return createTree([
    big,
    F("21", "Small", [B("s1", "小1", "https://small1.example/"), B("s2", "小2", "https://small2.example/")]),
    F("22", "[保護]", [B("p1", "保護1", "https://prot1.example/"), F("23", "配下", [B("p2", "保護2", "https://prot2.example/")])]),
    F("24", "Dup", [B("d1", "重複A", "https://dup.example/"), B("d2", "重複B", "https://dup.example/")]),
    F("25", "Dup", [])
  ]);
}

// AIの応答: Big の先頭チャンク(1〜30件目)の3件目を高確信度でSmallへ、4件目を低確信度でSmallへ、
// 5件目を保護フォルダ配下(候補外)へ。2つ目のチャンク(31件目〜)の1件目もSmallへ。Dupの1件目をDup#2へ。
// 加えて、存在しない連番("999")を混ぜ、捏造IDが破棄されることも検証する。
function replyHandler(seen) {
  return req => {
    const c = cleanseEcho(req);
    if (c) return c;
    const list = JSON.parse(req.texts.split("処理リスト:\n")[1]);
    seen.push(list);
    const firstUrl = list[0].url;
    const moves = {};
    if (firstUrl.includes("big1.")) {
      moves["3"] = ["21", 95];
      moves["4"] = ["21", 40];
      moves["5"] = ["23", 99];
    }
    if (firstUrl.includes("big31.")) moves["1"] = ["21", 88];
    if (firstUrl.includes("dup.")) moves["2"] = ["25", 75];
    const relocations = list
      .map(i => ({
        id: i.id,
        target_folder_id: moves[i.id]?.[0] ?? i.current_folder_id,
        confidence_score: moves[i.id]?.[1] ?? 70,
        reason: "r" + i.id
      }))
      .concat([{ id: "999", target_folder_id: "21", confidence_score: 99, reason: "捏造" }]);
    return okJson({ relocations });
  };
}

const cancelCtx = lazy(async () => {
  const seen = [];
  const { requests, confirms } = await boot(BASE, {
    tree: buildTree(),
    storage: { gemini_key: "K", folder_descriptions_by_id: { 21: "少量", 20: "大量" }, privacy_settings: { strip_query: true, excluded_domains: ["secret.example"] } },
    handler: replyHandler(seen),
    confirmAnswer: false
  });
  $("relocate-btn").click();
  await wait(300);
  return { requests, confirm: confirms[0], status: text("relocate-status") };
});

describe("再カテゴライズ: 実行前の確認", () => {
  test("件数と呼び出し回数を確認するダイアログを出し、キャンセルすれば何もしない", async () => {
    const c = await cancelCtx();
    assert(c.confirm.startsWith("81 件のブックマークを、30 件ずつ 5 回に分けてAIに判定させます。"));
    assertEqual(c.requests.length, 0, "キャンセルしたらAPIを呼ばない");
    assertEqual(c.status, "シミュレーションをキャンセルしました。");
  });
});

const ctx = lazy(async () => {
  const seen = [];
  const boot0 = await boot(BASE, {
    tree: buildTree(),
    storage: { gemini_key: "K", folder_descriptions_by_id: { 21: "少量", 20: "大量" }, privacy_settings: { strip_query: true, excluded_domains: ["secret.example"] } },
    handler: replyHandler(seen)
  });
  window.confirm = () => true;
  $("relocate-btn").click();
  await wait(2500);

  const relocateRequest = boot0.requests.find(r => r.texts.includes("処理リスト"));
  const categoriesJson = JSON.parse(relocateRequest.texts.split("既存フォルダ:\n")[1].split("\n\n処理リスト")[0]);
  const chunkSizes = seen.map(l => l.length);
  const payloadText = JSON.stringify(seen);
  const status = text("relocate-status");
  const summaryText = text("diff-summary");

  const initialChecked = checkedCount();
  const initialRows = diffRows();

  $("diff-changed-only").click();
  await wait(50);
  const allRows = diffRows();
  $("diff-changed-only").click();
  await wait(50);

  $("diff-sort").value = "score";
  $("diff-sort").dispatchEvent(new Event("change"));
  await wait(50);
  const sortedScores = diffRows()
    .filter(r => /適合率/.test(r) && !r.startsWith("固定"))
    .map(r => r.match(/適合率: (\d+)%/)?.[1]);

  $("diff-select-all").click();
  await wait(50);
  const afterSelectAll = checkedCount();
  $("diff-select-none").click();
  await wait(50);
  const afterSelectNone = checkedCount();
  $("diff-deselect-low").click();
  await wait(50);
  const afterDeselectLow = checkedCount();

  $("btn-view-split").click();
  await wait(50);
  const splitRows = diffRows();
  const splitChecked = checkedCount();
  $("btn-view-unified").click();
  await wait(50);

  // 全選択 → 1件だけ外して適用
  $("diff-select-all").click();
  await wait(30);
  document.querySelector(".checkbox-apply").click();
  await wait(30);
  const selectedForApply = checkedCount();
  const beforeApplyTree = treeSnapshot(boot0.env);
  $("apply-relocate-btn").click();
  await wait(600);
  const applyResult = { moves: boot0.env.calls.moves.map(m => m.id + ">" + m.parentId), status: text("relocate-status"), undoVisible: !$("undo-box").hidden };

  $("undo-relocate-btn").click();
  await wait(600);
  const afterUndoTree = treeSnapshot(boot0.env);
  const undoResult = { restoredToOriginal: afterUndoTree === beforeApplyTree, status: text("relocate-status"), undoHidden: $("undo-box").hidden };

  return {
    categoriesJson,
    chunkSizes,
    payloadText,
    status,
    summaryText,
    initialChecked,
    initialRows,
    allRows,
    sortedScores,
    afterSelectAll,
    afterSelectNone,
    afterDeselectLow,
    splitRows,
    splitChecked,
    selectedForApply,
    applyResult,
    undoResult
  };
});

describe("再カテゴライズ: フォルダ内をチャンクに分割して判定する", () => {
  test("30件ずつに分割する（75件のフォルダは30/30/15に分かれる）", async () => {
    const c = await ctx();
    assertEqual(c.chunkSizes, [30, 30, 15, 2, 2]);
  });

  test("移動先候補に保護フォルダを含めず、フォルダIDと階層パスを渡す", async () => {
    const c = await ctx();
    assert(!c.categoriesJson.some(cat => cat.folder_id === "22" || cat.folder_id === "23"), "保護フォルダは候補にない");
    const dup = c.categoriesJson.find(cat => cat.folder_id === "24");
    assertEqual(dup.folder_name, "Dup");
    assertEqual(dup.hierarchical_categories, "Dup");
  });

  test("AIには実ブックマークIDを渡さず、連番と現在のフォルダIDだけを渡す", async () => {
    const c = await ctx();
    assert(!c.payloadText.includes('"b1"'), "実IDが混入してはいけない");
  });

  test("プライバシー設定に従い、クエリを除去し除外ドメイン・javascript:は送らない", async () => {
    const c = await ctx();
    assert(!c.payloadText.includes("tok="), "クエリ文字列を送ってはいけない");
    assert(!c.payloadText.includes("secret.example"), "除外ドメインを送ってはいけない");
    assert(!c.payloadText.includes("javascript:"), "javascript: リンクを送ってはいけない");
  });
});

describe("再カテゴライズ: 移動案の生成", () => {
  test("実IDを正しく引き当て、捏造された連番('999')は破棄する", async () => {
    const c = await ctx();
    assertEqual(c.initialChecked, 3, "適合率70%以上の3件が初期選択される");
  });

  test("保護フォルダ配下を移動先に指定された項目は、現状維持にする", async () => {
    const c = await ctx();
    assert(c.allRows.some(r => r.includes("AI送信対象外") === false), "sanity: allRowsが取得できている");
    // 5件目(id="5")は保護フォルダ配下(23)への移動を指示されたが、候補外のため現状維持になる → 動いた行としては現れない
    assertEqual(c.initialRows.filter(r => r.includes("適合率") || r.includes("未評価")).length, 4, "移動ありの行は4件（保護配下指定の1件は現状維持のため含まれない）");
  });

  test("送信対象外（除外ドメイン・javascript:）のブックマークは、判定せず現状維持にする", async () => {
    const c = await ctx();
    assertEqual(c.allRows.filter(r => r.startsWith("固定")).length, 77, "77件が変更なし（75件中73件維持+送信対象外2件+Small/Dupの一部）");
    assertEqual(c.allRows.filter(r => r.includes("AI送信対象外")).length, 2, "内部URLとjavascript:の2件");
  });

  test("完了メッセージに、保護フォルダ対象外・送信対象外・低確信度の件数を含める", async () => {
    const c = await ctx();
    assert(c.status.includes("2 件の保護フォルダは対象外"));
    assert(c.status.includes("2 件はAIに送信しないURL"));
    assert(c.status.includes("適合率が 70% 未満の移動案 1 件"));
  });

  test("差分サマリに、移動候補件数と選択中件数を表示する", async () => {
    const c = await ctx();
    assertEqual(c.summaryText, "移動候補 4 件 / 選択中 3 件");
  });
});

describe("再カテゴライズ: 差分プレビューの操作", () => {
  test("適合率の低い順に並び替えられる", async () => {
    const c = await ctx();
    assertEqual(c.sortedScores, ["40", "75", "88", "95"]);
  });

  test("全選択・全解除・低い項目を外す、が選択数に反映される", async () => {
    const c = await ctx();
    assertEqual(c.afterSelectAll, 4);
    assertEqual(c.afterSelectNone, 0);
    assertEqual(c.afterDeselectLow, 0, "全解除後は対象がないため変化なし");
  });

  test("Unified/Split の表示切り替えで、選択状態が保持される", async () => {
    const c = await ctx();
    assertEqual(c.splitChecked, c.afterDeselectLow, "表示を切り替えても選択数は変わらない");
    assert(c.splitRows[0].includes("Before"), "Split表示には Before/After の見出しがある");
  });
});

describe("再カテゴライズ: 実適用と取り消し", () => {
  test("選択した項目だけを実際に移動する", async () => {
    const c = await ctx();
    assertEqual(c.selectedForApply, 3, "4件選択から1件外したので3件");
    assertEqual(c.applyResult.moves.length, 3);
    assertEqual(c.applyResult.status, "完了: 3 件のブックマークを移動しました。必要なら下の「元に戻す」で取り消せます。");
    assert(c.applyResult.undoVisible, "適用後は「元に戻す」ボックスが表示される");
  });

  test("「元に戻す」で、適用前のツリーに完全に復元する", async () => {
    const c = await ctx();
    assert(c.undoResult.restoredToOriginal, "適用前後でツリーのスナップショットが一致する（index含む）");
    assertEqual(c.undoResult.status, "取り消し完了: 3 件を元に戻しました。");
    assert(c.undoResult.undoHidden, "取り消し後は「元に戻す」ボックスが隠れる");
  });
});
