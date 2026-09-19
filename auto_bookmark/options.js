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
      spinner.textContent = '⏳ ブックマークを読み込んでAIで無毒化クレンジング＆解析中...（しばらくお待ちください）';
      syncStatusDiv.textContent = '';

      // 1. ブラウザから全フォルダと配下のエントリを抽出
      const bookmarkTree = await chrome.bookmarks.getTree();
      const rawExtractedData = [];
      traverseAndExtract(bookmarkTree, rawExtractedData);

      if (rawExtractedData.length === 0) {
        throw new Error("解析対象のフォルダ（ブックマークが含まれるフォルダ）が見つかりませんでした。");
      }

      // 2. 【新規強化】全エントリのタイトルを一括で事前に無毒化
      const cleansedExtractedData = [];
      for (const folder of rawExtractedData) {
        const cleansedEntries = [];
        for (const entry of folder.entries) {
          // 独立した単独クレンジングを実処理の前に適用
          const cleanTitle = await cleanseText(apiKey, entry.title, "ブックマークのタイトル");
          cleansedEntries.push({ title: cleanTitle, url: entry.url });
        }
        cleansedExtractedData.push({
          folder_name: folder.folder_name,
          entries: cleansedEntries
        });
      }

      // 3. Gemini API (gemini-3.6-flash) で安全になったデータからDescriptionを一括生成
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

  // 【新規追加】options.js 側からも個別呼び出し可能な無毒化（データクレンジング）関数
  async function cleanseText(apiKey, inputText, textType = "テキストデータ") {
    if (!inputText) return "";
    const endpoint = `https://googleapis.com{apiKey}`;

    const prompt = `# あなたの役割
あなたは入力された${textType}を監視し、AIのセーフティフィルター（有害コンテンツ・成人向け・暴力表現など）に誤判定されそうな単語を、安全かつニュートラルな表現に置換（無毒化）するデータクレンジング専門のAIです。

# 処理ルール
1. 入力された文字列に、成人向け、暴力、犯罪、過激な政治、ヘイトスピーチ、またはそれらを連想させる不適切な単語（例: 「殺す」「ハッキング」「裏技」「アダルト」「流出」など）が含まれている場合、それらを「一般的なIT用語」や「一般的な表現」に置き換えてください。
2. 置き換えの際は、元のテキストのニュアンス（技術的な内容なのか、ニュースなのか、エンタメなのか）を極力維持しつつ、無害な表現にしてください。
3. セーフティフィルターに全く問題のないテキストは、一切変更せずそのまま出力してください。
4. 余計な挨拶や解説は一切含めず、無毒化した文字列のみを出力してください。

# 変換例
- 入力: Windowsのパスワードをハッキングして強制突破する裏技
  出力: Windowsのパスワードの再設定とセキュリティ検証方法
- 入力: 【閲覧注意】猟奇的な殺人事件の全貌について
  出力: 社会的な重大事件の経緯に関する考察
- 入力: 最新の成人向けコンテンツ配信サイトの動向
  出力: オンラインメディア配信業界の最新動向

# 入力${textType}
${inputText}`;

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            response_mime_type: "text/plain"
          }
        })
      });

      if (!response.ok) return inputText;
      const data = await response.json();
      return data.candidates[0].content.parts[0].text.trim();
    } catch (error) {
      console.error("クレンジング処理エラー:", error);
      return inputText;
    }
  }

  // gemini-3.6-flash を呼び出して構造化JSONを取得する関数
  async function generateDescriptionsViaGemini(apiKey, parsedData) {
    const endpoint = `https://googleapis.com{apiKey}`;

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
