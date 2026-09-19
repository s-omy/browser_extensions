// 1. 拡張機能インストール時に右クリックメニュー（コンテキストメニュー）を構築
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "parent-bookmark",
    title: "📑ブックマーク",
    contexts: ["page", "tab"]
  });

  const subMenus = [
    { id: "auto-sort", title: "最適カテゴリへ追加" },
    { id: "unclassified", title: "未分類に追加" },
    { id: "dev-tech", title: "開発・技術" },
    { id: "hobby-ent", title: "趣味・娯楽" },
    { id: "life", title: "生活" }
  ];

  subMenus.forEach(menu => {
    chrome.contextMenus.create({
      id: menu.id,
      parentId: "parent-bookmark",
      title: menu.title,
      contexts: ["page", "tab"]
    });
  });
});

// 2. 右クリックメニューがクリックされた時のイベントリスナー
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.pageUrl || tab.url;
  const originalTitle = tab.title;

  const storage = await chrome.storage.local.get(["gemini_key", "folder_descriptions"]);
  const apiKey = storage.gemini_key;
  const folderDescriptions = storage.folder_descriptions || {};

  if (!apiKey) {
    showNotification("エラー", "Gemini APIキーが設定されていません。オプション画面から設定してください。");
    return;
  }

  let targetFolder = "";

  if (info.menuItemId === "auto-sort") {
    console.log(">> 最適カテゴリの自動判定を開始します...");

    // 【新規】タブの裏側から meta タグ情報 (description, keywords) を動的取得
    let pageMetaText = "取得失敗または無し";
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: getPageMetaData // 下部で定義しているインページ抽出関数を実行
      });
      if (results && results[0] && results[0].result) {
        pageMetaText = results[0].result;
      }
    } catch (scriptError) {
      console.warn("ページメタデータの取得をスキップしました (制限のあるページ、または未読み込みの可能性):", scriptError);
    }

    console.log(`>> 抽出されたメタ情報: "${pageMetaText}"`);

    // タイトルとメタ情報を合算したコンテキストを構築
    const combinedInputText = `タイトル: ${originalTitle}\n概要情報: ${pageMetaText}`;

    // 【無毒化】合算されたコンテキストを実処理の前に安全にサニタイズ
    console.log(">> ページコンテキストの無毒化クレンジング中...");
    const cleansedContext = await cleanseText(apiKey, combinedInputText, "Webページのコンテキスト（タイトル・メタデータ）");
    console.log(`>> クレンジング完了結果:\n${cleansedContext}`);

    // ブラウザの全フォルダリストを取得
    const bookmarkTree = await chrome.bookmarks.getTree();
    const existingFolders = extractFolders(bookmarkTree);

    const categoriesWithContext = existingFolders.map(folderName => {
      return {
        folder_name: folderName,
        description: folderDescriptions[folderName] || "説明なし（新規フォルダまたは未解析）"
      };
    });

    // 無毒化された高密度コンテキスト情報を元にAI判定へ
    targetFolder = await askGeminiForBestCategory(apiKey, url, cleansedContext, categoriesWithContext);
  } else {
    const folderMapping = {
      "unclassified": "未分類",
      "dev-tech": "開発・技術",
      "hobby-ent": "趣味・娯楽",
      "life": "生活"
    };
    targetFolder = folderMapping[info.menuItemId];
  }

  console.log(`>> '${targetFolder}' フォルダにブックマークを保存します...`);
  await createBookmarkInFolder(targetFolder, originalTitle, url); // 保存時は本来のタイトルで登録

  showNotification("ブックマーク保存完了", `「${targetFolder}」に登録しました。`);
});

// 【新規追加】アクティブなWEBページ（DOM内）で実行され、metaタグを抽出する軽量関数
function getPageMetaData() {
  const descTag = document.querySelector('meta[name="description"]') || document.querySelector('meta[property="og:description"]');
  const keyTag = document.querySelector('meta[name="keywords"]');
  
  const desc = descTag ? descTag.getAttribute('content') : '';
  const keywords = keyTag ? keyTag.getAttribute('content') : '';
  
  return `[Description]: ${desc || '無し'} | [Keywords]: ${keywords || '無し'}`;
}

// あらゆるテキストを無毒化（ニュートラル化）する独立したクレンジング関数
async function cleanseText(apiKey, inputText, textType = "テキストデータ") {
  if (!inputText) return "";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

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
  出力: 社会的な重大事件の経経に関する考察
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
    return data.candidates.content.parts.text.trim();
  } catch (error) {
    console.error("クレンジング処理エラー:", error);
    return inputText;
  }
}

// プロンプトへDescriptionコンテキストの動的埋め込み
async function askGeminiForBestCategory(apiKey, url, cleansedContext, categoriesWithContext) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;
  
  const prompt = `
  ユーザーが現在ブラウザで開いているWEBページを、提示された【カテゴリ候補リスト（説明文付き）】の中から最も適切なフォルダに分類し、決定したフォルダ名（文字列）のみを返してください。

  【ルール】
  ・返却するテキストは、決定したフォルダ名のみ（例: "開発・技術"）とし、バッククォートや追加の説明文、マークダウン、改行は一切含めないでください。
  ・各フォルダの「description（説明文）」を深く読み込み、提供されたWEBページのコンテキスト情報との親和性が最も高いものを選択してください。
  ・どれにも当てはまらない、または迷う場合は「未分類」を返してください。

  【WEBページ情報（データクレンジング済）】
  ${cleansedContext}
  ・URL: ${url}

  【カテゴリ候補リスト（説明文付きコンテキスト）】
  ${JSON.stringify(categoriesWithContext)}
  `;

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
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`API Error: ${response.status} - ${errText}`);
    }
    const data = await response.json();
    return data.candidates.content.parts.text.trim();
  } catch (error) {
    console.error("Gemini API通信エラー:", error);
    return "未分類";
  }
}

// 指定された名前のフォルダを探して、その中にブックマークを作成する関数
async function createBookmarkInFolder(folderName, title, url) {
  const nodes = await chrome.bookmarks.search({ title: folderName });
  let folderId;
  const folderNode = nodes.find(node => !node.url);

  if (folderNode) {
    folderId = folderNode.id;
  } else {
    const newFolder = await chrome.bookmarks.create({ parentId: "1", title: folderName });
    folderId = newFolder.id;
  }
  await chrome.bookmarks.create({ parentId: folderId, title: title, url: url });
}

// ブックマークツリーからフォルダ名だけを再帰的に抽出するヘルパー
function extractFolders(nodes, folderList = ["開発・技術", "趣味・娯楽", "生活", "未分類"]) {
  for (const node of nodes) {
    if (!node.url && node.title) {
      if (!folderList.includes(node.title)) {
        folderList.push(node.title);
      }
    }
    if (node.children) {
      extractFolders(node.children, folderList);
    }
  }
  return folderList;
}

// 通知ポップアップを表示
function showNotification(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon.png", 
    title: title,
    message: message,
    priority: 2
  });
}
