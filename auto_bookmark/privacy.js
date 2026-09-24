// Geminiへ送信するURLの制限（プライバシー設定）
// ブックマークのURL・タイトルなどはGoogleのGemini APIへ送信される。送る範囲をここで絞る。

const DEFAULT_PRIVACY_SETTINGS = Object.freeze({
  strip_query: false, // trueなら、送信するURLからクエリ文字列（?以降）とハッシュ（#以降）を取り除く
  excluded_domains: [] // ここに挙げたドメイン（およびそのサブドメイン）のURLは送信しない
});

/**
 * 改行・カンマ・空白区切りのテキストを、ドメイン名（小文字）の配列にする。
 * URLが貼り付けられた場合もホスト名だけを取り出す。
 */
export function parseDomainList(text) {
  const domains = [];
  for (const token of String(text || "").split(/[\s,、]+/)) {
    const trimmed = token.trim().toLowerCase();
    if (!trimmed) continue;
    let host = trimmed;
    try {
      host = new URL(trimmed.includes("://") ? trimmed : "https://" + trimmed).hostname;
    } catch (error) {
      continue; // ホスト名として解釈できないものは無視する
    }
    if (host && !domains.includes(host)) domains.push(host);
  }
  return domains;
}

/** 保存済みの設定に、未設定の項目の既定値を補う */
export function normalizePrivacySettings(stored) {
  return {
    strip_query: !!stored?.strip_query,
    excluded_domains: Array.isArray(stored?.excluded_domains) ? stored.excluded_domains : []
  };
}

/**
 * このURLをAIへ送ってよいか。
 * http/https 以外（javascript:, file:, chrome: など）と、除外ドメインのURLは送らない。
 */
export function isAiSendableUrl(url, settings = DEFAULT_PRIVACY_SETTINGS) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

  const host = parsed.hostname.toLowerCase();
  return !(settings.excluded_domains || []).some(domain => host === domain || host.endsWith("." + domain));
}

/** AIへ送る形にURLを整える（設定に応じてクエリ・ハッシュを落とす）。送信不可のURLでは呼ばないこと */
export function sanitizeUrlForAi(url, settings = DEFAULT_PRIVACY_SETTINGS) {
  if (!settings.strip_query) return url;
  try {
    const parsed = new URL(url);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch (error) {
    return url;
  }
}
