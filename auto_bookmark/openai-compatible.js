// OpenAI互換 Chat Completions API（LiteLLM Proxy・OpenAI・Ollama・vLLM 等、ユーザーが指定した任意のエンドポイント）
// 向けのアダプター。gemini.js の callGemini から provider アダプターとして呼び出される。
//
// ここでは例外を投げず、正規化した結果を返すだけにする。応答の意味づけ（GeminiError 化）は
// 呼び出し側（gemini.js）に一元化し、プロバイダごとの分岐をそこだけに閉じ込める。

// finish_reason はバックエンドによって語彙が揺れるため、広めに拾う
const CONTENT_FILTER_FINISH_REASONS = new Set(["content_filter"]);
const TRUNCATED_FINISH_REASONS = new Set(["length"]);

export const CHAT_COMPLETIONS_PATH = "/chat/completions";

/**
 * @param {object} options
 * @param {{apiKey: string, baseUrl: string, model: string}} options.connection
 * @param {string[]} options.parts
 * @param {object} [options.schema] Gemini方言（大文字type・response_schemaの形）のスキーマ
 * @param {number} options.temperature
 * @returns {{url: string, headers: object, body: string}}
 * @throws {Error} baseUrl・model が未設定のとき（gemini.js 側で "config" 種別のエラーに変換される）
 */
export function buildRequest({ connection, parts, schema, temperature }) {
  if (!connection.baseUrl) throw new Error("エンドポイントURLが未設定です");
  if (!connection.model) throw new Error("モデル名が未設定です");

  const url = connection.baseUrl.replace(/\/+$/, "") + CHAT_COMPLETIONS_PATH;
  const headers = { "Content-Type": "application/json", Authorization: "Bearer " + connection.apiKey };
  const body = JSON.stringify({
    model: connection.model,
    temperature,
    messages: [{ role: "user", content: parts.join("\n\n") }],
    ...(schema ? { response_format: { type: "json_schema", json_schema: { name: "response", strict: true, schema: toStandardJsonSchema(schema) } } } : {})
  });
  return { url, headers, body };
}

/**
 * レスポンスJSONを正規化する。
 * @returns {{blocked: boolean, blockReason?: string, truncated: boolean, finishReason?: string,
 *   text: string|undefined, promptTokens: number|undefined, outputTokens: number|undefined}}
 */
export function parse(data) {
  const choice = data.choices?.[0];
  const finishReason = choice?.finish_reason;
  return {
    blocked: !choice || CONTENT_FILTER_FINISH_REASONS.has(finishReason),
    blockReason: !choice ? "応答が空でした" : (CONTENT_FILTER_FINISH_REASONS.has(finishReason) ? finishReason : undefined),
    truncated: TRUNCATED_FINISH_REASONS.has(finishReason),
    finishReason,
    text: choice?.message?.content,
    promptTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens
  };
}

export function errorDetail(data) {
  return String(data?.error?.message || data?.message || "");
}

// Gemini方言（大文字type・response_schema）の1書式だけを ai-tasks.js に書かせるための変換。
// OpenAI の Structured Outputs（strict モード）は、オブジェクトに additionalProperties:false を要求する。
// strict モードでは本来「全プロパティが required」である必要があるが、ai-tasks.js のスキーマは
// もともとその方針で書かれているため、変換だけで足りる（プロパティを required から省く運用はしない）。
function toStandardJsonSchema(schema) {
  if (schema == null || typeof schema !== "object") return schema;
  const out = {};
  if (schema.type) out.type = String(schema.type).toLowerCase();
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.items) out.items = toStandardJsonSchema(schema.items);
  if (schema.properties) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, toStandardJsonSchema(value)]));
    out.additionalProperties = false;
  }
  if (schema.required) out.required = schema.required;
  return out;
}
