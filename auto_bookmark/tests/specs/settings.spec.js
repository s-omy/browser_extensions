// 設定画面の「基本設定」ブロック（APIキー・接続テスト・プライバシー・クイック保存先）を検証する

import { describe, test, assert, assertEqual, assertMatch, lazy } from "../lib/assert.js";
import { F, createTree, httpError, okJson, okChatJson, wait } from "../lib/harness.js";
import { boot, $, text } from "../lib/options-boot.js";

const BASE = location.origin;

const ctx = lazy(async () => {
  const tree = createTree([F("10", "開発", []), F("11", "[保護]", []), F("12", "生活", [F("13", "投資", [])])]);
  const { env } = await boot(BASE, {
    tree,
    storage: { gemini_key: "SAVED", privacy_settings: { strip_query: true, excluded_domains: ["a.example"] }, quick_folders: ["10"] },
    handler: req => (req.headers["x-goog-api-key"] === "GOOD" ? okJson("OK") : httpError(400, "API key not valid"))
  });

  const initial = {
    apiKey: $("api-key").value,
    strip: $("privacy-strip-query").checked,
    domains: $("privacy-excluded-domains").value,
    quickChecked: [...document.querySelectorAll("#quick-folder-list input")].filter(c => c.checked).map(c => c.value),
    quickLabels: [...document.querySelectorAll("#quick-folder-list label")].map(l => l.textContent)
  };

  $("api-key").value = "GOOD";
  $("save-btn").click();
  await wait(100);
  const saved = { stored: env.storage.gemini_key, status: text("api-key-status") };

  $("api-key").value = "BAD";
  $("test-btn").click();
  await wait(400);
  const testBad = text("api-key-status");

  $("api-key").value = "GOOD";
  $("test-btn").click();
  await wait(400);
  const testGood = text("api-key-status");
  const logAfterTest = text("log-summary");

  $("api-key").value = "";
  $("test-btn").click();
  await wait(50);
  const testEmpty = text("api-key-status");

  $("privacy-strip-query").checked = false;
  $("privacy-excluded-domains").value = "Foo.com, https://bar.example/x\nfoo.com";
  $("privacy-save-btn").click();
  await wait(100);
  const privacySaved = { stored: env.storage.privacy_settings, textarea: $("privacy-excluded-domains").value };

  const boxes = [...document.querySelectorAll("#quick-folder-list input")];
  boxes.forEach(b => {
    b.checked = true;
  });
  boxes[5]?.dispatchEvent(new Event("change", { bubbles: true })); // 上限(5件)を超えた分は、変更イベントでチェックが戻る
  const checkedBeforeSave = boxes.filter(b => b.checked).length;
  $("quick-folder-save-btn").click();
  await wait(100);
  const quickSaved = { checkedBeforeSave, checkedAfterSave: boxes.filter(b => b.checked).length, stored: env.storage.quick_folders };

  return { env, initial, saved, testBad, testGood, testEmpty, logAfterTest, privacySaved, quickSaved };
});

describe("設定画面: APIキー", () => {
  test("画面を開くと、保存済みのキーが復元される（この時点でAPIは呼ばない）", async () => {
    const c = await ctx();
    assertEqual(c.initial.apiKey, "SAVED");
  });

  test("キーを保存すると、ストレージに反映される", async () => {
    const c = await ctx();
    assertEqual(c.saved.stored, "GOOD");
    assertEqual(c.saved.status, "設定を保存しました（この端末のブラウザ内に保存されます）。");
  });

  test("接続テスト: 失敗時は理由を表示する", async () => {
    const c = await ctx();
    assertEqual(c.testBad, "接続に失敗しました: APIエラー (HTTP 400)");
  });

  test("接続テスト: 成功時はその旨を表示し、動作ログに記録される", async () => {
    const c = await ctx();
    assertEqual(c.testGood, "接続に成功しました。この設定は利用できます。");
    assertMatch(c.logAfterTest, /^累計 2 回（失敗 1 回）/, "接続テストの成否も動作ログに残る");
  });

  test("接続テスト: 未入力なら、APIを呼ばずにエラーを表示する", async () => {
    const c = await ctx();
    assertEqual(c.testEmpty, "エラー: APIキーを入力してください。");
  });
});

describe("設定画面: プライバシー設定", () => {
  test("画面を開くと、保存済みの設定が復元される", async () => {
    const c = await ctx();
    assertEqual(c.initial.strip, true);
    assertEqual(c.initial.domains, "a.example");
  });

  test("保存すると、ドメインを正規化してから保存し、入力欄にも反映する", async () => {
    const c = await ctx();
    assertEqual(c.privacySaved.stored, { strip_query: false, excluded_domains: ["foo.com", "bar.example"] });
    assertEqual(c.privacySaved.textarea, "foo.com\nbar.example");
  });
});

describe("設定画面: プロバイダ切替（既定はGemini）", () => {
  test("初期状態はGeminiで、エンドポイントURL欄は隠れている", async () => {
    const c = await ctx();
    assertEqual($("llm-provider").value, "gemini");
    assertEqual($("llm-base-url-field").hidden, true);
  });

  test("OpenAI互換を選ぶと、エンドポイントURL欄が現れる", async () => {
    await ctx();
    $("llm-provider").value = "openai_compatible";
    $("llm-provider").dispatchEvent(new Event("change"));
    assertEqual($("llm-base-url-field").hidden, false);
    $("llm-provider").value = "gemini";
    $("llm-provider").dispatchEvent(new Event("change")); // 後続テストに影響しないよう戻す
  });
});

describe("設定画面: OpenAI互換エンドポイント（LiteLLM Proxy 等）", () => {
  const openAiCtx = lazy(async () => {
    const { env } = await boot(BASE, {
      tree: createTree([]),
      storage: {},
      handler: req => (req.headers.Authorization === "Bearer sk-good" ? okChatJson("OK") : httpError(401, "invalid key"))
    });
    $("llm-provider").value = "openai_compatible";
    $("llm-provider").dispatchEvent(new Event("change"));
    $("llm-base-url").value = "https://litellm.example.com/v1";
    $("llm-model").value = "gpt-4o-mini";
    $("api-key").value = "sk-good";

    $("save-btn").click();
    await wait(100);
    const afterSave = {
      permissionRequests: [...env.permissionRequests],
      stored: {
        provider: env.storage.llm_provider,
        baseUrl: env.storage.llm_base_url,
        model: env.storage.llm_model,
        apiKey: env.storage.gemini_key
      },
      status: text("api-key-status")
    };

    $("test-btn").click();
    await wait(300);
    const testStatus = text("api-key-status");

    return { env, afterSave, testStatus };
  });

  test("保存時に、入力したエンドポイントのオリジンだけの権限を要求する", async () => {
    const c = await openAiCtx();
    assertEqual(c.afterSave.permissionRequests.at(0), ["https://litellm.example.com/*"]);
  });

  test("許可されれば、プロバイダ・URL・モデル・キーが保存される", async () => {
    const c = await openAiCtx();
    assertEqual(c.afterSave.stored, { provider: "openai_compatible", baseUrl: "https://litellm.example.com/v1", model: "gpt-4o-mini", apiKey: "sk-good" });
    assert(c.afterSave.status.includes("保存しました"));
  });

  test("接続テストは、保存前の入力値でOpenAI互換の形式で疎通確認する", async () => {
    const c = await openAiCtx();
    assertEqual(c.testStatus, "接続に成功しました。この設定は利用できます。");
  });
});

describe("設定画面: OpenAI互換エンドポイント — 入力不備・権限拒否", () => {
  test("エンドポイントURLが未入力なら、権限を要求せずエラーを表示する", async () => {
    const { env } = await boot(BASE, { tree: createTree([]), storage: {} });
    $("llm-provider").value = "openai_compatible";
    $("llm-provider").dispatchEvent(new Event("change"));
    $("llm-model").value = "gpt-4o-mini";
    $("api-key").value = "sk-x";
    $("save-btn").click();
    await wait(100);
    assertEqual(env.permissionRequests.length, 0);
    assertEqual(text("api-key-status"), "エラー: エンドポイントURLを入力してください。");
  });

  test("ユーザーが権限ダイアログを拒否したら、設定は保存されない", async () => {
    const { env } = await boot(BASE, { tree: createTree([]), storage: {}, permissionsGranted: false });
    $("llm-provider").value = "openai_compatible";
    $("llm-provider").dispatchEvent(new Event("change"));
    $("llm-base-url").value = "https://denied.example.com";
    $("llm-model").value = "gpt-4o-mini";
    $("api-key").value = "sk-x";
    $("save-btn").click();
    await wait(100);
    assertEqual(env.permissionRequests.at(0), ["https://denied.example.com/*"]);
    assert(!("llm_provider" in env.storage), "許可が得られなければ保存しない");
    assert(text("api-key-status").includes("アクセス許可が得られませんでした"));
  });
});

describe("設定画面: クイック保存先", () => {
  test("画面を開くと、保存済みのフォルダにチェックが付いている", async () => {
    const c = await ctx();
    assertEqual(c.initial.quickChecked, ["10"]);
    assert(c.initial.quickLabels.some(l => l.includes("保護（保護）")), "保護フォルダにはラベルが付く");
  });

  test("最大5件を超えてチェックしようとすると、超えた分は自動で外れる", async () => {
    const c = await ctx();
    assertEqual(c.quickSaved.checkedBeforeSave, 5);
  });

  test("保存すると、チェックされたフォルダIDが保存される", async () => {
    const c = await ctx();
    assertEqual(c.quickSaved.stored.length, 5);
    assertEqual(c.quickSaved.checkedAfterSave, 5);
  });
});
