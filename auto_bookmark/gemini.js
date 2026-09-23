// LLM API 呼び出しの共通モジュール（background.js / ai-tasks.js から import して使う）
// リトライ・ブロック理由の検査・動作ログの記録を1か所に集約する。
//
// プロバイダ（Gemini本体 / LiteLLM Proxy などのOpenAI互換エンドポイント）ごとの実際の
// リクエスト組み立て・応答の読み取りだけを openai-compatible.js 等の「アダプター」に切り出し、
// リトライ・エラー分類・ログはここに一本化する。呼び出し側（ai-tasks.js 以降）は
// どのプロバイダが選ばれているかを一切意識しない。

import * as openaiCompatible from "./openai-compatible.js";

export const GEMINI_MODEL = "gemini-3.6-flash";
const GEMINI_ENDPOINT_PREFIX = "https://generativelanguage.googleapis.com/v1beta/models/";
const GEMINI_ENDPOINT_SUFFIX = ":generateContent";

// 設定画面のプロバイダ選択肢と一致させる（storage.js の KEYS.PROVIDER に保存される値）
export const PROVIDERS = Object.freeze({ GEMINI: "gemini", OPENAI_COMPATIBLE: "openai_compatible" });
export const DEFAULT_PROVIDER = PROVIDERS.GEMINI;

const LOG_KEY = "gemini_log";     // 直近の呼び出し履歴（リングバッファ）
const USAGE_KEY = "gemini_usage"; // 累計の呼び出し回数・トークン数（実測値）
const LOG_MAX_ENTRIES = 50;

const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30000;
const REQUEST_TIMEOUT_MS = 60000;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
// Gemini独自の語彙。OpenAI互換側の判定は openai-compatible.js の parse() が担う
const GEMINI_BLOCKING_FINISH_REASONS = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"]);
const ERROR_DETAIL_MAX_CHARS = 200;

// kind: 呼び出し側が失敗の種類ごとに処理を分けるための分類
//   no_key    … APIキー未設定
//   config    … エンドポイントURL・モデル名など、接続設定が不足している（OpenAI互換のみ）
//   http      … HTTPエラー（リトライしても回復しなかった、またはリトライ不可）
//   network   … 通信エラー・タイムアウト（リトライしても回復しなかった）
//   blocked   … セーフティ等でAIの応答がブロックされた（リトライしても結果は変わらない）
//   truncated … 出力上限で応答が途中で切れた
//   empty     … 応答本文がない
//   parse     … JSONとして解析できない
export class GeminiError extends Error {
  constructor(kind, message, detail = {}) {
    super(message);
    this.name = "GeminiError";
    this.kind = kind;
    Object.assign(this, detail); // status, blockReason, finishReason, attempts
  }
}

// ユーザー向けの短い失敗理由（通知・画面表示用）
export function describeGeminiError(error) {
  if (!(error instanceof GeminiError)) return "予期しないエラー: " + (error?.message || error);
  switch (error.kind) {
    case "no_key": return "APIキーが未設定です";
    case "config": return "接続設定が不足しています: " + error.message;
    case "http": return "APIエラー (HTTP " + error.status + ")";
    case "network": return "通信エラー";
    case "blocked": return "AIの応答がブロックされました (" + (error.blockReason || error.finishReason || "理由不明") + ")";
    case "truncated": return "AIの応答が長すぎて途中で切れました";
    case "empty": return "AIの応答が空でした";
    case "parse": return "AIの応答を解析できませんでした";
    default: return error.message;
  }
}

// ---- プロバイダアダプター ----
// 各アダプターは例外を投げず、{url,headers,body} または正規化した parse() 結果を返すだけにする。
// buildRequest だけは、接続設定の不足（エンドポイント未入力など）を Error として投げてよい
// （callGemini 側で "config" 種別の GeminiError に変換する）。

function geminiBuildRequest({ connection, parts, schema, temperature }) {
  const model = connection.model || GEMINI_MODEL;
  const url = GEMINI_ENDPOINT_PREFIX + model + GEMINI_ENDPOINT_SUFFIX;
  // APIキーはURLではなくヘッダで渡す（URLはログやエラー表示に残りやすいため）
  const headers = { "Content-Type": "application/json", "x-goog-api-key": connection.apiKey };
  const body = JSON.stringify({
    contents: [{ parts: parts.map(text => ({ text })) }],
    generationConfig: schema ?
      { temperature, response_mime_type: "application/json", response_schema: schema } :
      { temperature, response_mime_type: "text/plain" }
  });
  return { url, headers, body };
}

function geminiParse(data) {
  // プロンプト単位のブロックでは candidates 自体が存在しない
  const candidate = data.candidates?.[0];
  const finishReason = candidate?.finishReason;
  const blockReason = data.promptFeedback?.blockReason;
  return {
    blocked: !candidate || !!blockReason || GEMINI_BLOCKING_FINISH_REASONS.has(finishReason),
    blockReason,
    truncated: finishReason === "MAX_TOKENS",
    finishReason,
    text: candidate?.content?.parts?.[0]?.text,
    promptTokens: data.usageMetadata?.promptTokenCount,
    outputTokens: data.usageMetadata?.candidatesTokenCount
  };
}

function geminiErrorDetail(data) {
  return String(data?.error?.message || "");
}

const PROVIDER_ADAPTERS = {
  [PROVIDERS.GEMINI]: { buildRequest: geminiBuildRequest, parse: geminiParse, errorDetail: geminiErrorDetail },
  [PROVIDERS.OPENAI_COMPATIBLE]: { buildRequest: openaiCompatible.buildRequest, parse: openaiCompatible.parse, errorDetail: openaiCompatible.errorDetail }
};

function resolveAdapter(provider) {
  return PROVIDER_ADAPTERS[provider] || PROVIDER_ADAPTERS[DEFAULT_PROVIDER];
}

/**
 * LLM を1回呼び出す（429/5xx/通信エラーは指数バックオフで自動リトライ）。
 * @param {object} options
 * @param {{provider: string, apiKey: string, baseUrl: string, model: string}} options.connection storage.js の getLlmConnection() の戻り値
 * @param {string} options.purpose 動作ログに残す用途ID（例: "bg:categorize"）。URLやタイトルは記録しない
 * @param {string[]} options.parts プロンプトを構成するテキスト（複数可）
 * @param {object} [options.schema] 指定するとJSONモードになり、結果が result.json に入る
 * @param {number} [options.temperature]
 * @param {number} [options.maxAttempts]
 * @returns {Promise<{text: string, json: any, finishReason: string, usage: {promptTokens: number, outputTokens: number}}>}
 * @throws {GeminiError}
 */
export async function callGemini({ connection, purpose, parts, schema, temperature = 0.1, maxAttempts = DEFAULT_MAX_ATTEMPTS }) {
  const startedAt = Date.now();
  const entry = { at: startedAt, purpose, provider: connection?.provider || DEFAULT_PROVIDER, ok: false, attempts: 0 };
  try {
    if (!connection?.apiKey) throw new GeminiError("no_key", "APIキーが未設定です");
    const adapter = resolveAdapter(connection.provider);

    let request;
    try {
      request = adapter.buildRequest({ connection, parts, schema, temperature });
    } catch (configError) {
      throw new GeminiError("config", configError.message);
    }

    const response = await fetchWithRetry(adapter, request, maxAttempts, entry);
    const data = await response.json();
    const parsed = adapter.parse(data);

    entry.promptTokens = parsed.promptTokens;
    entry.outputTokens = parsed.outputTokens;
    entry.finishReason = parsed.finishReason;
    entry.blockReason = parsed.blockReason;

    if (parsed.blocked) {
      throw new GeminiError("blocked", "AIの応答がブロックされました", { blockReason: parsed.blockReason, finishReason: parsed.finishReason });
    }
    if (parsed.truncated) {
      throw new GeminiError("truncated", "AIの応答が途中で切れました", { finishReason: parsed.finishReason });
    }
    if (typeof parsed.text !== "string" || parsed.text === "") {
      throw new GeminiError("empty", "AIの応答が空でした", { finishReason: parsed.finishReason });
    }

    let json = null;
    if (schema) {
      try {
        json = JSON.parse(parsed.text);
      } catch (parseError) {
        throw new GeminiError("parse", "AIの応答を解析できませんでした", { finishReason: parsed.finishReason });
      }
    }

    entry.ok = true;
    return { text: parsed.text.trim(), json, finishReason: parsed.finishReason, usage: { promptTokens: parsed.promptTokens, outputTokens: parsed.outputTokens } };
  } catch (error) {
    if (error instanceof GeminiError) {
      entry.kind = error.kind;
      entry.status = error.status;
      entry.detail = error.detail;
    } else {
      entry.kind = "unexpected";
      entry.detail = String(error?.message || error).slice(0, ERROR_DETAIL_MAX_CHARS);
    }
    throw error;
  } finally {
    entry.ms = Date.now() - startedAt;
    await recordLog(entry);
  }
}

// 429/5xx/通信エラーのときだけ、指数バックオフ（Retry-After があればそれを優先）で再試行する
async function fetchWithRetry(adapter, request, maxAttempts, entry) {
  for (let attempt = 1; ; attempt++) {
    entry.attempts = attempt;
    let response = null;
    let networkError = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        response = await fetch(request.url, {
          method: "POST",
          headers: request.headers,
          body: request.body,
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      networkError = error;
    }

    if (response && response.ok) return response;

    const retryable = networkError ? true : RETRYABLE_STATUS.has(response.status);
    if (!retryable || attempt >= maxAttempts) {
      if (networkError) throw new GeminiError("network", "通信エラー", { attempts: attempt });
      throw new GeminiError("http", "APIエラー (HTTP " + response.status + ")", {
        status: response.status,
        attempts: attempt,
        detail: await readErrorDetail(adapter, response)
      });
    }
    await sleep(retryDelayMs(attempt, response));
  }
}

function retryDelayMs(attempt, response) {
  const retryAfterSec = Number(response?.headers?.get("retry-after"));
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    return Math.min(retryAfterSec * 1000, MAX_RETRY_DELAY_MS);
  }
  const jitter = Math.random() * 250;
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1) + jitter, MAX_RETRY_DELAY_MS);
}

async function readErrorDetail(adapter, response) {
  try {
    const data = await response.json();
    return adapter.errorDetail(data).slice(0, ERROR_DETAIL_MAX_CHARS);
  } catch (e) {
    return "";
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---- 複数件のバッチ処理 ----

// 「件数を減らせば成功するかもしれない」失敗か（ブロック・出力途切れ・応答不正）
// 通信・APIエラー（http/network/config）は、リトライ済みで件数を減らしても回復しないため含めない
function isSplittableError(error) {
  return error instanceof GeminiError && ["blocked", "truncated", "empty", "parse"].includes(error.kind);
}

/**
 * items をまとめて handler(items) に渡す。分割可能な失敗のときは items を二分割して再試行し、
 * 失敗の原因になっている項目だけを切り分ける（他の項目は救済される）。
 * handler は成功結果を自身のクロージャに書き込み、失敗時は例外を投げること。
 * @returns {Promise<{failed: {item: any, error: Error}[], fatal: Error|null}>}
 *   failed … 1件まで分割しても失敗した項目
 *   fatal  … 通信・APIエラー。この場合は残りを処理せず中断する
 */
export async function processWithBisect(items, handler, result = { failed: [], fatal: null }) {
  try {
    await handler(items);
  } catch (error) {
    if (!isSplittableError(error)) {
      result.fatal = error;
      return result;
    }
    if (items.length === 1) {
      result.failed.push({ item: items[0], error });
      return result;
    }
    const middle = Math.ceil(items.length / 2);
    await processWithBisect(items.slice(0, middle), handler, result);
    if (!result.fatal) await processWithBisect(items.slice(middle), handler, result);
  }
  return result;
}

// ---- 動作ログ（chrome.storage.local に直近 LOG_MAX_ENTRIES 件を保持） ----

// 同一コンテキスト内の並行書き込みで履歴が欠けないよう、書き込みを直列化する
let writeChain = Promise.resolve();

function recordLog(entry) {
  console.info("[llm]", entry.provider, entry.purpose, entry.ok ? "ok" : "FAILED (" + entry.kind + ")",
    "attempts=" + entry.attempts, entry.ms + "ms");
  writeChain = writeChain.then(async () => {
    try {
      const stored = await chrome.storage.local.get([LOG_KEY, USAGE_KEY]);
      const log = stored[LOG_KEY] || [];
      log.push(entry);
      while (log.length > LOG_MAX_ENTRIES) log.shift();

      const usage = stored[USAGE_KEY] || { calls: 0, failedCalls: 0, promptTokens: 0, outputTokens: 0, since: entry.at };
      usage.calls += 1;
      if (!entry.ok) usage.failedCalls += 1;
      usage.promptTokens += entry.promptTokens || 0;
      usage.outputTokens += entry.outputTokens || 0;

      await chrome.storage.local.set({ [LOG_KEY]: log, [USAGE_KEY]: usage });
    } catch (error) {
      console.warn("[llm] 動作ログの保存に失敗しました:", error);
    }
  });
  return writeChain;
}

export async function getGeminiLog() {
  const stored = await chrome.storage.local.get(LOG_KEY);
  return stored[LOG_KEY] || [];
}

export async function getGeminiUsage() {
  const stored = await chrome.storage.local.get(USAGE_KEY);
  return stored[USAGE_KEY] || { calls: 0, failedCalls: 0, promptTokens: 0, outputTokens: 0, since: null };
}

export async function clearGeminiLog() {
  await chrome.storage.local.remove([LOG_KEY, USAGE_KEY]);
}
