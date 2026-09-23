// openai-compatible.js（LiteLLM Proxy 等、OpenAI互換エンドポイント向けアダプター）の純粋関数を検証する。
// buildRequest / parse は fetch を発行しない純粋関数なので、chrome.* のモックは不要。

import { describe, test, assert, assertEqual, lazy } from "../lib/assert.js";

const BASE = location.origin;
const mod = lazy(() => import(BASE + "/openai-compatible.js"));

const CONNECTION = { provider: "openai_compatible", apiKey: "sk-test", baseUrl: "https://litellm.example.com/", model: "gpt-4o-mini" };

describe("openai-compatible.js: buildRequest", () => {
  test("エンドポイントは baseUrl の末尾スラッシュを畳み込んで /chat/completions を付ける", async () => {
    const { buildRequest } = await mod();
    const { url } = buildRequest({ connection: CONNECTION, parts: ["hello"], temperature: 0.1 });
    assertEqual(url, "https://litellm.example.com/chat/completions");
  });

  test("認証はヘッダ Authorization: Bearer で渡す（APIキーはURLに含めない）", async () => {
    const { buildRequest } = await mod();
    const { url, headers } = buildRequest({ connection: CONNECTION, parts: ["hello"], temperature: 0.1 });
    assertEqual(headers.Authorization, "Bearer sk-test");
    assert(!url.includes("sk-test"), "APIキーがURLに含まれてはいけない");
  });

  test("複数の parts は1つの user メッセージに結合する", async () => {
    const { buildRequest } = await mod();
    const { body } = buildRequest({ connection: CONNECTION, parts: ["A", "B"], temperature: 0.1 });
    const parsed = JSON.parse(body);
    assertEqual(parsed.model, "gpt-4o-mini");
    assertEqual(parsed.messages, [{ role: "user", content: "A\n\nB" }]);
    assert(!("response_format" in parsed), "schema省略時は response_format を付けない（自由形式のテキスト応答）");
  });

  test("スキーマを渡すと、Structured Outputs（strict）形式に変換する", async () => {
    const { buildRequest } = await mod();
    const geminiStyleSchema = {
      type: "OBJECT",
      properties: {
        folder_id: { type: "STRING", enum: ["a", "b"] },
        confidence: { type: "INTEGER" }
      },
      required: ["folder_id", "confidence"]
    };
    const { body } = buildRequest({ connection: CONNECTION, parts: ["hello"], schema: geminiStyleSchema, temperature: 0.2 });
    const parsed = JSON.parse(body);
    assertEqual(parsed.response_format.type, "json_schema");
    assertEqual(parsed.response_format.json_schema.strict, true);
    const schema = parsed.response_format.json_schema.schema;
    assertEqual(schema.type, "object", "typeは小文字化する");
    assertEqual(schema.properties.folder_id.type, "string");
    assertEqual(schema.properties.folder_id.enum, ["a", "b"], "enum制約は保持する");
    assertEqual(schema.additionalProperties, false, "strictモードの要件を満たす");
    assertEqual(schema.required, ["folder_id", "confidence"]);
  });

  test("ネストした配列・オブジェクトのスキーマも再帰的に変換する", async () => {
    const { buildRequest } = await mod();
    const nested = {
      type: "OBJECT",
      properties: {
        items: { type: "ARRAY", items: { type: "OBJECT", properties: { id: { type: "STRING" } }, required: ["id"] } }
      },
      required: ["items"]
    };
    const { body } = buildRequest({ connection: CONNECTION, parts: ["x"], schema: nested, temperature: 0.1 });
    const schema = JSON.parse(body).response_format.json_schema.schema;
    assertEqual(schema.properties.items.type, "array");
    assertEqual(schema.properties.items.items.type, "object");
    assertEqual(schema.properties.items.items.additionalProperties, false);
  });

  test("エンドポイントURL・モデル名が未設定なら、接続設定エラーを投げる", async () => {
    const { buildRequest } = await mod();
    let threwForUrl = false;
    try { buildRequest({ connection: { ...CONNECTION, baseUrl: "" }, parts: ["x"], temperature: 0.1 }); } catch (e) { threwForUrl = true; }
    assert(threwForUrl, "baseUrl未設定でエラーになるべき");

    let threwForModel = false;
    try { buildRequest({ connection: { ...CONNECTION, model: "" }, parts: ["x"], temperature: 0.1 }); } catch (e) { threwForModel = true; }
    assert(threwForModel, "model未設定でエラーになるべき");
  });
});

describe("openai-compatible.js: parse", () => {
  test("正常応答: message.content と usage を読み取る", async () => {
    const { parse } = await mod();
    const result = parse({ choices: [{ finish_reason: "stop", message: { content: "hello" } }], usage: { prompt_tokens: 10, completion_tokens: 3 } });
    assertEqual(result, { blocked: false, blockReason: undefined, truncated: false, finishReason: "stop", text: "hello", promptTokens: 10, outputTokens: 3 });
  });

  test("finish_reason: content_filter は blocked 扱いにする", async () => {
    const { parse } = await mod();
    const result = parse({ choices: [{ finish_reason: "content_filter", message: { content: null } }] });
    assert(result.blocked);
    assertEqual(result.blockReason, "content_filter");
  });

  test("choices が空（応答なし）も blocked 扱いにする", async () => {
    const { parse } = await mod();
    const result = parse({ choices: [] });
    assert(result.blocked);
  });

  test("finish_reason: length は truncated 扱いにする", async () => {
    const { parse } = await mod();
    const result = parse({ choices: [{ finish_reason: "length", message: { content: "途中で切れ" } }] });
    assert(result.truncated);
    assert(!result.blocked);
  });
});

describe("openai-compatible.js: errorDetail", () => {
  test("OpenAI形式のエラー本文からメッセージを取り出す", async () => {
    const { errorDetail } = await mod();
    assertEqual(errorDetail({ error: { message: "invalid api key" } }), "invalid api key");
  });

  test("メッセージが無ければ空文字を返す（例外を投げない）", async () => {
    const { errorDetail } = await mod();
    assertEqual(errorDetail({}), "");
    assertEqual(errorDetail(null), "");
  });
});
