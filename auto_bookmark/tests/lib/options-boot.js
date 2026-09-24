// 設定画面（options.html + options.js）を、モックの chrome.*/fetch の上で起動する共通ヘルパー。
// ②③④など、設定画面のDOMを操作するテストから共通で使う。

import { installChrome, loadOptionsDom, mockFetch, okJson, wait } from "./harness.js";

export const $ = id => document.getElementById(id);
export const text = id => $(id).textContent;

/**
 * options.html を読み込み、モックの chrome.* と fetch を用意してから options.js を起動する。
 * @param {string} base location.origin（呼び出し側の BASE 定数を渡す）
 * @param {object} options
 * @param {object} [options.tree] harness の createTree() で作ったブックマークツリー
 * @param {object} [options.storage] 初期状態の chrome.storage.local
 * @param {(req: object) => object} [options.handler] fetch（Gemini）のモック応答
 * @param {boolean|((message: string) => boolean)} [options.confirmAnswer] window.confirm の戻り値
 * @param {boolean} [options.permissionsGranted] chrome.permissions.request() の戻り値（自前ホストのエンドポイント許可の可否）
 * @returns {Promise<{env: object, requests: object[], confirms: string[]}>}
 */
export async function boot(base, { tree, storage = {}, handler, confirmAnswer = true, permissionsGranted = true } = {}) {
  await loadOptionsDom();
  const env = installChrome({ tree, storage: { storage_version: 3, ...storage }, permissionsGranted });
  const requests = mockFetch(handler || (() => okJson({})));
  const confirms = [];
  window.confirm = message => {
    confirms.push(message);
    return typeof confirmAnswer === "function" ? confirmAnswer(message) : confirmAnswer;
  };
  window.alert = () => {};
  window.prompt = () => window.__promptAnswer ?? null;
  await import(base + "/options.js?v=" + Date.now() + Math.random());
  await wait(400);
  return { env, requests, confirms };
}

/** cleanseTitlesBulk 用のモック応答（入力をそのまま「無毒化済み」として返す） */
export function cleanseEcho(req) {
  if (!req.texts.includes("AIセーフティ誤判定")) return null;
  return okJson({ cleansed_items: JSON.parse(req.body.contents[0].parts[1].text) });
}
