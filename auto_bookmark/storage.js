// chrome.storage.local のキー定義と、データ形式の移行

import { collectFolderInfos } from "./bookmarks.js";
import { normalizePrivacySettings } from "./privacy.js";
import { DEFAULT_PROVIDER } from "./gemini.js";

/**
 * 保存データの一覧（すべて chrome.storage.local）
 *
 * gemini_key                  string   APIキー（暗号化はされず、この端末のブラウザ内に平文で保存される）。
 *                                      名前は歴史的なもので、現在はプロバイダ共通のAPIキー欄として使う
 * llm_provider                string   "gemini"（既定） | "openai_compatible"（LiteLLM Proxy 等）
 * llm_base_url                string   openai_compatible のときだけ使うエンドポイントのベースURL
 * llm_model                   string   モデル名。gemini では空なら既定モデルを使う。openai_compatible では必須
 * privacy_settings            object   { strip_query: boolean, excluded_domains: string[] }
 * quick_folders                string[] 右クリックメニューに載せるクイック保存先のフォルダID
 * folder_descriptions_by_id   object   { フォルダID: AI生成の説明文 }
 * folder_meta_tree            object[] { folder_id, folder_name, hierarchical_categories, is_quick_access,
 *                                        is_untouchable, entry_count, analyzed_entry_count }
 * page_knowledge_base         object   { URL: { subject, summary, description, keyword,
 *                                        hierarchical_categories, last_updated_at, source } }
 *                                      source: "ai_estimate"（URLとタイトルからのAI推定）| "page_meta"（ページのmetaタグ）
 * relocation_undo             object   { applied_at, moves: [{ id, title, fromParentId, fromIndex, toParentId }] }
 * gemini_log / gemini_usage   （gemini.js が管理する動作ログと累計トークン。provider・model を含む）
 * storage_version             number   データ形式の版数
 *
 * 旧形式: folder_descriptions（フォルダ名をキーにした説明文）。同名フォルダを区別できないため廃止した。
 */
export const KEYS = Object.freeze({
  API_KEY: "gemini_key",
  PROVIDER: "llm_provider",
  BASE_URL: "llm_base_url",
  MODEL: "llm_model",
  PRIVACY: "privacy_settings",
  QUICK_FOLDERS: "quick_folders",
  FOLDER_DESCRIPTIONS: "folder_descriptions_by_id",
  FOLDER_META: "folder_meta_tree",
  KNOWLEDGE_BASE: "page_knowledge_base",
  UNDO: "relocation_undo",
  VERSION: "storage_version",
  LEGACY_FOLDER_DESCRIPTIONS: "folder_descriptions"
});

export const STORAGE_VERSION = 2;

/**
 * 現在のプロバイダ設定（API呼び出しに使う接続情報）をまとめて返す。
 * provider が未設定の環境（旧バージョンからの利用者を含む）は "gemini" として扱う。
 * @returns {Promise<{provider: string, apiKey: string, baseUrl: string, model: string}>}
 */
export async function getLlmConnection() {
  const stored = await chrome.storage.local.get([KEYS.API_KEY, KEYS.PROVIDER, KEYS.BASE_URL, KEYS.MODEL]);
  return {
    provider: stored[KEYS.PROVIDER] || DEFAULT_PROVIDER,
    apiKey: stored[KEYS.API_KEY] || "",
    baseUrl: stored[KEYS.BASE_URL] || "",
    model: stored[KEYS.MODEL] || ""
  };
}

export async function getPrivacySettings() {
  const stored = await chrome.storage.local.get(KEYS.PRIVACY);
  return normalizePrivacySettings(stored[KEYS.PRIVACY]);
}

export async function getQuickFolderIds() {
  const stored = await chrome.storage.local.get(KEYS.QUICK_FOLDERS);
  return Array.isArray(stored[KEYS.QUICK_FOLDERS]) ? stored[KEYS.QUICK_FOLDERS] : [];
}

/** @returns {Promise<Object<string, string>>} フォルダID → 説明文 */
export async function getFolderDescriptions() {
  const stored = await chrome.storage.local.get(KEYS.FOLDER_DESCRIPTIONS);
  return stored[KEYS.FOLDER_DESCRIPTIONS] || {};
}

export async function getFolderMeta() {
  const stored = await chrome.storage.local.get(KEYS.FOLDER_META);
  return stored[KEYS.FOLDER_META] || [];
}

export async function getKnowledgeBase() {
  const stored = await chrome.storage.local.get(KEYS.KNOWLEDGE_BASE);
  return stored[KEYS.KNOWLEDGE_BASE] || {};
}

/**
 * 旧形式のデータを現行形式へ移行する（何度呼んでも安全）。
 * 旧: 説明文がフォルダ名キー → 新: フォルダIDキー。
 * 同名フォルダが複数あって対応を決められないものは移行せず、次回のフォルダ解析で再生成される。
 * @returns {Promise<boolean>} 移行を実施したか
 */
export async function migrateLegacyStorage() {
  const stored = await chrome.storage.local.get([KEYS.VERSION, KEYS.LEGACY_FOLDER_DESCRIPTIONS, KEYS.FOLDER_DESCRIPTIONS]);
  if ((stored[KEYS.VERSION] || 1) >= STORAGE_VERSION) return false;

  const legacy = stored[KEYS.LEGACY_FOLDER_DESCRIPTIONS];
  const update = { [KEYS.VERSION]: STORAGE_VERSION };

  if (legacy && typeof legacy === "object") {
    const idsByName = new Map();
    for (const folder of collectFolderInfos(await chrome.bookmarks.getTree())) {
      if (!idsByName.has(folder.name)) idsByName.set(folder.name, []);
      idsByName.get(folder.name).push(folder.id);
    }
    const migrated = {};
    for (const [name, description] of Object.entries(legacy)) {
      const ids = idsByName.get(name);
      if (ids && ids.length === 1) migrated[ids[0]] = description;
    }
    // 新形式で既に保存されている説明文を優先する
    update[KEYS.FOLDER_DESCRIPTIONS] = { ...migrated, ...(stored[KEYS.FOLDER_DESCRIPTIONS] || {}) };
  }

  await chrome.storage.local.set(update);
  if (legacy !== undefined) await chrome.storage.local.remove(KEYS.LEGACY_FOLDER_DESCRIPTIONS);
  return true;
}
