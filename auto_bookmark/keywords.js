// ページ知識のキーワード（タグ）を、1語ずつの配列にそろえる。DOM・chrome に依存しない純粋関数

// 語の区切りとして扱う文字: 半角・全角のカンマ、読点、セミコロン、スラッシュ、縦線、
// 改行・タブ・空白（半角・全角）。アンダースコアとハイフンは区切りにしない。
// 複数語の概念は machine_learning / MachineLearning のように1語で書く運用のため、語の一部として残す
const DELIMITERS = /[,，、;；\/／|｜\s]+/u;

/**
 * 文字列（または文字列の配列）を、語の配列にする。
 * 区切りで分割し、空の要素を除き、大文字・小文字の違いを除いて重複をまとめる（最初の綴りを残す）。
 * 配列の要素の中に区切りが含まれていても、1語ずつに分ける。文字列以外は無視する。
 * @param {string|string[]|null|undefined} input
 * @returns {string[]}
 */
export function normalizeKeywords(input) {
  const parts = Array.isArray(input) ? input : [input];
  const seen = new Set();
  const words = [];
  for (const part of parts) {
    if (typeof part !== "string") continue;
    for (const word of part.split(DELIMITERS)) {
      if (!word) continue;
      const key = word.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      words.push(word);
    }
  }
  return words;
}

/**
 * ページ知識の項目からキーワードを読む。`keywords`（配列）があればそれを、
 * 無ければ旧形式の `keyword`（区切り付きの文字列）を正規化して返す（データ移行が済む前の項目にも耐える）。
 * @param {{keywords?: string[], keyword?: string}|null|undefined} entry
 * @returns {string[]}
 */
export function getKeywords(entry) {
  if (!entry) return [];
  return Array.isArray(entry.keywords) ? normalizeKeywords(entry.keywords) : normalizeKeywords(entry.keyword);
}
