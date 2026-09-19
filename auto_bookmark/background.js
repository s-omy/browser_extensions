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

// 2.右クリックメニューがクリックされた時のイベントリスナー
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.pageUrl || tab.url;
  const title = tab.title;

  // 【拡張】APIキーに加えて、同期されたDescriptionデータもストレージから一括取得
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
    const bookmarkTree = await chrome.bookmarks.getTree();
    
    // ブラウザの全フォルダリストを取得
    const existingFolders = extractFolders(bookmarkTree);

    // 【新規】既存フォルダと、Pythonから同期したDescription（説明文）をマッピングした構造を作る
    const categoriesWithContext = existingFolders.map(folderName => {
      return {
        folder_name: folderName,
        // 同期データにDescriptionがあれば適用、なければ空文字
        description: folderDescriptions[folderName] || "説明なし（新規フォルダまたは未解析）"
      };
    });

    // マッピングされた高コンテキストなデータをAIに渡す
    targetFolder = await askGeminiForBestCategory(apiKey, url, title, categoriesWithContext);
  } else {
    const folderMapping = {
      "unclassified": "未分類",
      "dev-tech": "開発・技術",
      "hobby-ent": "趣味・娯楽",
      "life": "生活"
    };
    targetFolder = folderMapping[info.menuItemId];
  }

  // ブックマークを登録
  console.log(`>> '${targetFolder}' フォルダにブックマークを保存します...`);
  await createBookmarkInFolder(targetFolder, title, url);

  showNotification("ブックマーク保存完了", `「${targetFolder}」に登録しました。`);
});

// プロンプトへDescriptionコンテキストの動的埋め込み
async function askGeminiForBestCategory(apiKey, url, title, categoriesWithContext) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;
  
  const prompt = `
  ユーザーが現在ブラウザで開いているWEBページを、提示された【カテゴリ候補リスト（説明文付き）】の中から最も適切なフォルダに分類し、決定したフォルダ名（文字列）のみを返してください。

  【ルール】
  ・返却するテキストは、決定したフォルダ名のみ（例: "開発・技術"）とし、バッククォートや追加の説明文、マークダウン、改行は一切含めないでください。
  ・各フォルダの「description（説明文）」を深く読み込み、ページのタイトルやドメインの親和性が最も高いものを選択してください。
  ・どれにも当てはまらない、または迷う場合は「未分類」を返してください。

  【WEBページ情報】
  ・ページタイトル: ${title}
  ・URL: ${url}

  【カテゴリ候補リスト（説明文付きコンテキスト）】
  ${JSON.stringify(categoriesWithContext)}
  `;

  // （以下、fetch通信処理・エラーハンドリング・フォールバックは既存のままで問題ありません）
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
    return data.candidates[0].content.parts[0].text.trim();
  } catch (error) {
    console.error("Gemini API通信エラー:", error);
    return "未分類";
  }
}

// 4. 指定された名前のフォルダを探して、その中にブックマークを作成する関数
async function createBookmarkInFolder(folderName, title, url) {
  // 同名のフォルダがあるか検索
  const nodes = await chrome.bookmarks.search({ title: folderName });
  let folderId;

  // フォルダが見つかり、かつそれが「ブックマークエントリ」ではなく「フォルダ」であることを確認
  const folderNode = nodes.find(node => !node.url);

  if (folderNode) {
    folderId = folderNode.id;
  } else {
    // 存在しない場合は「ブックマークバー（通常はID '1'）」の配下に新規作成
    const newFolder = await chrome.bookmarks.create({ parentId: "1", title: folderName });
    folderId = newFolder.id;
  }

  // ブックマークを登録
  await chrome.bookmarks.create({ parentId: folderId, title: title, url: url });
  console.log(`>> '${folderName}' フォルダにブックマークを保存しました。`);
}

// 5. ブックマークツリーからフォルダ名だけを再帰的に抽出するヘルパー
function extractFolders(nodes, folderList = ["開発・技術", "趣味・娯楽", "生活", "未分類"]) {
  for (const node of nodes) {
    if (!node.url && node.title) {
      // 重複を防ぎつつリストに追加
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
