// 拡張機能全体で共有する調整用の定数
// （挙動を変えたいときは、コードを探し回らずにここだけを見ればよいようにまとめている）

// ---- ナレッジベース同期（③） ----
export const KB_BATCH_SIZE = 20; // 1回のAPI呼び出しでまとめて処理するブックマーク数
export const KB_TTL_MS = 30 * 24 * 60 * 60 * 1000; // この期間を過ぎたナレッジは再取得の対象になる

// ---- フォルダ解析（①） ----
export const ANALYZE_FOLDERS_PER_BATCH = 8; // 1回のAPI呼び出しで説明文を生成するフォルダ数
export const ANALYZE_SAMPLE_ENTRIES = 30; // 説明文の生成にAIへ渡す、1フォルダあたりのサンプル件数
export const STALE_COUNT_MIN_DIFF = 5; // 解析後にこの件数以上ブックマークが増減したフォルダは「再解析が必要」とみなす
export const STALE_COUNT_RATIO = 0.2; // …または、解析時の件数に対してこの割合以上増減した場合

// ---- 再カテゴライズ（②） ----
export const RELOCATE_CHUNK_SIZE = 30; // 1回のAPI呼び出しで判定するブックマーク数（フォルダ内はこの件数ずつに分割する）
export const MAX_CONSECUTIVE_API_FAILURES = 3; // API失敗がこの回数連続したら、残りを試さず中断する
export const LOW_CONFIDENCE_THRESHOLD = 70; // 差分プレビューで、この適合率(%)未満の移動案は初期状態で未選択にする
export const UNDO_SAVE_INTERVAL = 20; // 一括適用の途中経過を、この件数ごとに取り消し用として保存する

// ---- 右クリック／ショートカットによる自動振り分け ----
export const MIN_AUTO_FILE_CONFIDENCE = 60; // AIの確信度(%)がこれ未満なら、推測で振り分けず「未分類」に入れる
export const MAX_QUICK_FOLDERS = 5; // 右クリックメニューに載せられるクイック保存先の最大数
export const RECENT_ACTIONS_LIMIT = 10; // 通知の「元に戻す」用に覚えておく直近の保存件数
