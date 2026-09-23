// 設定画面の共通部品（DOM構築ヘルパー・状態表示・記号）

// 記号は、ソース上に直接書いた絵文字をここにまとめる
export const ICONS = Object.freeze({ FOLDER: "📁", FOLDER_OPEN: "📂", MINUS: "➖", PLUS: "➕" });

export const TONE = Object.freeze({ SUCCESS: "success", WARNING: "warning", ERROR: "error", MUTED: "muted" });

/**
 * 要素を作る。文字列の子要素はテキストノードとして追加される（HTMLとして解釈されないためXSSにならない）。
 * @param {string} tag
 * @param {{className?: string, text?: string, attrs?: Object<string, string>, on?: Object<string, Function>}} [props]
 * @param {...(Node|string|null|undefined|Array)} children
 */
export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text != null) node.textContent = props.text;
  for (const [name, value] of Object.entries(props.attrs || {})) node.setAttribute(name, value);
  for (const [eventName, handler] of Object.entries(props.on || {})) node.addEventListener(eventName, handler);
  for (const child of children.flat(Infinity)) {
    if (child != null) node.append(child);
  }
  return node;
}

/** 状態表示の行を更新する。色は tone に対応するCSSクラスで決まる */
export function setStatus(element, text, tone = TONE.MUTED) {
  element.textContent = text;
  element.classList.remove("tone-success", "tone-warning", "tone-error", "tone-muted");
  if (text) element.classList.add("tone-" + tone);
}

export function formatDateTime(timestamp) {
  return new Date(timestamp).toLocaleString();
}

/** 通常のWebページのURLだけをリンクにする（javascript: などのURLをリンクにしないため） */
export function isSafeLinkUrl(url) {
  return /^https?:\/\//i.test(url);
}
