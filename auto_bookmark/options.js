document.addEventListener('DOMContentLoaded', () => {
  const keyInput = document.getElementById('api-key');
  const saveBtn = document.getElementById('save-btn');
  const statusDiv = document.getElementById('status');

  const analyzeBtn = document.getElementById('analyze-btn');
  const spinner = document.getElementById('loading-spinner');
  const syncStatusDiv = document.getElementById('sync-status');
  const categoryCountSpan = document.getElementById('category-count');
  const descListDiv = document.getElementById('desc-list');

  // 初期ロード時：保存されている状態を表示
  chrome.storage.local.get(['gemini_key', 'folder_descriptions'], (data) => {
    if (data.gemini_key) {
      keyInput.value = data.gemini_key;
    }
    if (data.folder_descriptions) {
      renderDescriptionPreview(data.folder_descriptions);
    }
  });

  // APIキーの保存
  saveBtn.addEventListener('click', () => {
    const key = keyInput.value.trim();
    chrome.storage.local.set({ gemini_key: key }, () => {
      statusDiv.textContent = '設定を安全にローカルへ保存しました。';
      statusDiv.style.color = 'green';
      setTimeout(() => { statusDiv.textContent = ''; }, 3000);
    });
  });

  // AI自動解析ボタンの処理
  analyzeBtn.addEventListener('click', async () => {
    const storage = await chrome.storage.local.get("gemini_key");
    const apiKey = storage.gemini_key;

    if (!apiKey) {
      syncStatusDiv.textContent = '❌ 先にAPIキーを保存してください。';
      syncStatusDiv.style.color = 'red';
      return;
    }

    try {
      analyzeBtn.disabled = true;
      spinner.textContent = '⏳ ブックマークを読み込んでAIで解析中...（数十秒かかる場合があります）';
      syncStatusDiv.textContent = '';

      // 1. ブラウザから全フォルダと配下のエントリを抽出
      const bookmarkTree = await chrome.bookmarks.getTree();
      const extractedData = [];
      traverseAndExtract(bookmarkTree, extractedData);

      if (extractedData.length === 0) {
        throw new Error("解析対象のフォルダ（ブックマークが含まれるフォルダ）が見つかりませんでした。");
      }

      // 2. Gemini API (gemini-3.6-flash) でDescriptionを一括生成
      const aiResult = await generateDescriptionsViaGemini(apiKey, extractedData);

      // 3. ストレージに保存して表示を更新
      chrome.storage.local.set({ folder_descriptions: aiResult }, () => {
        syncStatusDiv.textContent = '🎉 すべてのフォルダの解析とローカル同期が完了しました！';
        syncStatusDiv.style.color = 'green';
        renderDescriptionPreview(aiResult);
      });

    } catch (err) {
      console.error(err);
      syncStatusDiv.textContent = `❌ 解析エラー: ${err.message}`;
      syncStatusDiv.style.color = 'red';
    } finally {
      analyzeBtn.disabled = false;
      spinner.textContent = '';
    }
  });

  // ブックマークツリーから「フォルダ名」と「配下のエントリ最大30件のURL」を再帰抽出する関数
  function traverseAndExtract(nodes, resultList) {
    for (const node of nodes) {
      if (!node.url && node.title) {
        // フォルダの場合、配下の子要素からブックマーク（urlがあるもの）のみ最大30件抽出
        const entries = [];
        if (node.children) {
          for (const child of node.children) {
            if (child.url) {
              entries.push({ url: child.url });
            }
            if (entries.length >= 30) break; // 各フォルダ10件制限
          }
        }
        // ブックマークが1件以上含まれるフォルダのみ解析対象にする
        if (entries.length > 0) {
          resultList.push({
            folder_name: node.title,
            entries: entries
          });
        }
      }
      if (node.children) {
        traverseAndExtract(node.children, resultList);
      }
    }
  }

  // gemini-3.6-flash を呼び出して構造化JSONを取得する関数
  async function generateDescriptionsViaGemini(apiKey, parsedData) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

    const prompt = `
    あなたは優秀なデータアナリストです。
    提示されたユーザーのブックマークフォルダ構造と、そこに含まれるブックマークエントリのリストを分析し、
    それぞれのフォルダが「どのような具体的な関心・目的・技術スタック」を網羅しているかを示す高精度なDescription（説明文）を生成してください。

    【制約事項】
    ・Descriptionは単なるフォルダ名の言い換えではなく、配下のURLやタイトルの傾向を具体的に捉えた1〜2文の日本語にしてください。
    ・入力されたすべてのフォルダ（folder_name）について、漏れなく1つずつオブジェクトを生成してください。
    `;

    // 【最重要修正】additionalProperties を排除し、固定キーの配列構造に定義し直します
    const responseSchema = {
      type: "OBJECT",
      properties: {
        analyzed_folders: {
          type: "ARRAY",
          description: "分析されたフォルダとその説明文のリスト",
          items: {
            type: "OBJECT",
            properties: {
              folder_name: {
                type: "STRING",
                description: "入力データと完全に一致するフォルダ名"
              },
              description: {
                type: "STRING",
                description: "そのフォルダの具体的な説明文（日本語、1〜2文）"
              }
            },
            required: ["folder_name", "description"]
          }
        }
      },
      required: ["analyzed_folders"]
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          { parts: [
            { text: prompt },
            { text: `【解析対象データ】\n${JSON.stringify(parsedData)}` }
          ]}
        ],
        generationConfig: {
          temperature: 0.2,
          response_mime_type: "application/json",
          response_schema: responseSchema // 修正した安全なスキーマを適用
        }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API ${response.status}: ${errText}`);
    }

    const resData = await response.json();
    
    // AIは確実に { "analyzed_folders": [ { "folder_name": "...", "description": "..." }, ... ] } の形で返します
    const rawText = resData.candidates[0].content.parts[0].text;
    const jsonOutput = JSON.parse(rawText);

    // 【形式変換】background.js側が1発でデータ参照できるよう、
    // { "開発・技術": "説明文...", "生活": "..." } の単一オブジェクトに整形して返却します
    const unifiedObject = {};
    if (jsonOutput.analyzed_folders && Array.isArray(jsonOutput.analyzed_folders)) {
      jsonOutput.analyzed_folders.forEach(item => {
        if (item.folder_name && item.description) {
          unifiedObject[item.folder_name] = item.description;
        }
      });
    }

    return unifiedObject;
  }

  // プレビュー表示関数
  function renderDescriptionPreview(descriptions) {
    const keys = Object.keys(descriptions);
    categoryCountSpan.textContent = keys.length;
    
    if (keys.length === 0) {
      descListDiv.textContent = "同期されたデータはありません";
      return;
    }

    descListDiv.innerHTML = JSON.stringify(descriptions, null, 2).replace(/\n/g, '<br/>').replace(/ /g, '&nbsp;');
  }
});
