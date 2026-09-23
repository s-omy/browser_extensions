// ④ 動作ログ: Gemini API 呼び出し履歴と累計トークンの表示

import { clearGeminiLog, getGeminiLog, getGeminiUsage } from "./gemini.js";
import { formatDateTime, h } from "./ui-common.js";

// 動作ログの purpose（用途ID）の表示名
const PURPOSE_LABELS = {
  "bg:cleanse": "右クリック: 無毒化",
  "bg:categorize": "右クリック: 自動振り分け",
  "opt:cleanse-titles": "タイトル無毒化",
  "opt:folder-descriptions": "フォルダ解析",
  "opt:relocate": "再カテゴライズ",
  "opt:kb-sync": "ナレッジ同期",
  "opt:connection-test": "接続テスト"
};

// 動作ログの provider の表示名
const PROVIDER_LABELS = { gemini: "Gemini", openai_compatible: "OpenAI互換" };

const TABLE_HEADERS = ["時刻", "プロバイダ", "用途", "結果", "試行", "トークン(入/出)", "所要"];

export function initLog() {
  const section = document.getElementById("log-section");
  const summary = document.getElementById("log-summary");
  const tableContainer = document.getElementById("log-table-container");

  const describeResult = entry => entry.ok ?
    "成功" :
    "失敗: " + [entry.kind, entry.status ? "HTTP " + entry.status : "", entry.blockReason, entry.finishReason, entry.detail].filter(Boolean).join(" / ");

  async function refresh() {
    const [log, usage] = await Promise.all([getGeminiLog(), getGeminiUsage()]);
    summary.textContent = usage.calls === 0 ?
      "まだAPI呼び出しの記録はありません。" :
      "累計 " + usage.calls + " 回（失敗 " + usage.failedCalls + " 回） / 入力 " + usage.promptTokens.toLocaleString() +
      " トークン / 出力 " + usage.outputTokens.toLocaleString() + " トークン（この端末での実測値。記録開始: " + formatDateTime(usage.since) + "）";

    tableContainer.replaceChildren();
    if (log.length === 0) return;

    const rows = [...log].reverse().map(entry => {
      const cells = [
        formatDateTime(entry.at),
        PROVIDER_LABELS[entry.provider] || entry.provider || "-",
        PURPOSE_LABELS[entry.purpose] || entry.purpose,
        describeResult(entry),
        entry.attempts > 1 ? entry.attempts + " 回（リトライあり）" : "1 回",
        (entry.promptTokens ?? "-") + " / " + (entry.outputTokens ?? "-"),
        (entry.ms / 1000).toFixed(1) + " 秒"
      ];
      return h("tr", {}, cells.map((text, index) =>
        h("td", { text, className: index === 3 && !entry.ok ? "tone-error" : "" })));
    });
    tableContainer.append(h("table", { className: "category-table" },
      h("thead", {}, h("tr", {}, TABLE_HEADERS.map(label => h("th", { text: label })))),
      h("tbody", {}, rows)));
  }

  section.addEventListener("toggle", () => { if (section.open) refresh(); });
  document.getElementById("log-refresh-btn").addEventListener("click", refresh);
  document.getElementById("log-clear-btn").addEventListener("click", async () => {
    if (!confirm("動作ログと累計トークン数の記録を消去します。よろしいですか？")) return;
    await clearGeminiLog();
    refresh();
  });

  return { refresh };
}
