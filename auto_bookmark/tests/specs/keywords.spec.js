// キーワード（ページ知識のタグ）の扱いを検証する。
// keywords.js の純粋関数のほか、既存データの移行・AI応答・右クリック時のmeta・ナレッジ一覧の編集・②への引き渡しを通しで確認する。

import { describe, test, assert, assertEqual, lazy } from "../lib/assert.js";
import { B, F, createTree, installChrome, okJson, wait } from "../lib/harness.js";
import { boot, $, cleanseEcho } from "../lib/options-boot.js";

const BASE = location.origin;
const mod = lazy(() => import(BASE + "/keywords.js"));

describe("keywords.js: normalizeKeywords（区切りと語の扱い）", () => {
  test("半角カンマ（空白あり・なし）で分ける", async () => {
    const { normalizeKeywords } = await mod();
    assertEqual(normalizeKeywords("React, JavaScript,UI"), ["React", "JavaScript", "UI"]);
  });

  test("空白だけで区切られた文字列は、語ごとに分ける（1つのタグにしない）", async () => {
    const { normalizeKeywords } = await mod();
    assertEqual(normalizeKeywords("React JavaScript UI"), ["React", "JavaScript", "UI"]);
  });

  test("全角の読点・カンマ・空白、改行、タブ、; / | も区切りとして扱う", async () => {
    const { normalizeKeywords } = await mod();
    assertEqual(normalizeKeywords("動画、共有，配信　サービス\nUI\tUX;A/B|C"), ["動画", "共有", "配信", "サービス", "UI", "UX", "A", "B", "C"]);
  });

  test("アンダースコア・ハイフン・CamelCase は区切らず、語の一部として保持する", async () => {
    const { normalizeKeywords } = await mod();
    assertEqual(normalizeKeywords("machine_learning MachineLearning e-commerce"), ["machine_learning", "MachineLearning", "e-commerce"]);
  });

  test("大文字・小文字の違いだけの重複は、最初の綴りを残して1つにまとめる", async () => {
    const { normalizeKeywords } = await mod();
    assertEqual(normalizeKeywords("React, react, REACT, Vue"), ["React", "Vue"]);
  });

  test("空・空白のみ・区切りのみ・null/undefined・文字列以外は、空配列になる", async () => {
    const { normalizeKeywords } = await mod();
    for (const input of ["", "  ", ",、;", null, undefined, 42, {}]) assertEqual(normalizeKeywords(input), [], "入力: " + JSON.stringify(input));
  });

  test("配列を渡すと各要素を同じ規則で分ける（要素の中に区切りがあっても1語ずつになる）", async () => {
    const { normalizeKeywords } = await mod();
    assertEqual(normalizeKeywords(["React", "machine learning", "a, b", "", null]), ["React", "machine", "learning", "a", "b"]);
  });

  test("何度通しても結果は変わらない（冪等）", async () => {
    const { normalizeKeywords } = await mod();
    const once = normalizeKeywords("動画、共有 プラットフォーム, machine_learning");
    assertEqual(normalizeKeywords(once), once);
  });
});

describe("keywords.js: getKeywords（旧形式の読み取り）", () => {
  test("keywords（配列）があればそれを使う", async () => {
    const { getKeywords } = await mod();
    assertEqual(getKeywords({ keywords: ["a", "b"], keyword: "無視される" }), ["a", "b"]);
  });

  test("keywords が無ければ、旧形式の keyword（文字列）を語に分けて返す", async () => {
    const { getKeywords } = await mod();
    assertEqual(getKeywords({ keyword: "React JavaScript, UI" }), ["React", "JavaScript", "UI"]);
  });

  test("どちらも無い・項目自体が無い場合は空配列", async () => {
    const { getKeywords } = await mod();
    assertEqual(getKeywords({}), []);
    assertEqual(getKeywords(undefined), []);
  });
});

// ---- 既存データの移行（storage_version 2 → 3） ----

const legacyEntry = (keyword, extra = {}) => ({
  subject: "件名", summary: "要約", description: "説明", keyword, hierarchical_categories: "開発", last_updated_at: 1234567890, source: "ai_estimate", ...extra
});

describe("storage.js: キーワードの移行（keyword 文字列 → keywords 配列）", () => {
  const ctx = lazy(async () => {
    const storage = await import(BASE + "/storage.js");
    const env = installChrome({
      tree: createTree([]),
      storage: {
        storage_version: 2,
        gemini_key: "K",
        page_knowledge_base: {
          "https://a.example/": legacyEntry("React, JavaScript"),
          "https://b.example/": legacyEntry("React JavaScript UI", { source: "page_meta" }),
          "https://c.example/": legacyEntry("動画、共有\nプラットフォーム"),
          "https://d.example/": legacyEntry(""),
          "https://e.example/": { ...legacyEntry(undefined), keyword: undefined, keywords: ["already", "done"] }
        }
      }
    });
    const before = JSON.parse(JSON.stringify(env.storage.page_knowledge_base));
    const migrated = await storage.migrateLegacyStorage();
    const after = JSON.parse(JSON.stringify(env.storage.page_knowledge_base));
    const setsBeforeSecond = env.calls.storageSets.length;
    const again = await storage.migrateLegacyStorage();

    // 失敗時: 変換の途中で例外が出たら、何も書かず、バージョンも上げない
    const failEnv = installChrome({
      tree: createTree([]),
      storage: { gemini_key: "K", folder_descriptions: { 開発: "x" }, page_knowledge_base: { "https://z.example/": legacyEntry("a b") } }
    });
    window.chrome.bookmarks.getTree = async () => {
      throw new Error("boom");
    };
    const failed = await storage.migrateLegacyStorage();
    return { env, before, after, migrated, again, secondRunWrites: env.calls.storageSets.length - setsBeforeSecond, failEnv, failed };
  });

  test("既存のすべてのキーワードを、語ごとの配列へ変換する（区切りが違っても語が欠けない）", async () => {
    const { after } = await ctx();
    assertEqual(after["https://a.example/"].keywords, ["React", "JavaScript"]);
    assertEqual(after["https://b.example/"].keywords, ["React", "JavaScript", "UI"]);
    assertEqual(after["https://c.example/"].keywords, ["動画", "共有", "プラットフォーム"]);
    assertEqual(after["https://d.example/"].keywords, []);
    assertEqual(after["https://e.example/"].keywords, ["already", "done"], "変換済みの項目は変更しない");
  });

  test("旧キー keyword は取り除き、キーワード以外の項目（要約・説明・出典・所属パス・更新日時）は変更しない", async () => {
    const { before, after } = await ctx();
    for (const url of ["https://a.example/", "https://b.example/", "https://c.example/", "https://d.example/"]) {
      assert(!("keyword" in after[url]), url + " から旧キーが消えている");
      for (const key of ["subject", "summary", "description", "hierarchical_categories", "last_updated_at", "source"]) {
        assertEqual(after[url][key], before[url][key], url + " の " + key);
      }
    }
  });

  test("バージョンが 3 になり、2回目以降は何も変更しない（冪等）", async () => {
    const { env, migrated, again, secondRunWrites } = await ctx();
    assert(migrated === true && again === false);
    assertEqual(env.storage.storage_version, 3);
    assertEqual(secondRunWrites, 0, "2回目は書き込まない");
  });

  test("移行に失敗したときは、既存のデータを変更せず、バージョンも上げない（次回の起動で再試行される）", async () => {
    const { failEnv, failed } = await ctx();
    assert(failed === false);
    assertEqual(failEnv.storage.page_knowledge_base["https://z.example/"].keyword, "a b");
    assert(!("keywords" in failEnv.storage.page_knowledge_base["https://z.example/"]));
    assert(!("storage_version" in failEnv.storage), "バージョンは据え置き");
  });
});

// ---- AI が生成するキーワード（③ 同期） ----

const tagsOf = title => {
  const top = [...document.querySelectorAll(".row-meta-top")].find(row => row.textContent.includes(title));
  return [...top.nextElementSibling.querySelectorAll(".tag-item")].map(tag => tag.firstChild.textContent);
};

describe("ナレッジ同期: AI が生成するキーワード", () => {
  const ctx = lazy(async () => {
    const requests = [];
    const { env } = await boot(BASE, {
      tree: createTree([F("20", "A", [B("a1", "React入門", "https://react.example/"), B("a2", "ML講座", "https://ml.example/")])]),
      storage: { gemini_key: "K" },
      handler: req => {
        requests.push(req);
        const input = JSON.parse(req.body.contents[0].parts[1].text);
        return okJson({
          items: input.map(i => ({
            id: i.id,
            subject: "S:" + i.title,
            summary: "s",
            description: "d",
            // 2件目は、AI が書式を守らず、要素の中に空白やカンマを含めた場合
            keywords: i.url.includes("react") ? ["React", "JavaScript", "UI"] : ["machine learning", "deep_learning", "A, B"]
          }))
        });
      }
    });
    $("kb-sync-btn").click();
    await wait(800);
    return { env, requests, kb: env.storage.page_knowledge_base, mlTags: tagsOf("ML講座"), reactTags: tagsOf("React入門") };
  });

  test("AI へのリクエストは、keywords を文字列の配列で返すスキーマにし、必須項目にする", async () => {
    const { requests } = await ctx();
    const itemSchema = requests[0].schema.properties.items.items;
    assertEqual(itemSchema.properties.keywords, { type: "ARRAY", items: { type: "STRING" } });
    assert(itemSchema.required.includes("keywords"));
    assert(!("keyword" in itemSchema.properties), "旧フィールドは求めない");
  });

  test("プロンプトで、1語ずつ・複数語は machine_learning / MachineLearning の書き方を指示する", async () => {
    const { requests } = await ctx();
    assert(requests[0].texts.includes("1語ずつ"));
    assert(requests[0].texts.includes("machine_learning"));
    assert(requests[0].texts.includes("MachineLearning"));
  });

  test("AI が返した配列を保存する。要素の中に空白・カンマがあっても、1語ずつのタグにそろえる", async () => {
    const { kb, mlTags, reactTags } = await ctx();
    assertEqual(kb["https://react.example/"].keywords, ["React", "JavaScript", "UI"]);
    assertEqual(kb["https://ml.example/"].keywords, ["machine", "learning", "deep_learning", "A", "B"]);
    assertEqual(reactTags, ["React", "JavaScript", "UI"]);
    assertEqual(mlTags, ["machine", "learning", "deep_learning", "A", "B"]);
  });
});

// ---- 右クリック時に読み取ったページの meta 情報 ----

describe("右クリック保存: ページのキーワード情報", () => {
  const ctx = lazy(async () => {
    const env = installChrome({ tree: createTree([]), storage: {} });
    const knowledge = await import(BASE + "/knowledge.js");
    const save = (n, meta) => knowledge.recordPageMetaKnowledge({ url: "https://m" + n + ".example/", title: "T", meta, path: "開発" });
    const results = [
      await save(1, { description: "説明1", keywords: "React JavaScript、UI, react" }),
      await save(2, { description: "説明2", keywords: "" }),
      await save(3, { description: "説明3", keywords: ",、 ;" }),
      await save(4, { description: "", keywords: "" })
    ];
    return { kb: env.storage.page_knowledge_base, results };
  });

  test("空白・読点・カンマのどれで区切られていても、語の配列として保存する", async () => {
    const { kb } = await ctx();
    assertEqual(kb["https://m1.example/"].keywords, ["React", "JavaScript", "UI"]);
    assertEqual(kb["https://m1.example/"].source, "page_meta");
  });

  test("キーワード情報が空、または区切りだけのときは、キーワードを空として保存する", async () => {
    const { kb } = await ctx();
    assertEqual(kb["https://m2.example/"].keywords, []);
    assertEqual(kb["https://m3.example/"].keywords, []);
  });

  test("説明もキーワードも無いページは、ナレッジとして保存しない", async () => {
    const { kb, results } = await ctx();
    assert(results[3] === false && !("https://m4.example/" in kb));
  });
});

// ---- ナレッジ一覧のタグ表示・編集 ----

describe("ナレッジ一覧: タグの表示と編集", () => {
  const tree = createTree([
    F("20", "A", [
      B("a1", "旧空白", "https://sp.example/"),
      B("a2", "旧読点", "https://jp.example/"),
      B("a3", "新配列", "https://arr.example/"),
      B("a4", "キーなし", "https://none.example/")
    ])
  ]);
  const entry = extra => ({ subject: "件名", summary: "要約", description: "説明", hierarchical_categories: "A", last_updated_at: Date.now(), source: "ai_estimate", ...extra });
  const seeded = () => ({
    "https://sp.example/": entry({ keyword: "React JavaScript UI" }), // 移行前の旧形式（空白区切り）
    "https://jp.example/": entry({ keyword: "動画、共有 配信" }), // 移行前の旧形式（読点・空白）
    "https://arr.example/": entry({ keywords: ["machine_learning", "MachineLearning"] }),
    "https://none.example/": entry({ keywords: [] })
  });

  const ctx = lazy(async () => {
    const { env } = await boot(BASE, { tree, storage: { gemini_key: "K", page_knowledge_base: seeded() } });
    const initial = { sp: tagsOf("旧空白"), jp: tagsOf("旧読点"), arr: tagsOf("新配列"), none: tagsOf("キーなし") };

    // 追加: 空白・カンマ・改行で区切った複数語を貼り付けると、複数のタグになる（重複・大文字小文字違いは追加しない）
    window.__promptAnswer = "新規 machine_learning react\nUI, ui";
    [...document.querySelectorAll(".row-meta-top")].find(r => r.textContent.includes("新配列")).nextElementSibling.querySelector(".tag-add-btn").click();
    await wait(300);
    const afterAdd = { arr: tagsOf("新配列"), stored: env.storage.page_knowledge_base["https://arr.example/"].keywords };

    // 旧形式の項目を編集すると、keywords（配列）に置き換わる
    window.__promptAnswer = "追加";
    [...document.querySelectorAll(".row-meta-top")].find(r => r.textContent.includes("旧空白")).nextElementSibling.querySelector(".tag-add-btn").click();
    await wait(300);
    const legacyEdited = env.storage.page_knowledge_base["https://sp.example/"];

    // 削除: 指定したタグだけが消える
    [...document.querySelectorAll(".row-meta-top")].find(r => r.textContent.includes("新配列")).nextElementSibling.querySelector(".tag-delete-btn").click();
    await wait(300);
    const afterDelete = { arr: tagsOf("新配列"), stored: env.storage.page_knowledge_base["https://arr.example/"].keywords };

    // 画面を開き直しても、編集内容が保たれる
    await boot(BASE, { tree, storage: env.storage });
    const reopened = tagsOf("新配列");

    return { initial, afterAdd, legacyEdited, afterDelete, reopened };
  });

  test("旧形式（空白・読点区切り）のデータも、語ごとの別のタグとして表示する", async () => {
    const { initial } = await ctx();
    assertEqual(initial.sp, ["React", "JavaScript", "UI"]);
    assertEqual(initial.jp, ["動画", "共有", "配信"]);
    assertEqual(initial.arr, ["machine_learning", "MachineLearning"], "_ と CamelCase は 1 語として保持");
    assertEqual(initial.none, []);
  });

  test("追加の入力は語に分けて、それぞれ別のタグにする（重複は追加しない）", async () => {
    const { afterAdd } = await ctx();
    assertEqual(afterAdd.stored, ["machine_learning", "MachineLearning", "新規", "react", "UI"]);
    assertEqual(afterAdd.arr, afterAdd.stored);
  });

  test("旧形式の項目を編集すると、keywords の配列に置き換わる（旧キーは残さない）", async () => {
    const { legacyEdited } = await ctx();
    assertEqual(legacyEdited.keywords, ["React", "JavaScript", "UI", "追加"]);
    assert(!("keyword" in legacyEdited));
  });

  test("削除は指定したタグだけを消し、内容は画面を開き直しても保持される", async () => {
    const { afterDelete, reopened } = await ctx();
    assertEqual(afterDelete.stored, ["MachineLearning", "新規", "react", "UI"]);
    assertEqual(reopened, afterDelete.stored);
  });
});

// ---- ② 再カテゴライズへの引き渡し ----

describe("再カテゴライズ: 判断材料としてのキーワード", () => {
  const ctx = lazy(async () => {
    const seen = [];
    const kbEntry = extra => ({ subject: "S", summary: "s", description: "d", hierarchical_categories: "A", last_updated_at: Date.now(), source: "ai_estimate", ...extra });
    await boot(BASE, {
      tree: createTree([
        F("20", "A", [B("a1", "配列", "https://arr.example/"), B("a2", "なし", "https://none.example/"), B("a3", "空", "https://empty.example/"), B("a4", "旧形式", "https://old.example/")]),
        F("21", "B", [B("b1", "別", "https://other.example/")])
      ]),
      storage: {
        gemini_key: "K",
        folder_descriptions_by_id: { 20: "A", 21: "B" },
        page_knowledge_base: {
          "https://arr.example/": kbEntry({ keywords: ["x", "machine_learning"] }),
          "https://empty.example/": kbEntry({ keywords: [] }),
          "https://old.example/": kbEntry({ keyword: "p q, r" }) // 移行前の旧形式
        }
      },
      handler: req => {
        const cleansed = cleanseEcho(req);
        if (cleansed) return cleansed;
        const list = JSON.parse(req.texts.split("処理リスト:\n")[1]);
        seen.push(...list);
        return okJson({ relocations: list.map(i => ({ id: i.id, target_folder_id: i.current_folder_id, confidence_score: 80, reason: "r" })) });
      }
    });
    $("relocate-btn").click();
    await wait(1500);
    const contextOf = url => seen.find(i => i.url === url)?.ai_knowledge_context;
    return { arr: contextOf("https://arr.example/"), none: contextOf("https://none.example/"), empty: contextOf("https://empty.example/"), old: contextOf("https://old.example/") };
  });

  test("ナレッジのキーワードを、語の配列として判断材料に含める（旧形式のデータも同じ語の内容で渡す）", async () => {
    const { arr, old } = await ctx();
    assertEqual(arr.keywords, ["x", "machine_learning"]);
    assertEqual(old.keywords, ["p", "q", "r"]);
  });

  test("キーワードが空のナレッジは、空の配列として渡す。ナレッジが無いページは従来どおり「無し」", async () => {
    const { none, empty } = await ctx();
    assertEqual(empty.keywords, []);
    assertEqual(none, "無し");
  });
});
