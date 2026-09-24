// 再配置の差分プレビュー（Unified / Split 表示）の描画

import { LOW_CONFIDENCE_THRESHOLD } from "./config.js";
import { isMoved } from "./relocation.js";
import { ICONS, h, isSafeLinkUrl } from "./ui-common.js";

/**
 * 表示状態
 * @typedef {object} DiffState
 * @property {"unified"|"split"} viewMode
 * @property {boolean} changedOnly 変更のある項目だけを表示する
 * @property {"default"|"score"} sortMode "score" は適合率の低い順
 * @property {Set<number>} selected 適用対象として選択中の項目（decisions のインデックス）
 */

/** 適合率の表記。未評価（confidence_score が null）は理由を添えて表示する */
function formatScore(item) {
  return item.confidence_score == null ? "未評価: " + item.reason : "適合率: " + item.confidence_score + "%";
}

/** 初期の選択状態。移動案のうち、適合率が閾値以上のものだけを選択済みにする（自信のない移動は手動で選ばせる） */
export function defaultSelection(decisions) {
  const selected = new Set();
  decisions.forEach((item, index) => {
    if (isMoved(item) && (item.confidence_score ?? 0) >= LOW_CONFIDENCE_THRESHOLD) selected.add(index);
  });
  return selected;
}

/** 適合率が閾値未満の移動案を、選択から外す */
export function deselectLowConfidence(decisions, selected) {
  decisions.forEach((item, index) => {
    if (isMoved(item) && (item.confidence_score ?? 0) < LOW_CONFIDENCE_THRESHOLD) selected.delete(index);
  });
}

export function selectAllMoved(decisions, selected) {
  decisions.forEach((item, index) => {
    if (isMoved(item)) selected.add(index);
  });
}

/**
 * 差分テーブルを描画する。
 * @param {HTMLElement} container
 * @param {object[]} decisions 移動案（relocation.js の decisions）
 * @param {DiffState} state
 * @param {() => void} onSelectionChange 選択が変わったときに呼ばれる
 */
export function renderDiff(container, decisions, state, onSelectionChange) {
  container.replaceChildren();

  const rows = decisions.map((item, index) => ({ item, index }));
  let visible = state.changedOnly ? rows.filter(row => isMoved(row.item)) : rows;
  if (state.sortMode === "score") {
    const scoreOf = row => row.item.confidence_score ?? -1;
    const moved = visible.filter(row => isMoved(row.item)).sort((a, b) => scoreOf(a) - scoreOf(b));
    visible = [...moved, ...visible.filter(row => !isMoved(row.item))];
  }

  if (visible.length === 0) {
    container.append(h("div", { className: "diff-empty", text: "表示する項目がありません。" }));
    return;
  }

  const isSplit = state.viewMode === "split";
  const headerCells = isSplit ?
    ["適用", "変更前の配置 (Before)", "変更後の配置 (After)"] :
    ["適用", "ブックマークタイトル / 配置状況"];
  const thead = h("thead", {}, h("tr", {}, headerCells.map((label, i) =>
    h("th", { className: i === 0 ? "action-cell" : "", text: label }))));

  const context = { state, onSelectionChange };
  const tbody = h("tbody", {}, visible.map(({ item, index }) => {
    if (!isMoved(item)) return isSplit ? splitUnchangedRow(item) : unifiedUnchangedRow(item);
    return isSplit ? splitMovedRows(item, index, context) : unifiedMovedRows(item, index, context);
  }));
  container.append(h("table", { className: "diff-table" }, thead, tbody));
}

// ---- 部品 ----

function createCheckboxCell(index, { state, onSelectionChange }, rowspan) {
  const checkbox = h("input", {
    className: "checkbox-apply",
    attrs: { type: "checkbox", "data-index": String(index) },
    on: {
      change: event => {
        if (event.target.checked) state.selected.add(index); else state.selected.delete(index);
        onSelectionChange();
      }
    }
  });
  checkbox.checked = state.selected.has(index);
  return h("td", { className: "action-cell", attrs: rowspan ? { rowspan: String(rowspan) } : {} }, checkbox);
}

function createBookmarkLink(item) {
  if (!isSafeLinkUrl(item.url)) return h("span", { className: "diff-bookmark-link", text: item.title });
  return h("a", { className: "diff-bookmark-link", text: item.title, attrs: { href: item.url, target: "_blank", rel: "noopener" } });
}

function createScoreBadge(item) {
  let variant = "badge-score";
  if (item.confidence_score == null) variant = "badge-score-unrated";
  else if (item.confidence_score < LOW_CONFIDENCE_THRESHOLD) variant = "badge-score-low";
  return h("span", { className: "badge " + variant, text: formatScore(item) });
}

function createReasonBlock(item) {
  return h("div", { className: "diff-reason-text", text: "理由: " + item.reason });
}

function createMainCell(item, colspan) {
  return h("td", { attrs: colspan ? { colspan: String(colspan) } : {} },
    createBookmarkLink(item), createScoreBadge(item), createReasonBlock(item));
}

// ---- Unified 表示 ----

function unifiedMovedRows(item, index, context) {
  return [
    h("tr", { className: "diff-item-header" }, createCheckboxCell(index, context), createMainCell(item)),
    h("tr", { className: "diff-row-deleted" },
      h("td", { className: "action-cell" }),
      h("td", { className: "diff-pad-left color-del" }, ICONS.MINUS + " 削除元フォルダ: ", h("strong", { text: item.current_category }))),
    h("tr", { className: "diff-row-added" },
      h("td", { className: "action-cell" }),
      h("td", { className: "diff-pad-left color-add" }, ICONS.PLUS + " 移動先フォルダ: ", h("strong", { text: item.target_category })))
  ];
}

function unifiedUnchangedRow(item) {
  return h("tr", { className: "diff-row-unchanged" },
    h("td", { className: "action-cell", text: "固定" }),
    h("td", {},
      h("span", { text: item.title }),
      h("div", { className: "diff-sub-info", text: "選択維持 " + ICONS.FOLDER + " " + item.target_category + " (" + formatScore(item) + ")" })));
}

// ---- Split 表示 ----

function splitMovedRows(item, index, context) {
  return [
    h("tr", { className: "diff-item-header" }, createCheckboxCell(index, context, 2), createMainCell(item, 2)),
    h("tr", {},
      h("td", { className: "diff-row-deleted color-del" }, ICONS.FOLDER + " ", h("strong", { text: item.current_category }), " から持ち出し"),
      h("td", { className: "diff-row-added color-add" }, ICONS.FOLDER + " ", h("strong", { text: item.target_category }), " へ格納"))
  ];
}

function splitUnchangedRow(item) {
  const suffix = item.confidence_score == null ? "・" + formatScore(item) : "";
  return h("tr", { className: "diff-row-unchanged" },
    h("td", { className: "action-cell", text: "固定" }),
    h("td", { text: ICONS.FOLDER_OPEN + " " + item.current_category }),
    h("td", { text: ICONS.FOLDER + " " + item.target_category + " (現状維持" + suffix + ")" }));
}
