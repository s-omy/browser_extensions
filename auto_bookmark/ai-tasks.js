// AIに依頼する各タスク（プロンプト・応答スキーマ・応答の検証）
// API呼び出し自体のリトライ・ログ・プロバイダ差異の吸収は gemini.js の callGemini が担う。
// ここから先はどのプロバイダ（Gemini本体 / LiteLLM 等のOpenAI互換エンドポイント）が
// 選ばれているかを一切意識しない。呼び出し側は connection（storage.js の getLlmConnection() の戻り値）
// をそのまま渡すだけでよい。

import { callGemini, processWithBisect, describeGeminiError } from "./gemini.js";
import { ANALYZE_SAMPLE_ENTRIES } from "./config.js";
import { isAiSendableUrl, sanitizeUrlForAi } from "./privacy.js";
import { getKeywords, normalizeKeywords } from "./keywords.js";

// 「適合するフォルダがない」ことを示す、folder_id の enum に加える特別値
const UNCLASSIFIED_CHOICE = "UNCLASSIFIED";

// ---- 共通 ----

/** 配列から最大 limit 件を等間隔に選ぶ（件数の多いフォルダでも、全体の傾向を代表するように） */
function sampleEvenly(list, limit) {
  if (list.length <= limit) return list;
  return Array.from({ length: limit }, (_, i) => list[Math.floor(i * list.length / limit)]);
}

/**
 * タイトルの無毒化（AIのセーフティフィルターに誤判定されそうな表現をマイルドにする）。
 * ブロック・出力途切れのときは二分割して再試行し、原因のタイトルだけを切り分ける。
 * 無毒化できなかったタイトルは結果に含まれない（呼び出し側は元タイトルで続行する）。
 * @param {{id: string, title: string}[]} titles
 * @returns {Promise<Object<string, string>>} id → 無毒化後のタイトル
 */
async function cleanseTitlesBulk(connection, titles) {
  const resultMap = {};
  if (titles.length === 0) return resultMap;

  const prompt = "AIセーフティ誤判定を防ぐため、リスト内の過激表現等をマイルドな表現にクレンジングしてください。";
  const responseSchema = {
    type: "OBJECT",
    properties: {
      cleansed_items: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: { id: { type: "STRING" }, title: { type: "STRING" } },
          required: ["id", "title"]
        }
      }
    },
    required: ["cleansed_items"]
  };

  await processWithBisect(titles, async items => {
    const result = await callGemini({
      connection,
      purpose: "opt:cleanse-titles",
      parts: [prompt, JSON.stringify(items)],
      schema: responseSchema
    });
    const validIds = new Set(items.map(item => item.id));
    for (const item of (result.json.cleansed_items || [])) {
      if (validIds.has(item.id)) resultMap[item.id] = item.title;
    }
  });
  return resultMap;
}

/** 接続の疎通確認。成功すれば true、失敗すれば理由の文字列を含む Error を投げる */
export async function testConnection(connection) {
  try {
    await callGemini({ connection, purpose: "opt:connection-test", parts: ["接続テストです。「OK」とだけ返してください。"], maxAttempts: 1 });
    return true;
  } catch (error) {
    throw new Error(describeGeminiError(error));
  }
}

// ---- 右クリック／ショートカットからの自動振り分け ----

/**
 * 単一ページのタイトル・メタ情報を無毒化する（補助処理。失敗時は元のテキストを返す）。
 */
export async function cleanseText(connection, inputText, textType = "テキストデータ") {
  if (!inputText) return "";
  const prompt = "# あなたの役割\nあなたは入力された" + textType + "を監視し、AIのセーフティフィルターに誤判定されそうな単語を安全な表現に置換するデータクレンジング専門のAIです。\n\n# 処理ルール\n1. 不適切な単語をマイルドな表現に置き換え、元のニュアンスは維持してください。不都合がないものはそのまま出力します。余計な挨拶や解説は含めず無毒化した文字列のみを出力してください。";
  try {
    const result = await callGemini({ connection, purpose: "bg:cleanse", parts: [prompt + "\n\n# 入力\n" + inputText] });
    return result.text || inputText;
  } catch (error) {
    // 失敗しても元のテキストで続行する（失敗理由は動作ログに残る）
    return inputText;
  }
}

/**
 * ページの振り分け先フォルダを、候補の中から選ばせる。
 * 候補はフォルダIDで渡し、応答スキーマの enum でIDに拘束する（存在しないフォルダが返されないようにする）。
 * @param {object[]} candidates { folder_id, folder_name, hierarchical_categories, is_quick_access, description }
 * @returns {Promise<{status: "ok", folderId: string, confidence: number}
 *   | {status: "unclassified"} | {status: "error", reason: string}>}
 */
export async function categorizePage({ connection, url, cleansedContext, candidates }) {
  const candidateIds = candidates.map(c => c.folder_id);
  const prompt = "ユーザーが現在ブラウザで開いているWEBページを、提示された候補リストの中から最も適合率の高いフォルダに分類し、" +
    "そのfolder_idと確信度(confidence: 0〜100の整数)を返してください。" +
    "is_quick_access が true のフォルダは、ブックマークバーに置かれた日常的に使う重要なフォルダです。内容が同程度に適合する場合は優先してください。" +
    "適合するフォルダがない場合や迷う場合は「" + UNCLASSIFIED_CHOICE + "」を返してください。";
  const responseSchema = {
    type: "OBJECT",
    properties: {
      folder_id: { type: "STRING", enum: [...candidateIds, UNCLASSIFIED_CHOICE] },
      confidence: { type: "INTEGER" }
    },
    required: ["folder_id", "confidence"]
  };

  try {
    const result = await callGemini({
      connection,
      purpose: "bg:categorize",
      parts: [prompt, "【WEBページ情報】\n" + cleansedContext + "\nURL: " + url + "\n\n【カテゴリ候補】\n" + JSON.stringify(candidates)],
      schema: responseSchema
    });
    const chosen = result.json.folder_id;
    if (chosen === UNCLASSIFIED_CHOICE) return { status: "unclassified" };
    if (!candidateIds.includes(chosen)) return { status: "error", reason: "候補にないフォルダIDが返されました" };
    return { status: "ok", folderId: chosen, confidence: Number(result.json.confidence) || 0 };
  } catch (error) {
    console.warn(">> カテゴリ判定に失敗しました:", error);
    return { status: "error", reason: describeGeminiError(error) };
  }
}

// ---- ① フォルダ解析 ----

/**
 * フォルダ群（1バッチ分）の説明文を生成する。タイトルの無毒化→説明文の生成の順に行う。
 * 件数の多いフォルダは等間隔のサンプルだけをAIに渡す（全件数は total_entry_count で伝える）。
 * AIへ送れないURL（http/https以外・除外ドメイン）のブックマークは、サンプルにも含めない。
 * @returns {Promise<{descriptions: Map<string, string>, failed: {folderId: string, folderName: string, reason: string}[], fatal: Error|null}>}
 */
export async function describeFolders(connection, folders, privacy) {
  const samples = folders.map(f =>
    sampleEvenly(f.entries.filter(e => isAiSendableUrl(e.url, privacy)), ANALYZE_SAMPLE_ENTRIES));

  const titlesToCleanse = [];
  samples.forEach((entries, fIdx) => {
    entries.forEach((e, eIdx) => titlesToCleanse.push({ id: fIdx + "-" + eIdx, title: e.title }));
  });
  const cleansedMap = await cleanseTitlesBulk(connection, titlesToCleanse);

  const payload = folders.map((f, fIdx) => ({
    folder_id: f.folder_id,
    folder_name: f.folder_name,
    hierarchical_categories: f.hierarchical_categories,
    is_quick_access: f.is_quick_access,
    is_untouchable: f.is_untouchable,
    total_entry_count: f.entries.length,
    sample_entries: samples[fIdx].map((e, eIdx) => ({
      title: cleansedMap[fIdx + "-" + eIdx] || e.title,
      url: sanitizeUrlForAi(e.url, privacy)
    }))
  }));

  const descriptions = new Map();
  const outcome = await processWithBisect(payload, items => generateFolderDescriptions(connection, items, descriptions));

  const failed = outcome.failed.map(({ item, error }) => ({
    folderId: item.folder_id,
    folderName: item.folder_name,
    reason: describeGeminiError(error)
  }));
  if (!outcome.fatal) {
    // 応答に含まれなかったフォルダ（AIの返し漏れ）も失敗として扱う
    for (const item of payload) {
      if (!descriptions.has(item.folder_id) && !failed.some(f => f.folderId === item.folder_id)) {
        failed.push({ folderId: item.folder_id, folderName: item.folder_name, reason: "AIの応答に含まれていませんでした" });
      }
    }
  }
  return { descriptions, failed, fatal: outcome.fatal };
}

// folders の説明文を descriptionsOut（フォルダID → 説明文）に書き込む。失敗時は GeminiError を投げる
async function generateFolderDescriptions(connection, folders, descriptionsOut) {
  const prompt = "あなたは優秀なデータアナリストです。\n" +
    "提示されたユーザーのブックマーク構造（階層カテゴリパス、配下のエントリ、各種属性）を多角的に分析し、\n" +
    "それぞれのフォルダが『どのような具体的な関心・目的・技術スタック・利用シーン』を網羅しているかを示す高精度なDescription（説明文）を生成してください。\n\n" +
    "【制約事項】\n" +
    "・Descriptionは単なるフォルダ名やパスの言い換えではなく、配下のURLやタイトルの傾向、およびQuickAccessなどの属性から利用目的（例：『日常的に素早くアクセスするフロントエンド開発情報』など）を具体的に捉えた日本語1〜2文にしてください。\n" +
    "・is_quick_access が true のフォルダは、ブックマークバーに置かれた日常的に使う重要なフォルダです。\n" +
    "・total_entry_count はフォルダ内の全ブックマーク件数で、sample_entries はその一部（サンプル）です。サンプルから全体の傾向を読み取ってください。\n" +
    "・入力されたすべてのfolder_idについて、漏れなく1つずつオブジェクトを生成してください。";

  const responseSchema = {
    type: "OBJECT",
    properties: {
      analyzed_folders: {
        type: "ARRAY",
        description: "分析されたフォルダとその説明文のリスト",
        items: {
          type: "OBJECT",
          properties: {
            folder_id: { type: "STRING", enum: folders.map(f => f.folder_id), description: "入力データと完全に一致するfolder_id" },
            description: { type: "STRING", description: "そのフォルダの具体的な説明文（日本語、1〜2文）" }
          },
          required: ["folder_id", "description"]
        }
      }
    },
    required: ["analyzed_folders"]
  };

  const result = await callGemini({
    connection,
    purpose: "opt:folder-descriptions",
    parts: [prompt, "【解析対象メタデータ】\n" + JSON.stringify(folders)],
    schema: responseSchema,
    temperature: 0.2
  });
  const validIds = new Set(folders.map(f => f.folder_id));
  for (const item of (result.json.analyzed_folders || [])) {
    if (validIds.has(item.folder_id) && item.description) descriptionsOut.set(item.folder_id, item.description);
  }
}

// ---- ② 再カテゴライズ ----

/**
 * ブックマーク1チャンク分の移動先をAIに判定させる。失敗時は GeminiError を投げる。
 * AIには連番（seq）だけを渡し、戻りの連番から呼び出し側が実ブックマークIDを引き当てる。
 * @param {object[]} chunk { seq, title, url, current_folder_id }
 * @returns {Promise<{id: string, target_folder_id: string, confidence_score: number, reason: string}[]>}
 *   id は連番。チャンクにない連番（AIの捏造）は除去済み
 */
export async function judgeRelocationChunk({ connection, chunk, categories, candidateFolderIds, knowledgeBase, privacy }) {
  const cleansedMap = await cleanseTitlesBulk(connection, chunk.map(b => ({ id: b.seq, title: b.title })));

  // AIに渡す処理リスト（ナレッジメタ結合済み）。実ブックマークIDは含めない
  const modelInput = chunk.map(b => {
    const cache = knowledgeBase[b.url];
    return {
      id: b.seq,
      title: cleansedMap[b.seq] || b.title,
      url: sanitizeUrlForAi(b.url, privacy),
      current_folder_id: b.current_folder_id, // 移動不要な場合にAIが target_folder_id へ指定するID
      ai_knowledge_context: cache ?
        { subject: cache.subject, summary: cache.summary, description: cache.description, keywords: getKeywords(cache) } :
        "無し"
    };
  });

  const prompt = "高度なナレッジマネジメントAIとして、既存フォルダのdescriptionに基づきブックマークを再配置してください。" +
    "各ブックマークの移動先は、既存フォルダ一覧のfolder_idから選んでください。" +
    "移動が不要な場合は、そのブックマークのcurrent_folder_idと同じ値を返してください。" +
    "is_quick_access が true のフォルダは、ブックマークバーに置かれた日常的に使う重要なフォルダです。内容が同程度に適合する場合は優先してください。" +
    "指定スキーマJSONのみを返却してください。";

  // 存在しないフォルダが返されて意図せず新規作成されないよう、移動先を候補のIDだけに拘束する
  const responseSchema = {
    type: "OBJECT",
    properties: {
      relocations: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING" },
            target_folder_id: { type: "STRING", enum: candidateFolderIds },
            confidence_score: { type: "INTEGER" },
            reason: { type: "STRING" }
          },
          required: ["id", "target_folder_id", "confidence_score", "reason"]
        }
      }
    },
    required: ["relocations"]
  };

  const result = await callGemini({
    connection,
    purpose: "opt:relocate",
    parts: [prompt, "既存フォルダ:\n" + JSON.stringify(categories) + "\n\n処理リスト:\n" + JSON.stringify(modelInput)],
    schema: responseSchema,
    temperature: 0.2
  });
  const validSeqs = new Set(chunk.map(b => b.seq));
  return (result.json?.relocations || []).filter(r => validSeqs.has(r.id));
}

// ---- ③ ページ知識の同期 ----

/**
 * 複数件（URLとタイトル）をまとめて1回のAPI呼び出しで処理し、AIによる推定ナレッジを生成する。
 * ブロック・出力途切れ・応答不正のときは二分割して再試行し、原因の項目だけを切り分ける。
 * ページ本文は取得しておらず、結果はURLとタイトルからのAIの推定である。
 * @param {{url: string, title: string}[]} items AIへ送ってよいURLのものだけを渡すこと（URLは privacy 設定に従って整形して送る）
 * @returns {Promise<{done: Map<string, object>, failed: {url: string, reason: string}[], fatal: Error|null}>}
 */
export async function fetchKnowledgeBatch(connection, items, privacy) {
  const prompt =
    "各入力（id, url, title）について、URLとタイトルから、セーフティ誤判定されないクリーンなテーマ概要文脈オブジェクト(subject, summary, description, keywords)を生成してください。" +
    "keywords は、空白や区切り文字（カンマ・読点など）を含まない1語ずつの配列で返してください。複数語の概念は、machine_learning または MachineLearning のように1語にまとめてください（例: [\"React\", \"JavaScript\", \"machine_learning\"]）。" +
    "ページ本文は与えられていないため、URLとタイトルから推定できる範囲で書いてください。" +
    "入力のidをそのまま付けて、全件を1つずつ返してください。";
  const responseSchema = {
    type: "OBJECT",
    properties: {
      items: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            id: { type: "STRING" },
            subject: { type: "STRING" },
            summary: { type: "STRING" },
            description: { type: "STRING" },
            keywords: { type: "ARRAY", items: { type: "STRING" } }
          },
          required: ["id", "subject", "summary", "description", "keywords"]
        }
      }
    },
    required: ["items"]
  };

  const done = new Map();
  const failed = [];
  const outcome = await processWithBisect(items, async subItems => {
    const input = subItems.map((item, index) => ({
      id: String(index + 1),
      url: sanitizeUrlForAi(item.url, privacy),
      title: item.title
    }));
    const response = await callGemini({
      connection,
      purpose: "opt:kb-sync",
      parts: [prompt, JSON.stringify(input)],
      schema: responseSchema
    });
    const resultById = new Map((response.json.items || []).map(r => [r.id, r]));
    subItems.forEach((item, index) => {
      const r = resultById.get(String(index + 1));
      if (r) {
        // AIが区切りや空白を含む要素を返しても、1語ずつのタグにそろえて保存する
        done.set(item.url, { subject: r.subject, summary: r.summary, description: r.description, keywords: normalizeKeywords(r.keywords) });
      } else {
        failed.push({ url: item.url, reason: "AIの応答に含まれていませんでした" });
      }
    });
  });
  outcome.failed.forEach(({ item, error }) => failed.push({ url: item.url, reason: describeGeminiError(error) }));
  return { done, failed, fatal: outcome.fatal };
}
