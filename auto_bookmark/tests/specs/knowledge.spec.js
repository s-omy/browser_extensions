// ③ ページ知識（ナレッジベース同期）を検証する

import { describe, test, assert, assertEqual, assertMatch, lazy } from "../lib/assert.js";
import { B, F, createTree, blocked, httpError, okJson, wait } from "../lib/harness.js";
import { boot, $, text } from "../lib/options-boot.js";

const BASE = location.origin;

// フォルダA(29件、うち1件は除外ドメイン)、フォルダBf(20件、うち2件はAと同URLの重複)、
// 保護フォルダPriv(1件、AIに送信されてはいけない)。
function buildTree() {
  const a = F("20", "A", []);
  for (let i = 1; i <= 25; i++) a.children.push(B("a" + i, "サイト" + i, i === 20 ? "https://bad.example/" : "https://site" + i + ".example/"));
  a.children.push(
    B("pc", "パス変更", "https://pathchange.example/"),
    B("ex", "期限切れ", "https://expired.example/"),
    B("sec", "内部", "https://x.secret.example/"),
    B("m1", "meta由来", "https://meta.example/")
  );
  const bf = F("21", "Bf", [B("k1", "重複1", "https://site1.example/"), B("k2", "重複2", "https://site2.example/")]);
  for (let i = 26; i <= 43; i++) bf.children.push(B("b" + i, "サイト" + i, "https://site" + i + ".example/"));
  const priv = F("30", "[私用]", [B("pv", "私用ページ", "https://private.example/")]);
  return createTree([a, bf, priv]);
}

const seededKnowledgeBase = () => {
  const old = Date.now() - 40 * 24 * 3600 * 1000;
  return {
    "https://pathchange.example/": { subject: "s", summary: "s", description: "d", keywords: ["k1", "k2"], hierarchical_categories: "旧", last_updated_at: Date.now(), source: "ai_estimate" },
    "https://expired.example/": { subject: "old", summary: "o", description: "o", keywords: ["o"], hierarchical_categories: "A", last_updated_at: old },
    "https://deleted.example/": { subject: "gone", summary: "g", description: "g", keywords: ["g"], hierarchical_categories: "A", last_updated_at: Date.now() },
    "https://meta.example/": { subject: "メタ", summary: "実meta", description: "実meta", keywords: ["m1"], hierarchical_categories: "A", last_updated_at: Date.now(), source: "page_meta" }
  };
};

const ctx = lazy(async () => {
  const batches = [];
  const { env, confirms } = await boot(BASE, {
    tree: buildTree(),
    storage: { gemini_key: "K", privacy_settings: { strip_query: false, excluded_domains: ["secret.example"] }, page_knowledge_base: seededKnowledgeBase() },
    handler: req => {
      const input = JSON.parse(req.body.contents[0].parts[1].text);
      batches.push(input);
      if (input.some(i => i.url.includes("bad.example"))) return blocked("PROHIBITED_CONTENT");
      return okJson({ items: input.map(i => ({ id: i.id, subject: "S:" + i.title, summary: "sum", description: "desc", keywords: ["k1", "k2"] })) });
    }
  });

  const initial = {
    plan: text("kb-plan-text"),
    rows: document.querySelectorAll("#kb-table-container tbody tr").length,
    sourceBadges: [...document.querySelectorAll(".attr-badge-source")].map(b => b.textContent).sort()
  };

  $("kb-sync-btn").click();
  await wait(2000);
  const kb = env.storage.page_knowledge_base;
  const sync = {
    confirmHead: confirms[0].split("\n")[0],
    batchSizes: batches.map(b => b.length),
    saved: Object.keys(kb).length,
    badSaved: "https://bad.example/" in kb,
    secretDomainSent: JSON.stringify(batches).includes("secret.example"),
    privateSent: JSON.stringify(batches).includes("private.example"),
    pathUpdated: kb["https://pathchange.example/"].hierarchical_categories,
    subjectKeptOnPathUpdate: kb["https://pathchange.example/"].subject,
    expiredRefreshed: kb["https://expired.example/"].subject,
    sourceOfNewEntry: kb["https://site1.example/"].source,
    dupPathUsesFirstFolder: kb["https://site1.example/"].hierarchical_categories,
    deletedEntryPurged: !("https://deleted.example/" in kb),
    metaRecordUntouched: kb["https://meta.example/"].source,
    status: text("kb-sync-status")
  };

  // タグ編集: 追加・削除できて、他URLのナレッジを壊さない
  window.__promptAnswer = "新タグ";
  const beforeCount = Object.keys(env.storage.page_knowledge_base).length;
  document.querySelector(".tag-add-btn").click();
  await wait(300);
  const editedUrl = Object.keys(env.storage.page_knowledge_base).find(u => env.storage.page_knowledge_base[u].keywords.includes("新タグ"));
  document.querySelector(".tag-delete-btn").click();
  await wait(300);
  const tagEdit = {
    added: !!editedUrl,
    countUnchanged: Object.keys(env.storage.page_knowledge_base).length === beforeCount
  };

  return { initial, sync, tagEdit };
});

describe("ナレッジ同期: 計画（ローカル計算のみ、画面を開いただけではAPIを呼ばない）", () => {
  test("保護フォルダ内のブックマークは同期計画に含めない", async () => {
    const c = await ctx();
    assert(!c.initial.plan.includes("48"), "sanity: 保護フォルダを含めた総数がそのまま出てはいけない");
    assert(c.initial.plan.includes("AIに送信しないURL"), "送信しない件数の注記がある");
  });

  test("蓄積済みのナレッジ一覧に、出所（AI推定 / meta）のバッジを表示する（削除済みページは画面を開いた時点で整理済み）", async () => {
    const c = await ctx();
    assertEqual(c.initial.sourceBadges, ["AI推定", "AI推定", "meta"]);
  });
});

describe("ナレッジ同期: 実行", () => {
  test("実行前に、対象件数と概算のAPI呼び出し回数を確認する", async () => {
    const c = await ctx();
    assertMatch(c.sync.confirmHead, /^\d+ 件のブックマーク（新規 \d+ 件 \/ 期限切れ \d+ 件）についてAIに問い合わせます。$/);
  });

  test("複数件を1回のAPI呼び出しにまとめる（最大20件/回）", async () => {
    const c = await ctx();
    assert(c.sync.batchSizes.length > 1, "複数バッチに分かれる");
    assert(c.sync.batchSizes.every(n => n <= 20), "1回あたり最大20件");
  });

  test("ブロックされたURLは保存せず、除外ドメイン・保護フォルダのURLは送信しない", async () => {
    const c = await ctx();
    assert(!c.sync.badSaved);
    assert(!c.sync.secretDomainSent);
    assert(!c.sync.privateSent);
  });

  test("パスだけが変わった項目は、AIを呼ばずパス欄だけ更新する（他の項目は保持）", async () => {
    const c = await ctx();
    assertEqual(c.sync.pathUpdated, "A");
    assertEqual(c.sync.subjectKeptOnPathUpdate, "s");
  });

  test("期限切れの項目は再取得する", async () => {
    const c = await ctx();
    assertEqual(c.sync.expiredRefreshed, "S:期限切れ");
  });

  test("新規取得したナレッジには、出所がAI推定と記録される", async () => {
    const c = await ctx();
    assertEqual(c.sync.sourceOfNewEntry, "ai_estimate");
  });

  test("同じURLが複数フォルダにあっても、ナレッジは1件にまとめる", async () => {
    const c = await ctx();
    assertEqual(c.sync.dupPathUsesFirstFolder, "A", "最初に見つかったフォルダのパスを使う");
  });

  test("削除済みのブックマークのナレッジは掃除する", async () => {
    const c = await ctx();
    assert(c.sync.deletedEntryPurged);
  });

  test("右クリック時に読み取った実際のmeta情報は、同期で上書きしない", async () => {
    const c = await ctx();
    assertEqual(c.sync.metaRecordUntouched, "page_meta");
  });

  test("完了メッセージに、保存件数とブロックされた件数・理由を表示する", async () => {
    const c = await ctx();
    assert(c.sync.status.includes("件のナレッジを保存しました"));
    assert(c.sync.status.includes("AIが判定できず保存していません"));
    assert(c.sync.status.includes("AIの応答がブロックされました (PROHIBITED_CONTENT)"));
  });
});

describe("ナレッジ同期: キーワードタグの手動編集", () => {
  test("追加・削除でき、他のURLのナレッジは壊れない", async () => {
    const c = await ctx();
    assert(c.tagEdit.added, "「+ 追加」でタグが増える");
    assert(c.tagEdit.countUnchanged, "編集してもURLの件数は変わらない");
  });
});

const fatalCtx = lazy(async () => {
  const tree = createTree([F("20", "A", Array.from({ length: 5 }, (_, i) => B("f" + i, "記事" + i, "https://fatal" + i + ".example/")))]);
  const { env } = await boot(BASE, {
    tree,
    storage: { gemini_key: "K" },
    handler: () => httpError(401, "API key not valid")
  });
  $("kb-sync-btn").click();
  await wait(600); // 確認ダイアログ（window.confirm）を経て実行される
  return { saved: Object.keys(env.storage.page_knowledge_base || {}).length, status: text("kb-sync-status"), syncEnabled: !$("kb-sync-btn").disabled, stopHidden: $("kb-stop-btn").hidden };
});

describe("ナレッジ同期: 致命的なAPIエラーで中断する", () => {
  test("中断してもボタン類は元に戻り、何も保存されない", async () => {
    const c = await fatalCtx();
    assertEqual(c.saved, 0);
    assert(c.status.includes("APIエラーのため中断しました"));
    assert(c.syncEnabled);
    assert(c.stopHidden);
  });
});
