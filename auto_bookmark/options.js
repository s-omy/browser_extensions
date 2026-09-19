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

  // 【高速化版】AI自動解析ボタンの処理
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
      spinner.textContent = '⏳ ブックマークを抽出中...';
      syncStatusDiv.textContent = '';

      // 1. ブラウザから全フォルダと配下のエントリを抽出
      const bookmarkTree = await chrome.bookmarks.getTree();
      const rawExtractedData = [];
      traverseAndExtract(bookmarkTree, rawExtractedData);

      if (rawExtractedData.length === 0) {
        throw new Error("解析対象のフォルダ（ブックマークが含まれるフォルダ）が見つかりませんでした。");
      }

      spinner.textContent = '⏳ 全タイトルを一括で無毒化クレンジング中...（1回で処理しています）';

      // 2. 【大幅高速化】一括クレンジング用のフラットなリストを作成
      const titlesToCleanse = [];
      rawExtractedData.forEach((folder, folderIdx) => {
        folder.entries.forEach((entry, entryIdx) => {
          titlesToCleanse.push({
            id: `${folderIdx}-${entryIdx}`, // 元のデータ構造に戻すためのユニークID
            title: entry.title
          });
        });
      });

      // 1回のリクエストで全タイトルを一括処理
      const cleansedTitlesMap = await cleanseTitlesBulk(apiKey, titlesToCleanse);

      // 元の構造（フォルダ階層）に無毒化されたタイトルをマッピングし直す
      const cleansedExtractedData = rawExtractedData.map((folder, folderIdx) => {
        const cleansedEntries = folder.entries.map((entry, entryIdx) => {
          const id = `${folderIdx}-${entryIdx}`;
          return {
            title: cleansedTitlesMap[id] || entry.title, // 万が一漏れがあれば元のタイトル
            url: entry.url
          };
        });
        return {
          folder_name: folder.folder_name,
          entries: cleansedEntries
        };
      });

      spinner.textContent = '⏳ 安全になったデータから高精度なフォルダDescriptionを生成中...';

      // 3. Gemini API (gemini-3.6-flash) でDescriptionを一括生成
      const aiResult = await generateDescriptionsViaGemini(apiKey, cleansedExtractedData);

      // 4. ストレージに保存して表示を更新
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

  // 【新規追加・一括版】JSON配列を受け取り、1回のAPIリクエストで全てのタイトルを無毒化する関数
  async function cleanseTitlesBulk(apiKey, titlesList) {
    if (titlesList.length === 0) return {};
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

    const prompt = `# あなたの役割
あなたは入力されたWebページのタイトルのリストを監視し、AIのセーフティフィルター（有害コンテンツ・成人向け・暴力表現など）に誤判定されそうな単語を、安全かつニュートラルな表現に置換（無毒化）するデータクレンジング専門のAIです。

# 処理ルール
1. 各アイテムの 'title' 文字列に、成人向け、暴力、犯罪、過激な政治、ヘイトスピーチ、またはそれらを連想させる不適切な単語（例: 「殺す」「ハッキング」「裏技」「アダルト」「流出」など）が含まれている場合、それらを「一般的なIT用語」や「一般的な表現」に置き換えてください。
2. 置き換えの際は、元のタイトルのニュアンス（技術的な内容なのか、ニュースなのか、エンタメなのか）を極力維持しつつ、無害な表現にしてください。
3. セーフティフィルターに全く問題のないタイトルは、一切変更せずそのまま出力してください。
4. 入力されたすべてのID（id）について、漏れなく1つずつオブジェクトを生成して返してください。
`;

    // 構造化出力（Structured Outputs）でIDとクレンジング後のタイトルを確実にマッピングさせる
    const responseSchema = {
      type: "OBJECT",
      properties: {
        cleansed_items: {
          type: "ARRAY",
          description: "無毒化処理が完了したタイトルのリスト",
          items: {
            type: "OBJECT",
            properties: {
              id: { type: "STRING", description: "入力データと完全に一致するID" },
              title: { type: "STRING", description: "無毒化・ニュアンス維持された安全なタイトル" }
            },
            required: ["id", "title"]
          }
        }
      },
      required: ["cleansed_items"]
    };

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          { parts: [
            { text: prompt },
            { text: `【クレンジング対象データ】\n${JSON.stringify(titlesList)}` }
          ]}
        ],
        generationConfig: {
          temperature: 0.1,
          response_mime_type: "application/json",
          response_schema: responseSchema
        }
      })
    });

    if (!response.ok) {
      throw new Error(`クレンジングAPIの通信に失敗しました (Status: ${response.status})`);
    }

    const resData = await response.json();
    const rawText = resData.candidates[0].content.parts[0].text;
    const jsonOutput = JSON.parse(rawText);

    // IDをキーにしたオブジェクトマッピングに変換して返却 { "0-0": "安全なタイトル", "0-1": "..." }
    const resultMap = {};
    if (jsonOutput.cleansed_items && Array.isArray(jsonOutput.cleansed_items)) {
      jsonOutput.cleansed_items.forEach(item => {
        resultMap[item.id] = item.title;
      });
    }
    return resultMap;
  }

  // ブックマークツリーから「フォルダ名」と「配下のエントリ最大30件」を再帰抽出する関数
  function traverseAndExtract(nodes, resultList) {
    for (const node of nodes) {
      if (!node.url && node.title) {
        const entries = [];
        if (node.children) {
          for (const child of node.children) {
            if (child.url) {
              // タイトルとURLを両方セット（後でクレンジングにかけます）
              entries.push({ title: child.title || "", url: child.url });
            }
            if (entries.length >= 30) break; 
          }
        }
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
          response_schema: responseSchema 
        }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API ${response.status}: ${errText}`);
    }

    const resData = await response.json();
    const rawText = resData.candidates[0].content.parts[0].text;
    const jsonOutput = JSON.parse(rawText);

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
