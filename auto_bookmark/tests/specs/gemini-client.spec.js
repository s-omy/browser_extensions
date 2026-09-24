// gemini.js の callGemini（リトライ・エラー分類・動作ログ・プロバイダ切替の中枢）を、
// Gemini / OpenAI互換の両方の実際の配線を通して検証する。

import { describe, test, assert, assertEqual, lazy } from "../lib/assert.js";
import { installChrome, mockFetch, okJson, okText, okChatJson, okChatText, chatContentFilter, chatTruncated, httpError, blocked, wait } from "../lib/harness.js";

const BASE = location.origin;
const mod = lazy(() => import(BASE + "/gemini.js"));

const SCHEMA = { type: "OBJECT", properties: { ok: { type: "STRING" } }, required: ["ok"] };

async function callOnce(connection, response, { schema = SCHEMA } = {}) {
  installChrome({});
  const requests = mockFetch(() => response);
  const g = await mod();
  const outcome = { requests };
  try {
    outcome.result = await g.callGemini({ connection, purpose: "test:x", parts: ["hello"], schema });
    outcome.ok = true;
  } catch (error) {
    outcome.ok = false;
    outcome.error = error;
  }
  return outcome;
}

describe("gemini.js: プロバイダ切替（Gemini）", () => {
  const ctx = lazy(async () => {
    const connection = { provider: "gemini", apiKey: "K", baseUrl: "", model: "" };
    return callOnce(connection, okJson({ ok: "yes" }));
  });

  test("Gemini形式のリクエストを送り、モデル名は既定値を使う", async () => {
    const c = await ctx();
    assert(c.ok);
    const req = c.requests[0];
    assert(req.url.includes("gemini-3.6-flash"), "モデル未指定時は既定モデルを使う: " + req.url);
    assertEqual(req.headers["x-goog-api-key"], "K");
    assert(!req.url.includes("K="), "APIキーはURLに含めない");
  });

  test("応答をJSONとして解析し、result.json に入れる", async () => {
    const c = await ctx();
    assertEqual(c.result.json, { ok: "yes" });
  });

  test("モデル名を指定すると、URLに反映される", async () => {
    const c = await callOnce({ provider: "gemini", apiKey: "K", model: "gemini-2.5-flash" }, okJson({ ok: "yes" }));
    assert(c.requests[0].url.includes("gemini-2.5-flash"));
  });
});

describe("gemini.js: プロバイダ切替（OpenAI互換 / LiteLLM Proxy）", () => {
  const CONNECTION = { provider: "openai_compatible", apiKey: "sk-test", baseUrl: "http://localhost:4000", model: "gpt-4o-mini" };
  const ctx = lazy(() => callOnce(CONNECTION, okChatJson({ ok: "yes" })));

  test("OpenAI互換形式のリクエストを、指定したエンドポイント・モデルへ送る", async () => {
    const c = await ctx();
    assert(c.ok);
    const req = c.requests[0];
    assertEqual(req.url, "http://localhost:4000/chat/completions");
    assert(Array.isArray(req.body.messages), "messages形式で送るべき");
    assertEqual(req.body.model, "gpt-4o-mini");
    assertEqual(req.headers.Authorization, "Bearer sk-test");
  });

  test("応答をJSONとして解析する", async () => {
    const c = await ctx();
    assertEqual(c.result.json, { ok: "yes" });
  });

  test("エンドポイントURL・モデル名が未設定なら 'config' 種別のエラーになる（fetchは発行しない）", async () => {
    const g = await mod();
    installChrome({});
    const requests = mockFetch(() => okChatJson({ ok: "yes" }));
    let error = null;
    try { await g.callGemini({ connection: { provider: "openai_compatible", apiKey: "sk-test", baseUrl: "", model: "" }, purpose: "test:x", parts: ["hi"] }); }
    catch (e) { error = e; }
    assert(error instanceof g.GeminiError && error.kind === "config");
    assertEqual(requests.length, 0, "設定不足の時点でfetchを発行してはいけない");
  });

  test("finish_reason: content_filter は 'blocked' 種別のエラーになる", async () => {
    const c = await callOnce(CONNECTION, chatContentFilter());
    assert(!c.ok);
    const g = await mod();
    assert(c.error instanceof g.GeminiError && c.error.kind === "blocked");
  });

  test("finish_reason: length は 'truncated' 種別のエラーになる", async () => {
    const c = await callOnce(CONNECTION, chatTruncated("途中"));
    const g = await mod();
    assert(c.error instanceof g.GeminiError && c.error.kind === "truncated");
  });
});

describe("gemini.js: エラー分類とリトライ（プロバイダ共通のロジック）", () => {
  test("APIキー未設定は 'no_key'（fetchを発行しない）", async () => {
    const c = await callOnce({ provider: "gemini", apiKey: "" }, okJson({ ok: "x" }));
    const g = await mod();
    assert(!c.ok);
    assert(c.error instanceof g.GeminiError && c.error.kind === "no_key");
    assertEqual(c.requests.length, 0);
  });

  test("429は指数バックオフでリトライし、最終的に成功すれば結果を返す", async () => {
    installChrome({});
    let call = 0;
    const requests = mockFetch(() => (++call <= 2 ? httpError(429, "rate limited") : okJson({ ok: "recovered" })));
    const g = await mod();
    const result = await g.callGemini({ connection: { provider: "gemini", apiKey: "K" }, purpose: "test:retry", parts: ["hi"], schema: SCHEMA });
    assertEqual(result.json, { ok: "recovered" });
    assertEqual(requests.length, 3);
  });

  test("400のような回復しないHTTPエラーはリトライしない", async () => {
    const c = await callOnce({ provider: "gemini", apiKey: "K" }, httpError(400, "bad request"));
    const g = await mod();
    assertEqual(c.requests.length, 1);
    assert(c.error instanceof g.GeminiError && c.error.kind === "http" && c.error.status === 400);
  });

  test("Gemini形式のブロック（promptFeedback.blockReason）は 'blocked' 種別になる", async () => {
    const c = await callOnce({ provider: "gemini", apiKey: "K" }, blocked("SAFETY"));
    const g = await mod();
    assert(c.error instanceof g.GeminiError && c.error.kind === "blocked" && c.error.blockReason === "SAFETY");
  });

  test("スキーマ指定時に応答が壊れたJSONなら 'parse' 種別になる", async () => {
    const c = await callOnce({ provider: "gemini", apiKey: "K" }, okText("{oops"));
    const g = await mod();
    assert(c.error instanceof g.GeminiError && c.error.kind === "parse");
  });
});

describe("gemini.js: 動作ログ", () => {
  test("成功・失敗のいずれも、呼び出し元プロバイダ名つきで記録する", async () => {
    installChrome({});
    const g = await mod();
    mockFetch(() => okJson({ ok: "x" }));
    await g.callGemini({ connection: { provider: "gemini", apiKey: "K" }, purpose: "test:log-gemini", parts: ["a"], schema: SCHEMA });
    mockFetch(() => okChatJson({ ok: "x" }));
    await g.callGemini({ connection: { provider: "openai_compatible", apiKey: "K", baseUrl: "http://x", model: "m" }, purpose: "test:log-openai", parts: ["a"], schema: SCHEMA });

    const log = await g.getGeminiLog();
    const providers = log.filter(e => e.purpose.startsWith("test:log-")).map(e => e.provider);
    assertEqual(providers, ["gemini", "openai_compatible"]);
  });

  test("clearGeminiLog でログと累計を消去できる", async () => {
    installChrome({});
    const g = await mod();
    mockFetch(() => okJson({ ok: "x" }));
    await g.callGemini({ connection: { provider: "gemini", apiKey: "K" }, purpose: "test:clear", parts: ["a"], schema: SCHEMA });
    assert((await g.getGeminiUsage()).calls > 0);
    await g.clearGeminiLog();
    assertEqual((await g.getGeminiUsage()).calls, 0);
    assertEqual((await g.getGeminiLog()).length, 0);
  });
});

describe("gemini.js: processWithBisect", () => {
  test("成功時はそのまま完了し、分割しない", async () => {
    const g = await mod();
    const calls = [];
    const result = await g.processWithBisect([1, 2, 3], async items => { calls.push(items); });
    assertEqual(calls, [[1, 2, 3]]);
    assertEqual(result, { failed: [], fatal: null });
  });

  test("分割可能な失敗（blocked等）は二分割し、原因の1件だけを切り分ける", async () => {
    installChrome({});
    const g = await mod();
    mockFetch(req => (JSON.parse(req.texts).includes(2) ? blocked("SAFETY") : okJson({ n: JSON.parse(req.texts) })));
    const calls = [];
    const result = await g.processWithBisect([1, 2, 3], async items => {
      calls.push(items);
      const res = await g.callGemini({ connection: { provider: "gemini", apiKey: "K" }, purpose: "test:bisect", parts: [JSON.stringify(items)], schema: SCHEMA });
      if (!res.json) throw new Error("unexpected");
    });
    assertEqual(result.failed.length, 1);
    assertEqual(result.failed[0].item, 2);
    assertEqual(result.fatal, null);
  });

  test("通信・APIエラー（fatal）は分割せず、そこで打ち切る", async () => {
    const g = await mod();
    let calls = 0;
    const result = await g.processWithBisect([1, 2, 3], async () => {
      calls++;
      throw new g.GeminiError("http", "boom", { status: 500 });
    });
    assertEqual(calls, 1, "分割せず1回で諦める");
    assert(result.fatal instanceof g.GeminiError);
  });
});
