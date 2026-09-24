// ③ ページ知識（ナレッジベース）: 同期ボタンの操作・進捗表示・ナレッジ一覧の描画

import { UNTITLED_LABEL } from "./bookmarks.js";
import { KB_BATCH_SIZE } from "./config.js";
import { describeGeminiError } from "./gemini.js";
import { getKeywords, normalizeKeywords } from "./keywords.js";
import { operationLock } from "./reconcile.js";
import { KNOWLEDGE_SOURCE, applyLocalKbUpdates, collectBookmarksForKb, computeKbSyncPlan, runKbSync } from "./knowledge.js";
import { KEYS, getLlmConnection, getKnowledgeBase, getPrivacySettings } from "./storage.js";
import { TONE, h, isSafeLinkUrl, setStatus } from "./ui-common.js";

const SOURCE_LABELS = { [KNOWLEDGE_SOURCE.AI_ESTIMATE]: "AI推定", [KNOWLEDGE_SOURCE.PAGE_META]: "meta" };

/** @param {{onApiCall: () => void, reconcile?: () => Promise<unknown>}} hooks reconcile … AIを呼ぶ前に、保存データを現在のブックマークへ整合させる */
export function initKnowledge({ onApiCall, reconcile = async () => {} }) {
  const syncBtn = document.getElementById("kb-sync-btn");
  const stopBtn = document.getElementById("kb-stop-btn");
  const planText = document.getElementById("kb-plan-text");
  const indicator = document.getElementById("kb-sync-indicator");
  const progressPercent = document.getElementById("kb-progress-percent");
  const statusDiv = document.getElementById("kb-sync-status");
  const tableContainer = document.getElementById("kb-table-container");

  let isSyncRunning = false;
  let isStopRequested = false;

  // ---- 同期 ----

  // いま同期すると何件AIに問い合わせるかを、ボタンの横に表示する（ローカル計算のみ）
  async function refreshPlanText() {
    if (isSyncRunning) return;
    try {
      const plan = await computeKbSyncPlan(await getPrivacySettings());
      const excluded = plan.excludedCount > 0 ? "（AIに送信しないURL " + plan.excludedCount + " 件を除く）" : "";
      planText.textContent = plan.toFetch.length === 0 ?
        "ナレッジベースは最新です（AIへの問い合わせが必要なブックマーク: 0 件" + excluded + "）。" :
        "AIへの問い合わせが必要なブックマーク: " + plan.toFetch.length + " 件（新規 " + plan.newCount + " 件 / 期限切れ " +
        plan.expiredCount + " 件）→ 約 " + Math.ceil(plan.toFetch.length / KB_BATCH_SIZE) + " 回のAPI呼び出し" + excluded;
    } catch (error) {
      console.warn("同期計画の計算に失敗:", error);
      planText.textContent = "";
    }
  }

  // ナレッジの取得は課金が発生するため、必ずユーザーの操作と確認を経て実行する
  syncBtn.addEventListener("click", async () => {
    if (isSyncRunning) return;
    setStatus(statusDiv, "");

    const connection = await getLlmConnection();
    if (!connection.apiKey) {
      setStatus(statusDiv, "エラー: 先にAPIキーを保存してください。", TONE.ERROR);
      return;
    }

    await reconcile(); // 削除済みページの整理・所属パスの更新は、ここで済ませる（無料）
    const privacy = await getPrivacySettings();
    const plan = await computeKbSyncPlan(privacy);
    await applyLocalKbUpdates(plan); // AI不要の更新は先に反映する（無料）
    const localNotes = [];
    if (plan.pathOnly.length > 0) localNotes.push("フォルダパスを " + plan.pathOnly.length + " 件更新");
    if (plan.staleUrls.length > 0) localNotes.push("削除済みのナレッジを " + plan.staleUrls.length + " 件整理");
    const localNote = localNotes.length > 0 ? "（" + localNotes.join("、") + "）" : "";

    if (plan.toFetch.length === 0) {
      setStatus(statusDiv, "ナレッジベースは最新です。" + localNote, TONE.SUCCESS);
      await refresh();
      return;
    }

    if (!confirm(plan.toFetch.length + " 件のブックマーク（新規 " + plan.newCount + " 件 / 期限切れ " + plan.expiredCount +
        " 件）についてAIに問い合わせます。\n約 " + Math.ceil(plan.toFetch.length / KB_BATCH_SIZE) +
        " 回のAI API呼び出しが発生し、API利用料がかかります。\n途中で中止でき、保存済みの分は次回の続きから処理されます。\n\n実行しますか？")) {
      setStatus(statusDiv, "同期をキャンセルしました。" + localNote, TONE.MUTED);
      await refresh();
      return;
    }

    isSyncRunning = true;
    operationLock.enter("sync"); // 実行中は整合処理を始めない（保存内容の競合を避ける）
    isStopRequested = false;
    syncBtn.disabled = true;
    stopBtn.disabled = false;
    stopBtn.hidden = false;
    indicator.hidden = false;
    progressPercent.textContent = "(0%)";

    let outcome = { savedCount: 0, failedItems: [], fatal: null };
    try {
      outcome = await runKbSync({
        connection,
        plan,
        privacy,
        shouldStop: () => isStopRequested,
        onProgress: ({ processed, total }) => { progressPercent.textContent = "(" + Math.round(processed / total * 100) + "%)"; }
      });
    } catch (error) {
      console.error(error);
      outcome.fatal = error;
    } finally {
      isSyncRunning = false;
      operationLock.leave("sync");
      syncBtn.disabled = false;
      stopBtn.hidden = true;
      indicator.hidden = true;
      progressPercent.textContent = "";
    }

    const { savedCount, failedItems, fatal } = outcome;
    const notes = [];
    if (failedItems.length > 0) {
      notes.push(failedItems.length + " 件はAIが判定できず保存していません（次回の同期で再試行されます。理由: " + failedItems[0].reason + "）");
    }
    if (fatal) notes.push("APIエラーのため中断しました（" + describeGeminiError(fatal) + "）。保存済みの分は残っています");
    else if (isStopRequested) notes.push("中止しました。未処理の分は、次回の同期で続きから処理されます");
    setStatus(statusDiv,
      "同期" + (fatal || isStopRequested ? "終了" : "完了") + ": " + savedCount + " 件のナレッジを保存しました。" + localNote +
      (notes.length > 0 ? " (※ " + notes.join(" / ") + ")" : ""),
      notes.length > 0 ? TONE.WARNING : TONE.SUCCESS);

    await refresh();
    onApiCall();
  });

  stopBtn.addEventListener("click", () => {
    isStopRequested = true;
    stopBtn.disabled = true;
    setStatus(statusDiv, "中止を要求しました。処理中のバッチが終わり次第停止します...", TONE.WARNING);
  });

  // ---- ナレッジ一覧 ----

  // タグの編集は、同期と競合しないよう保存直前に読み直したナレッジに対して行う
  async function editKeywords(url, edit) {
    const knowledgeBase = await getKnowledgeBase();
    if (!knowledgeBase[url]) return;
    const entry = knowledgeBase[url];
    entry.keywords = normalizeKeywords(edit(getKeywords(entry)));
    delete entry.keyword; // 旧形式が残っていれば、ここで keywords に置き換える
    await chrome.storage.local.set({ [KEYS.KNOWLEDGE_BASE]: knowledgeBase });
    await renderTable();
  }

  function createKeywordCell(url, cache) {
    const keywords = getKeywords(cache);
    const tags = keywords.map(keyword => h("span", { className: "tag-item", text: keyword },
      h("span", {
        className: "tag-delete-btn",
        text: "×",
        on: {
          click: event => {
            event.stopPropagation(); // アコーディオンのクリック伝播を防止
            editKeywords(url, list => list.filter(k => k !== keyword));
          }
        }
      })));
    const addButton = h("span", {
      className: "tag-add-btn",
      text: "+ 追加",
      on: {
        click: event => {
          event.stopPropagation();
          // 空白・カンマなどで区切ると複数のタグとして追加される（重複は追加しない）。複数語の概念は machine_learning のように _ でつなぐ
          const added = normalizeKeywords(prompt("新しいキーワードを入力してください（空白やカンマで区切ると複数追加。複数語は machine_learning のように _ でつなぎます）：") || "");
          if (added.length > 0) editKeywords(url, list => [...list, ...added]);
        }
      }
    });
    return h("td", {}, h("div", { className: "tag-container" }, tags, addButton));
  }

  function createEntryRows(url, cache, bookmarkTitles) {
    const title = bookmarkTitles.get(url) ?? "未登録のURL";
    const titleNode = isSafeLinkUrl(url) ?
      h("a", { className: "diff-bookmark-link", text: title, attrs: { href: url, target: "_blank", rel: "noopener" } }) :
      h("span", { className: "diff-bookmark-link", text: title });
    const sourceLabel = SOURCE_LABELS[cache.source] || SOURCE_LABELS[KNOWLEDGE_SOURCE.AI_ESTIMATE];

    // 上段: タイトル | 大テーマ | 説明文（2行ぶち抜き）、下段: 要約 | キーワード
    return [
      h("tr", { className: "row-meta-top" },
        h("td", {}, titleNode, " ", h("span", { className: "attr-badge attr-badge-source", text: sourceLabel })),
        h("td", { className: "kb-subject", text: cache.subject || UNTITLED_LABEL }),
        h("td", { text: cache.description || "無し", attrs: { rowspan: "2" } })),
      h("tr", { className: "row-meta-bottom" },
        h("td", { text: cache.summary || "無し" }),
        createKeywordCell(url, cache))
    ];
  }

  async function renderTable() {
    const knowledgeBase = await getKnowledgeBase();
    tableContainer.replaceChildren();
    const urls = Object.keys(knowledgeBase);
    if (urls.length === 0) {
      tableContainer.textContent = "蓄積されたナレッジベースデータはありません。";
      return;
    }

    // 最新のブックマークタイトルを表示に使う
    const bookmarkTitles = new Map(collectBookmarksForKb(await chrome.bookmarks.getTree()).map(b => [b.url, b.title || UNTITLED_LABEL]));

    // 階層パス単位にグルーピングし、パス文字列を自然順序（数字を数値として比較）で昇順に並べる
    const groups = new Map();
    for (const url of urls) {
      const path = knowledgeBase[url].hierarchical_categories || "未分類";
      if (!groups.has(path)) groups.set(path, []);
      groups.get(path).push(url);
    }
    const sortedPaths = [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));

    const tbody = h("tbody");
    for (const path of sortedPaths) {
      const groupUrls = groups.get(path);
      const toggle = h("span", { text: "▼ ", attrs: { style: "margin-right: 8px;" } });
      const headerRow = h("tr", { className: "kb-group-header" },
        h("td", { attrs: { colspan: "3" } }, toggle, path + " (" + groupUrls.length + " 件)"));
      tbody.append(headerRow);

      const entryRows = groupUrls.flatMap(url => createEntryRows(url, knowledgeBase[url], bookmarkTitles));
      tbody.append(...entryRows);

      // アコーディオンの開閉
      let isOpen = true;
      headerRow.addEventListener("click", () => {
        isOpen = !isOpen;
        toggle.textContent = isOpen ? "▼ " : "▶ ";
        entryRows.forEach(row => { row.hidden = !isOpen; });
      });
    }

    tableContainer.append(h("table", { className: "knowledge-table" },
      h("thead", {}, h("tr", {},
        h("th", { text: "ページタイトル・URL / 大テーマ", attrs: { style: "width: 40%" } }),
        h("th", { text: "1文要約 / キーワード", attrs: { style: "width: 30%" } }),
        h("th", { text: "AI詳細説明文", attrs: { style: "width: 30%" } }))),
      tbody));
  }

  async function refresh() {
    await Promise.all([renderTable(), refreshPlanText()]);
  }
  return { refresh };
}
