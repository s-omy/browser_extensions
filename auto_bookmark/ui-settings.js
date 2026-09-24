// 設定画面: プロバイダ・APIキー・接続テスト・プライバシー設定・右クリックメニューのクイック保存先

import { testConnection } from "./ai-tasks.js";
import { collectFolderInfos, getFolderPathMap } from "./bookmarks.js";
import { MAX_QUICK_FOLDERS } from "./config.js";
import { GEMINI_MODEL, PROVIDERS } from "./gemini.js";
import { parseDomainList } from "./privacy.js";
import { KEYS, getLlmConnection, getPrivacySettings, getQuickFolderIds } from "./storage.js";
import { TONE, h, setStatus } from "./ui-common.js";

const STATUS_CLEAR_DELAY_MS = 3000;

/** @param {{onApiCall: () => void}} hooks API呼び出しの後に動作ログの表示を更新するためのフック */
export function initSettings({ onApiCall }) {
  initConnection(onApiCall);
  initPrivacy();
  initQuickFolders();
}

function flashStatus(element, text, tone) {
  setStatus(element, text, tone);
  setTimeout(() => setStatus(element, ""), STATUS_CLEAR_DELAY_MS);
}

// ---- プロバイダ・APIキー・接続テスト ----

// 入力欄の現在値から、まだ保存していなくても使える接続情報を組み立てる（接続テスト用）
function readConnectionForm({ providerSelect, keyInput, baseUrlInput, modelInput }) {
  return {
    provider: providerSelect.value,
    apiKey: keyInput.value.trim(),
    baseUrl: baseUrlInput.value.trim(),
    model: modelInput.value.trim()
  };
}

function applyProviderVisibility(provider, { baseUrlField, modelInput }) {
  const isOpenAiCompatible = provider === PROVIDERS.OPENAI_COMPATIBLE;
  baseUrlField.hidden = !isOpenAiCompatible;
  modelInput.placeholder = isOpenAiCompatible ? "例: gpt-4o-mini（LiteLLM側で設定したエイリアス）" : GEMINI_MODEL + "（未入力ならこれを使用）";
}

// openai_compatible のエンドポイントは、ユーザーが入力するまで origin が分からないため、
// 保存の直前に該当 origin だけを chrome.permissions.request() で動的に許可してもらう
// （manifest には広い optional_host_permissions を宣言し、実際に要求するのはこの1件だけにする）。
async function ensureOriginPermission(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch (error) {
    throw new Error("エンドポイントURLの形式が正しくありません。");
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error("エンドポイントURLは http:// または https:// で始めてください。");
  }
  const pattern = parsed.origin + "/*";
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) throw new Error("このエンドポイントへのアクセス許可が得られませんでした。");
}

async function initConnection(onApiCall) {
  const providerSelect = document.getElementById("llm-provider");
  const keyInput = document.getElementById("api-key");
  const baseUrlField = document.getElementById("llm-base-url-field");
  const baseUrlInput = document.getElementById("llm-base-url");
  const modelInput = document.getElementById("llm-model");
  const statusDiv = document.getElementById("api-key-status");
  const testBtn = document.getElementById("test-btn");
  const els = { providerSelect, keyInput, baseUrlInput, modelInput };

  const connection = await getLlmConnection();
  providerSelect.value = connection.provider;
  keyInput.value = connection.apiKey;
  baseUrlInput.value = connection.baseUrl;
  modelInput.value = connection.model;
  applyProviderVisibility(connection.provider, { baseUrlField, modelInput });

  providerSelect.addEventListener("change", () => {
    applyProviderVisibility(providerSelect.value, { baseUrlField, modelInput });
  });

  document.getElementById("save-btn").addEventListener("click", async () => {
    const form = readConnectionForm(els);
    try {
      if (form.provider === PROVIDERS.OPENAI_COMPATIBLE) {
        if (!form.baseUrl) throw new Error("エンドポイントURLを入力してください。");
        if (!form.model) throw new Error("モデル名を入力してください。");
        setStatus(statusDiv, "エンドポイントへのアクセス許可を確認しています...", TONE.MUTED);
        await ensureOriginPermission(form.baseUrl);
      }
      await chrome.storage.local.set({
        [KEYS.API_KEY]: form.apiKey,
        [KEYS.PROVIDER]: form.provider,
        [KEYS.BASE_URL]: form.baseUrl,
        [KEYS.MODEL]: form.model
      });
      flashStatus(statusDiv, "設定を保存しました（この端末のブラウザ内に保存されます）。", TONE.SUCCESS);
    } catch (error) {
      setStatus(statusDiv, "エラー: " + error.message, TONE.ERROR);
    }
  });

  // 保存前の入力値でも試せるよう、フォームの現在値を使う
  testBtn.addEventListener("click", async () => {
    const form = readConnectionForm(els);
    if (!form.apiKey) {
      setStatus(statusDiv, "エラー: APIキーを入力してください。", TONE.ERROR);
      return;
    }
    testBtn.disabled = true;
    setStatus(statusDiv, "接続テスト中...", TONE.MUTED);
    try {
      if (form.provider === PROVIDERS.OPENAI_COMPATIBLE) {
        if (!form.baseUrl || !form.model) throw new Error("エンドポイントURLとモデル名を入力してください。");
        await ensureOriginPermission(form.baseUrl); // テストのためだけに許可を求める（保存はしない）
      }
      await testConnection(form);
      setStatus(statusDiv, "接続に成功しました。この設定は利用できます。", TONE.SUCCESS);
    } catch (error) {
      setStatus(statusDiv, "接続に失敗しました: " + error.message, TONE.ERROR);
    } finally {
      testBtn.disabled = false;
      onApiCall();
    }
  });
}

// ---- プライバシー設定 ----

async function initPrivacy() {
  const stripQuery = document.getElementById("privacy-strip-query");
  const domains = document.getElementById("privacy-excluded-domains");
  const statusDiv = document.getElementById("privacy-status");

  const settings = await getPrivacySettings();
  stripQuery.checked = settings.strip_query;
  domains.value = settings.excluded_domains.join("\n");

  document.getElementById("privacy-save-btn").addEventListener("click", async () => {
    const excludedDomains = parseDomainList(domains.value);
    await chrome.storage.local.set({ [KEYS.PRIVACY]: { strip_query: stripQuery.checked, excluded_domains: excludedDomains } });
    domains.value = excludedDomains.join("\n"); // 解釈された結果を表示して、入力の意図とずれていないか確認できるようにする
    flashStatus(statusDiv, "プライバシー設定を保存しました。", TONE.SUCCESS);
  });
}

// ---- クイック保存先 ----

async function initQuickFolders() {
  const listDiv = document.getElementById("quick-folder-list");
  const statusDiv = document.getElementById("quick-folder-status");

  const tree = await chrome.bookmarks.getTree();
  const pathMap = getFolderPathMap(tree);
  const selectedIds = new Set(await getQuickFolderIds());

  const folders = collectFolderInfos(tree);
  if (folders.length === 0) {
    listDiv.textContent = "フォルダがありません。";
    return;
  }
  const checkboxes = folders.map(folder => {
    const checkbox = h("input", { attrs: { type: "checkbox", value: folder.id } });
    checkbox.checked = selectedIds.has(folder.id);
    const label = (pathMap.get(folder.id) || folder.name) + (folder.isUntouchable ? "（保護）" : "");
    listDiv.append(h("label", { className: "checkbox-line" }, checkbox, label));
    return checkbox;
  });

  listDiv.addEventListener("change", event => {
    if (checkboxes.filter(c => c.checked).length > MAX_QUICK_FOLDERS) {
      event.target.checked = false;
      setStatus(statusDiv, "クイック保存先は最大 " + MAX_QUICK_FOLDERS + " 件までです。", TONE.WARNING);
    }
  });

  document.getElementById("quick-folder-save-btn").addEventListener("click", async () => {
    const ids = checkboxes.filter(c => c.checked).map(c => c.value);
    await chrome.storage.local.set({ [KEYS.QUICK_FOLDERS]: ids });
    flashStatus(statusDiv, "クイック保存先を保存しました（" + ids.length + " 件）。右クリックメニューに反映されます。", TONE.SUCCESS);
  });
}
