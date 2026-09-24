// ② 再カテゴライズ: シミュレーションの実行・差分プレビューの操作・実適用・取り消し

import { LOW_CONFIDENCE_THRESHOLD, RELOCATE_CHUNK_SIZE } from "./config.js";
import { applyRelocation, getUndoRecord, isMoved, planRelocation, runRelocationSimulation, undoRelocation } from "./relocation.js";
import { getLlmConnection, getFolderDescriptions, getKnowledgeBase, getPrivacySettings } from "./storage.js";
import { TONE, formatDateTime, setStatus } from "./ui-common.js";
import { defaultSelection, deselectLowConfidence, renderDiff, selectAllMoved } from "./ui-diff.js";

const MAX_FAILED_NAMES_SHOWN = 3;
const PROGRESS_CLEAR_DELAY_MS = 3000; // 完了後、進捗の「(100%)」表示を消すまでの時間

/** @param {{onApiCall: () => void, reconcile?: () => Promise<unknown>}} hooks reconcile … AIを呼ぶ前に、保存データを現在のブックマークへ整合させる */
export function initRelocate({ onApiCall, reconcile = async () => {} }) {
  const relocateBtn = document.getElementById("relocate-btn");
  const progressText = document.getElementById("relocate-progress-text");
  const progressPercent = document.getElementById("relocate-progress-percent");
  const statusDiv = document.getElementById("relocate-status");
  const diffSection = document.getElementById("diff-section");
  const diffContainer = document.getElementById("diff-table-container");
  const diffSummary = document.getElementById("diff-summary");
  const applyBtn = document.getElementById("apply-relocate-btn");
  const undoBox = document.getElementById("undo-box");
  const undoInfo = document.getElementById("undo-info");
  const undoBtn = document.getElementById("undo-relocate-btn");
  const viewButtons = {
    unified: document.getElementById("btn-view-unified"),
    split: document.getElementById("btn-view-split")
  };

  /** @type {object[]|null} 現在プレビュー中の移動案 */
  let decisions = null;
  /** @type {import("./ui-diff.js").DiffState} */
  const diffState = { viewMode: "unified", changedOnly: true, sortMode: "default", selected: new Set() };

  // ---- シミュレーション ----

  relocateBtn.addEventListener("click", async () => {
    const connection = await getLlmConnection();
    if (!connection.apiKey) {
      setStatus(statusDiv, "エラー: 先にAPIキーを保存してください。", TONE.ERROR);
      return;
    }

    await reconcile(); // 判断材料（説明文・ナレッジ）を、現在のブックマークに合わせてから使う
    try {
      relocateBtn.disabled = true;
      diffSection.hidden = true;
      setStatus(statusDiv, "");
      progressText.textContent = "処理中: ブックマークツリーからエントリをロード中...";
      progressPercent.textContent = "(0%)";

      const privacy = await getPrivacySettings();
      const plan = planRelocation(await chrome.bookmarks.getTree(), privacy);

      // 上限を設けずに全件を判定するため、課金が発生する旨を実行前に確認する
      if (plan.chunkTotal > 0 && !confirm(
        plan.totalBookmarks + " 件のブックマークを、" + RELOCATE_CHUNK_SIZE + " 件ずつ " + plan.chunkTotal +
        " 回に分けてAIに判定させます。\nタイトルの無毒化を含め、最大 " + (plan.chunkTotal * 2) +
        " 回のAI API呼び出しが発生し、API利用料がかかります。\n\n実行しますか？")) {
        setStatus(statusDiv, "シミュレーションをキャンセルしました。", TONE.MUTED);
        return;
      }

      const { decisions: result, stats } = await runRelocationSimulation({
        connection,
        plan,
        descriptions: await getFolderDescriptions(),
        knowledgeBase: await getKnowledgeBase(),
        privacy,
        onProgress: ({ processedChunks, chunkTotal, folderName }) => {
          progressPercent.textContent = "(" + Math.round(processedChunks / chunkTotal * 100) + "%)";
          progressText.textContent = "処理中: カテゴリ「" + folderName + "」を解析中 (" + (processedChunks + 1) + "/" + chunkTotal + ")...";
        }
      });

      decisions = result;
      diffState.selected = defaultSelection(decisions);
      progressPercent.textContent = "(100%)";
      const { text, tone } = buildCompletionMessage(plan, stats);
      setStatus(statusDiv, text, tone);

      diffSection.hidden = false;
      render();
    } catch (error) {
      console.error(error);
      setStatus(statusDiv, "エラー: シミュレーションエラー: " + error.message, TONE.ERROR);
      progressPercent.textContent = "";
    } finally {
      relocateBtn.disabled = false;
      progressText.textContent = "";
      setTimeout(() => { progressPercent.textContent = ""; }, PROGRESS_CLEAR_DELAY_MS);
      onApiCall();
    }
  });

  // 判定できなかったブックマーク（セーフティ拒否・通信/応答エラー・送信対象外）は、成功と区別して報告する
  function buildCompletionMessage(plan, stats) {
    const { prohibitedFolderIds, failedFolders, abortedRemainingBookmarks, excludedCount } = stats;
    const hasUnjudged = prohibitedFolderIds.size > 0 || failedFolders.size > 0 || abortedRemainingBookmarks > 0;
    let text = hasUnjudged ?
      "シミュレーション完了（一部のブックマークは判定できませんでした）。以下の差分を確認して適用してください。" :
      "シミュレーション完了。以下の差分を確認して適用してください。";

    if (plan.protectedSkippedCount > 0) text += " (※ " + plan.protectedSkippedCount + " 件の保護フォルダは対象外としました)";
    if (excludedCount > 0) text += " (※ " + excludedCount + " 件はAIに送信しないURLのため、判定せず現状維持としました)";
    if (prohibitedFolderIds.size > 0) {
      text += " (※ " + prohibitedFolderIds.size + " 件のフォルダで、セーフティにより判定できなかったブックマークがあり、現状維持としました)";
    }
    if (failedFolders.size > 0) {
      const names = [...failedFolders.values()];
      const shown = names.slice(0, MAX_FAILED_NAMES_SHOWN).map(name => "「" + name + "」").join("");
      const rest = names.length - MAX_FAILED_NAMES_SHOWN;
      text += " (※ " + names.length + " 件のフォルダで、通信・応答エラーにより判定できなかったブックマークがあり、現状維持としました: " +
        shown + (rest > 0 ? " ほか" + rest + "件" : "") + ")";
    }
    if (abortedRemainingBookmarks > 0) {
      text += " (※ APIが連続して失敗したため処理を中断しました。残り " + abortedRemainingBookmarks +
        " 件のブックマークは未判定です。下部の動作ログで原因を確認してください)";
    }
    const lowCount = decisions.filter(d => isMoved(d) && (d.confidence_score ?? 0) < LOW_CONFIDENCE_THRESHOLD).length;
    if (lowCount > 0) text += " (※ 適合率が " + LOW_CONFIDENCE_THRESHOLD + "% 未満の移動案 " + lowCount + " 件は、初期状態で未選択にしています)";

    return { text, tone: hasUnjudged ? TONE.WARNING : TONE.SUCCESS };
  }

  // ---- 差分プレビューの操作 ----

  function render() {
    if (!decisions) return;
    renderDiff(diffContainer, decisions, diffState, updateSummary);
    updateSummary();
  }

  function updateSummary() {
    const movedCount = decisions ? decisions.filter(isMoved).length : 0;
    diffSummary.textContent = "移動候補 " + movedCount + " 件 / 選択中 " + diffState.selected.size + " 件";
  }

  function setViewMode(mode) {
    diffState.viewMode = mode;
    viewButtons.unified.classList.toggle("active", mode === "unified");
    viewButtons.split.classList.toggle("active", mode === "split");
    render();
  }
  viewButtons.unified.addEventListener("click", () => setViewMode("unified"));
  viewButtons.split.addEventListener("click", () => setViewMode("split"));

  document.getElementById("diff-changed-only").addEventListener("change", event => {
    diffState.changedOnly = event.target.checked;
    render();
  });
  document.getElementById("diff-sort").addEventListener("change", event => {
    diffState.sortMode = event.target.value;
    render();
  });
  document.getElementById("diff-select-all").addEventListener("click", () => {
    selectAllMoved(decisions, diffState.selected);
    render();
  });
  document.getElementById("diff-select-none").addEventListener("click", () => {
    diffState.selected.clear();
    render();
  });
  document.getElementById("diff-deselect-low").addEventListener("click", () => {
    deselectLowConfidence(decisions, diffState.selected);
    render();
  });

  // ---- 実適用 ----

  applyBtn.addEventListener("click", async () => {
    if (!decisions) return;
    const tasks = [...diffState.selected].sort((a, b) => a - b).map(index => decisions[index]);
    if (tasks.length === 0) {
      alert("適用対象としてチェックされている項目がありません。");
      return;
    }
    if (!confirm("選択された " + tasks.length + " 件のブックマーク再配置を実際のブラウザに適用します。よろしいですか？")) return;

    try {
      applyBtn.disabled = true;
      setStatus(statusDiv, "処理中: 実際のブックマークにフォルダ再配置を適用中...", TONE.MUTED);
      const { movedCount, guardedCount, failedCount } = await applyRelocation(tasks);

      const notes = [];
      if (guardedCount > 0) notes.push(guardedCount + " 件は保護フォルダに関わるため移動しませんでした");
      if (failedCount > 0) notes.push(failedCount + " 件は移動に失敗しました（削除済みなど）");
      const text = (movedCount > 0 ?
        "完了: " + movedCount + " 件のブックマークを移動しました。必要なら下の「元に戻す」で取り消せます。" :
        "移動したブックマークはありません。") + (notes.length > 0 ? " (※ " + notes.join(" / ") + ")" : "");
      setStatus(statusDiv, text, notes.length > 0 ? TONE.WARNING : TONE.SUCCESS);
      diffSection.hidden = true;
      decisions = null;
    } catch (error) {
      console.error(error);
      setStatus(statusDiv, "エラー: 実適用中にエラーが発生しました: " + error.message, TONE.ERROR);
    } finally {
      applyBtn.disabled = false;
      renderUndoBox();
    }
  });

  // ---- 取り消し（直前の1回分のみ） ----

  async function renderUndoBox() {
    const record = await getUndoRecord();
    undoBox.hidden = !record;
    if (record) {
      undoInfo.textContent = "直前の一括適用（" + formatDateTime(record.applied_at) + "・" + record.moves.length +
        " 件）を、元のフォルダ・位置に戻せます。";
    }
  }

  undoBtn.addEventListener("click", async () => {
    const record = await getUndoRecord();
    if (!record) {
      renderUndoBox();
      return;
    }
    if (!confirm(record.moves.length + " 件のブックマークを、適用前のフォルダ・位置に戻します。よろしいですか？")) return;

    try {
      undoBtn.disabled = true;
      setStatus(statusDiv, "処理中: 一括適用を取り消し中...", TONE.MUTED);
      const { restoredCount, changedSinceCount, guardedCount, failedCount } = await undoRelocation();

      const notes = [];
      if (changedSinceCount > 0) notes.push(changedSinceCount + " 件は適用後に移動されていたため対象外");
      if (guardedCount > 0) notes.push(guardedCount + " 件は保護フォルダに関わるため対象外");
      if (failedCount > 0) notes.push(failedCount + " 件は失敗（削除済みなど）");
      setStatus(statusDiv,
        "取り消し完了: " + restoredCount + " 件を元に戻しました。" + (notes.length > 0 ? " (※ " + notes.join(" / ") + ")" : ""),
        notes.length > 0 ? TONE.WARNING : TONE.SUCCESS);
    } catch (error) {
      console.error(error);
      setStatus(statusDiv, "エラー: 取り消し中にエラーが発生しました: " + error.message, TONE.ERROR);
    } finally {
      undoBtn.disabled = false;
      renderUndoBox();
    }
  });

  return { refresh: renderUndoBox };
}
