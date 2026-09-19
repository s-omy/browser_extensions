document.addEventListener('DOMContentLoaded', () => {
// オプション画面が開かれた時に、裏側で自動的に未同期ページの無毒化ナレッジキャッシュを構築
syncPageKnowledgeBase();

	// DOM要素の取得
	const keyInput = document.getElementById('api-key');
	const saveBtn = document.getElementById('save-btn');
	const statusDiv = document.getElementById('status');

	const analyzeBtn = document.getElementById('analyze-btn');
	const spinner = document.getElementById('loading-spinner');
	const syncStatusDiv = document.getElementById('sync-status');
	const categoryCountSpan = document.getElementById('category-count');
	const descListDiv = document.getElementById('desc-list');

	// 再配置関連のDOM要素
	const relocateBtn = document.getElementById('relocate-btn');
	const relocateSpinner = document.getElementById('relocate-spinner');
	const relocateStatusDiv = document.getElementById('relocate-status');
	const diffSection = document.getElementById('diff-section');
	const diffTableContainer = document.getElementById('diff-table-container');
	const btnViewUnified = document.getElementById('btn-view-unified');
	const btnViewSplit = document.getElementById('btn-view-split');
	const applyRelocateBtn = document.getElementById('apply-relocate-btn');

	// グローバルなシミュレーション状態保持
	let currentSimulationData = null;
	let currentViewMode = "unified"; // "unified" | "split"

	// 初期ロード時：ローカル記憶データの復元
	chrome.storage.local.get(['gemini_key', 'folder_descriptions'], (data) => {
		if (data.gemini_key) keyInput.value = data.gemini_key;
		if (data.folder_descriptions) renderDescriptionPreview(data.folder_descriptions);
	});

	// APIキーの保存
	saveBtn.addEventListener('click', () => {
		const key = keyInput.value.trim();
		chrome.storage.local.set({
			gemini_key: key
		}, () => {
			statusDiv.textContent = '設定を安全にローカルへ保存しました。';
			statusDiv.style.color = 'green';
			setTimeout(() => {
				statusDiv.textContent = '';
			}, 3000);
		});
	});

	// ========================================================
	// ① フォルダコンテキスト解析ロジック
	// ========================================================
	analyzeBtn.addEventListener('click', async() => {
		const storage = await chrome.storage.local.get("gemini_key");
		const apiKey = storage.gemini_key;
		if (!apiKey) {
			syncStatusDiv.textContent = 'エラー: 先にAPIキーを保存してください。';
			syncStatusDiv.style.color = 'red';
			return;
		}

		try {
			analyzeBtn.disabled = true;
			spinner.textContent = '処理中: ブックマークを抽出中...';
			syncStatusDiv.textContent = '';

			const bookmarkTree = await chrome.bookmarks.getTree();
			const rawExtractedData = [];
			traverseAndExtract(bookmarkTree, rawExtractedData);

			if (rawExtractedData.length === 0) throw new Error(
				"解析対象のフォルダが見つかりませんでした。");

			spinner.textContent = '処理中: タイトルを一括クレンジング中...';
			const titlesToCleanse = [];
			rawExtractedData.forEach((f, fIdx) => {
				f.entries.forEach((e, eIdx) => {
					titlesToCleanse.push({
						id: fIdx + "-" + eIdx,
						title: e.title
					});
				});
			});

			const cleansedMap = await cleanseTitlesBulk(apiKey, titlesToCleanse);

			const cleansedExtractedData = rawExtractedData.map((f, fIdx) => {
				const es = f.entries.map((e, eIdx) => ({
					title: cleansedMap[fIdx + "-" + eIdx] || e.title,
					url: e.url
				}));
				return {
					folder_name: f.folder_name,
					entries: es
				};
			});

			spinner.textContent = '処理中: 高精度なDescriptionを生成中...';
			const aiResult = await generateDescriptionsViaGemini(apiKey,
				cleansedExtractedData);

			chrome.storage.local.set({
				folder_descriptions: aiResult
			}, () => {
				syncStatusDiv.textContent = '完了: フォルダ構造の同期が完了しました！';
				syncStatusDiv.style.color = 'green';
				renderDescriptionPreview(aiResult);
			});
		} catch (err) {
			console.error(err);
			syncStatusDiv.textContent = "エラー: 解析エラー: " + err.message;
			syncStatusDiv.style.color = 'red';
		} finally {
			analyzeBtn.disabled = false;
			spinner.textContent = '';
		}
	});

// ========================================================
// ② 再配置シミュレーションロジック（クレンジング＆シミュレーション双方の完全チャンク分割版）
// ========================================================
relocateBtn.addEventListener('click', async () => {
  const storage = await chrome.storage.local.get(["gemini_key", "folder_descriptions", "page_knowledge_base"]);
  const apiKey = storage.gemini_key;
  const folderDescriptions = storage.folder_descriptions || {};
  const pageKnowledgeBase = storage.page_knowledge_base || {};

  if (!apiKey) {
    relocateStatusDiv.textContent = 'エラー: 先にAPIキーを保存してください。';
    relocateStatusDiv.style.color = 'red';
    return;
  }

  try {
    relocateBtn.disabled = true;
    diffSection.style.display = "none";
    relocateSpinner.textContent = '処理中: ブックマークツリーからエントリをロード中...';
    relocateStatusDiv.textContent = '';

    const bookmarkTree = await chrome.bookmarks.getTree();
    const existingFolders = [];
    extractAllFolderNames(bookmarkTree, existingFolders);

    const bookmarksToProcess = [];
    flattenBookmarksToProcessBounded(bookmarkTree, bookmarksToProcess);

    if (bookmarksToProcess.length === 0) throw new Error("処理対象のエントリが存在しません。");

    const categoriesWithDesc = existingFolders.map(name => {
      const isUntouchable = name.startsWith("[") && name.endsWith("]");
      return {
        folder_name: name,
        description: folderDescriptions[name] || "説明なし（未解析のフォルダ）",
        is_untouchable: isUntouchable
      };
    });

    // 1. タイトルのチャンク分割クレンジング処理
    relocateSpinner.textContent = '処理中: 安全なサイズに分割して一括クレンジング中...';
    const titlesToCleanse = bookmarksToProcess.map(b => ({ id: b.id, title: b.title }));
    const cleansedMap = {};
    const chunkSize = 50; 
    
    for (let i = 0; i < titlesToCleanse.length; i += chunkSize) {
      const chunk = titlesToCleanse.slice(i, i + chunkSize);
      relocateSpinner.textContent = "処理中: タイトル無毒化中 (" + (i + chunk.length) + "/" + titlesToCleanse.length + " 件)...";
      const chunkResult = await cleanseTitlesBulk(apiKey, chunk);
      Object.assign(cleansedMap, chunkResult);
    }

    // 2. クレンジングデータに「ローカルナレッジベース（同期済メタ）」を結合して高文脈化
    const cleansedBookmarks = bookmarksToProcess.map(b => {
      const cachedContext = pageKnowledgeBase[b.url] || null;
      return {
        id: b.id,
        title: cleansedMap[b.id] || b.title,
        url: b.url,
        current_category: b.current_category,
        // ストレージに無毒化情報が蓄積されていればAIへの判定材料として自動付与
        ai_knowledge_context: cachedContext ? {
          subject: cachedContext.subject,
          summary: cachedContext.summary,
          description: cachedContext.description,
          keyword: cachedContext.keyword
        } : "ローカルメタデータ未同期"
      };
    });

    // 3. 【最重要】シミュレーションAPI本体も50件ずつに小分けして連打・統合を実行
    relocateSpinner.textContent = '処理中: 安全なサイズに分割して再配置シミュレーションを実行中...';
    const aggregatedRelocations = [];

    for (let i = 0; i < cleansedBookmarks.length; i += chunkSize) {
      const chunk = cleansedBookmarks.slice(i, i + chunkSize);
      relocateSpinner.textContent = "処理中: AI適合率判定を実行中 (" + (i + chunk.length) + "/" + cleansedBookmarks.length + " 件)...";
      
      const chunkSimulationResult = await runRelocationSimulationViaGemini(apiKey, categoriesWithDesc, chunk);
      if (chunkSimulationResult && chunkSimulationResult.relocations) {
        aggregatedRelocations.push(...chunkSimulationResult.relocations);
      }
    }

    // オリジナルの綺麗なタイトルを再結合
    currentSimulationData = aggregatedRelocations.map(decision => {
      const original = bookmarksToProcess.find(b => b.id === decision.id);
      return {
        ...decision,
        title: original ? original.title : decision.title
      };
    });

    relocateStatusDiv.textContent = '完了: 全チャンクの統合が完了しました。以下の差分を確認して適用してください。';
    relocateStatusDiv.style.color = 'green';
    
    diffSection.style.display = "block";
    renderDiff();

  } catch (err) {
    console.error(err);
    relocateStatusDiv.textContent = "エラー: シミュレーションエラー: " + err.message;
    relocateStatusDiv.style.color = 'red';
  } finally {
    relocateBtn.disabled = false;
    relocateSpinner.textContent = '';
  }
});



	btnViewUnified.addEventListener('click', () => {
		currentViewMode = "unified";
		btnViewUnified.classList.add('active');
		btnViewSplit.classList.remove('active');
		renderDiff();
	});
	btnViewSplit.addEventListener('click', () => {
		currentViewMode = "split";
		btnViewSplit.classList.add('active');
		btnViewUnified.classList.remove('active');
		renderDiff();
	});

	// ========================================================
	// ③ 差分（Diff）レンダリングシステム（生タグ・生エスケープ絵文字完全追放版）
	// ========================================================
	function renderDiff() {
		if (!currentSimulationData || currentSimulationData.length === 0) return;

		diffTableContainer.innerHTML = "";

		const table = document.createElement("table");
		table.className = "diff-table";

		const thead = document.createElement("thead");
		const headerRow = document.createElement("tr");

		const thApply = document.createElement("th");
		thApply.className = "action-cell";
		thApply.textContent = "適用";
		headerRow.appendChild(thApply);

		if (currentViewMode === "unified") {
			const thContent = document.createElement("th");
			thContent.textContent = "ブックマークタイトル / 配置状況";
			headerRow.appendChild(thContent);
			thead.appendChild(headerRow);
			table.appendChild(thead);

			const tbody = document.createElement("tbody");

			currentSimulationData.forEach((item, index) => {
				const isMoved = item.current_category !== item.target_category;

				if (isMoved) {
					const trHead = document.createElement("tr");
					trHead.className = "diff-item-header";

					const tdCheck = document.createElement("td");
					tdCheck.className = "action-cell";
					const chk = document.createElement("input");
					chk.type = "checkbox";
					chk.className = "checkbox-apply";
					chk.setAttribute("data-index", index.toString());
					chk.checked = true;
					tdCheck.appendChild(chk);
					trHead.appendChild(tdCheck);

					const tdMain = document.createElement("td");
					const anchor = document.createElement("a");
					anchor.href = item.url;
					anchor.target = "_blank";
					anchor.className = "diff-bookmark-link";
					anchor.textContent = item.title;
					tdMain.appendChild(anchor);

					const badge = document.createElement("span");
					badge.className = "badge badge-score";
					badge.textContent = "適合率: " + item.confidence_score + "%";
					tdMain.appendChild(badge);

					const reasonDiv = document.createElement("div");
					reasonDiv.className = "diff-reason-text";
					reasonDiv.textContent = "理由: " + item.reason;
					tdMain.appendChild(reasonDiv);
					trHead.appendChild(tdMain);
					tbody.appendChild(trHead);

					const trDel = document.createElement("tr");
					trDel.className = "diff-row-deleted";
					const tdDelEmpty = document.createElement("td");
					tdDelEmpty.className = "action-cell";
					trDel.appendChild(tdDelEmpty);

					const tdDelText = document.createElement("td");
					tdDelText.className = "diff-pad-left color-del";

					// 【根本解決】生記号やエスケープを使わず、10進数コードポイントから文字を動的生成
					const minusChar = String.fromCodePoint(10134);

					const txtDelPrefix = document.createTextNode(minusChar + " 削除元フォルダ: ");
					const strongDel = document.createElement("strong");
					strongDel.textContent = item.current_category;
					tdDelText.appendChild(txtDelPrefix);
					tdDelText.appendChild(strongDel);
					trDel.appendChild(tdDelText);
					tbody.appendChild(trDel);
					const trAdd = document.createElement("tr");
					trAdd.className = "diff-row-added";
					const tdAddEmpty = document.createElement("td");
					tdAddEmpty.className = "action-cell";
					trAdd.appendChild(tdAddEmpty);
					const tdAddText = document.createElement("td");
					tdAddText.className = "diff-pad-left color-add";
					const plusChar = String.fromCodePoint(10133);
					const txtAddPrefix = document.createTextNode(plusChar + " 移動先フォルダ: ");
					const strongAdd = document.createElement("strong");
					strongAdd.textContent = item.target_category;
					tdAddText.appendChild(txtAddPrefix);
					tdAddText.appendChild(strongAdd);
					trAdd.appendChild(tdAddText);
					tbody.appendChild(trAdd);
				} else {
					const trUnchanged = document.createElement("tr");
					trUnchanged.className = "diff-row-unchanged";
					const tdFixed = document.createElement("td");
					tdFixed.className = "action-cell";
					tdFixed.style.color = "#ccc";
					tdFixed.textContent = "固定";
					trUnchanged.appendChild(tdFixed);
					const tdContent = document.createElement("td");
					const spanTitle = document.createElement("span");
					spanTitle.textContent = item.title;
					tdContent.appendChild(spanTitle);
					const infoDiv = document.createElement("div");
					infoDiv.className = "diff-sub-info";
					const folderChar = String.fromCodePoint(128193);
					infoDiv.textContent = "選択維持 " + folderChar + " " + item.target_category +
						" (適合率: " + item.confidence_score + "%)";
					tdContent.appendChild(infoDiv);
					trUnchanged.appendChild(tdContent);
					tbody.appendChild(trUnchanged);
				}
			});
			table.appendChild(tbody);
		} else {
			// Split モード
			const thBefore = document.createElement("th");
			thBefore.textContent = "変更前の配置 (Before)";
			headerRow.appendChild(thBefore);
			const thAfter = document.createElement("th");
			thAfter.textContent = "変更後の配置 (After)";
			headerRow.appendChild(thAfter);
			thead.appendChild(headerRow);
			table.appendChild(thead);
			const tbody = document.createElement("tbody");
			currentSimulationData.forEach((item, index) => {
				const isMoved = item.current_category !== item.target_category;
				if (isMoved) {
					const trTop = document.createElement("tr");
					trTop.className = "diff-item-header";
					const tdCheck = document.createElement("td");
					tdCheck.className = "action-cell";
					tdCheck.setAttribute("rowspan", "2");
					const chk = document.createElement("input");
					chk.type = "checkbox";
					chk.className = "checkbox-apply";
					chk.setAttribute("data-index", index.toString());
					chk.checked = true;
					tdCheck.appendChild(chk);
					trTop.appendChild(tdCheck);
					const tdMain = document.createElement("td");
					tdMain.setAttribute("colspan", "2");
					const anchor = document.createElement("a");
					anchor.href = item.url;
					anchor.target = "_blank";
					anchor.className = "diff-bookmark-link";
					anchor.textContent = item.title;
					tdMain.appendChild(anchor);
					const badge = document.createElement("span");
					badge.className = "badge badge-score";
					badge.textContent = "適合率: " + item.confidence_score + "%";
					tdMain.appendChild(badge);
					const reasonDiv = document.createElement("div");
					reasonDiv.className = "diff-reason-text";
					reasonDiv.textContent = "理由: " + item.reason;
					tdMain.appendChild(reasonDiv);
					trTop.appendChild(tdMain);
					tbody.appendChild(trTop);
					const trBottom = document.createElement("tr");
					const tdBeforeNode = document.createElement("td");
					tdBeforeNode.className = "diff-row-deleted color-del";
					const folderChar = String.fromCodePoint(128193);
					const txtBeforePrefix = document.createTextNode(folderChar + " ");
					const strongBefore = document.createElement("strong");
					strongBefore.textContent = item.current_category;
					const txtBeforeSuffix = document.createTextNode(" から持ち出し");
					tdBeforeNode.appendChild(txtBeforePrefix);
					tdBeforeNode.appendChild(strongBefore);
					tdBeforeNode.appendChild(txtBeforeSuffix);
					trBottom.appendChild(tdBeforeNode);
					const tdAfterNode = document.createElement("td");
					tdAfterNode.className = "diff-row-added color-add";
					const txtAfterPrefix = document.createTextNode(folderChar + " ");
					const strongAfter = document.createElement("strong");
					strongAfter.textContent = item.target_category;
					const txtAfterSuffix = document.createTextNode(" へ格納");
					tdAfterNode.appendChild(txtAfterPrefix);
					tdAfterNode.appendChild(strongAfter);
					tdAfterNode.appendChild(txtAfterSuffix);
					trBottom.appendChild(tdAfterNode);
					tbody.appendChild(trBottom);
				} else {
					const trUnchanged = document.createElement("tr");
					trUnchanged.className = "diff-row-unchanged";
					const tdFixed = document.createElement("td");
					tdFixed.className = "action-cell";
					tdFixed.style.color = "#ccc";
					tdFixed.textContent = "固定";
					trUnchanged.appendChild(tdFixed);
					const tdBeforeNode = document.createElement("td");
					tdBeforeNode.textContent = "📂 " + item.current_category;
					trUnchanged.appendChild(tdBeforeNode);
					const tdAfterNode = document.createElement("td");
					const folderChar = String.fromCodePoint(128193);
					tdAfterNode.textContent = folderChar + " " + item.target_category +
						" (現状維持)";
					trUnchanged.appendChild(tdAfterNode);
					tbody.appendChild(trUnchanged);
				}
			});
			table.appendChild(tbody);
		}
		diffTableContainer.appendChild(table);
	}
	// ========================================================
	// ④ 確定更新・実データへの反映処理
	// ========================================================
	applyRelocateBtn.addEventListener('click', async() => {
		if (!currentSimulationData) return;
		const checkboxes = diffTableContainer.querySelectorAll('.checkbox-apply');
		const relocateTasks = [];
		checkboxes.forEach(cb => {
			if (cb.checked) {
				const idx = parseInt(cb.getAttribute('data-index'));
				relocateTasks.push(currentSimulationData[idx]);
			}
		});
		if (relocateTasks.length === 0) {
			alert("適用対象としてチェックされている項目がありません。");
			return;
		}
		if (!confirm("選択された " + relocateTasks.length +
				" 件 of ブックマーク再配置を実際のブラウザに適用します。よろしいですか？")) {
			return;
		}
		try {
			applyRelocateBtn.disabled = true;
			relocateStatusDiv.textContent = '処理中: 実際のブックマークにフォルダ再配置を適用中...';
			relocateStatusDiv.style.color = '#333';
			for (const task of relocateTasks) {
				const targetFolderId = await getOrCreateFolderIdByName(task.target_category);
				await chrome.bookmarks.move(task.id, {
					parentId: targetFolderId
				});
			}
			relocateStatusDiv.textContent = "完了: " + relocateTasks.length +
				" 件のブックマーク移動が正常に完了しました！";
			relocateStatusDiv.style.color = 'green';
			diffSection.style.display = "none";
			currentSimulationData = null;
		} catch (error) {
			console.error(error);
			relocateStatusDiv.textContent = "エラー: 実適用中にエラーが発生しました: " + error.message;
			relocateStatusDiv.style.color = 'red';
		} finally {
			applyRelocateBtn.disabled = false;
		}
	});
	// ========================================================
	// 共通データ抽出・API通信ヘルパー関数群
	// ========================================================
	function flattenBookmarksToProcess(nodes, result) {
		for (const node of nodes) {
			if (node.url) {
				result.push({
					id: node.id,
					title: node.title || "無題のページ",
					url: node.url,
					current_category: node.parentName || "未分類"
				});
			} else {
				if (node.children) {
					node.children.forEach(child => {
						if (node.title) child.parentName = node.title;
					});
					flattenBookmarksToProcess(node.children, result);
				}
			}
		}
	}

	function flattenBookmarksToProcessBounded(nodes, result) {
		for (const node of nodes) {
			if (!node.url && node.children) { // フォルダノードの場合、直下の子要素（ブックマーク）をカウントしながら最大30件だけ制限抽出
				let count = 0;
				for (const child of node.children) {
					if (child.url) {
						result.push({
							id: child.id,
							title: child.title || "無題のページ",
							url: child.url,
							current_category: node.title || "未分類"
						});
						count++;
						if (count >= 30) break; // フォルダあたり30件制限
					}
				} // 下位階層のフォルダも再帰的に走査
				node.children.forEach(child => {
					if (!child.url) {
						flattenBookmarksToProcessBounded([child], result);
					}
				});
			}
		}
	}

	function extractAllFolderNames(nodes, folderList) {
		for (const node of nodes) {
			if (!node.url && node.title) {
				if (!folderList.includes(node.title)) folderList.push(node.title);
			}
			if (node.children) extractAllFolderNames(node.children, folderList);
		}
	}
	async function getOrCreateFolderIdByName(folderName) {
		const nodes = await chrome.bookmarks.search({
			title: folderName
		});
		const target = nodes.find(n => !n.url);
		if (target) return target.id;
		const newFolder = await chrome.bookmarks.create({
			parentId: "1",
			title: folderName
		});
		return newFolder.id;
	}
	async function runRelocationSimulationViaGemini(apiKey, categories,
		bookmarks) {
		const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;
		const prompt =
			"あなたは高度なナレッジマネジメントAIです。ユーザーのブックマークを、以下のベースカテゴリ、処理ルール、および現在のコンテキストを元に、最も適合率の高いフォルダへと再配置・最適化してください。 " +
			"ベースカテゴリは、1.開発・技術 2.趣味・娯楽 3.生活 です。 " +
			"ルール1: フォルダ名が角括弧で囲まれているフォルダはアンタッチャブル対象として、現在のtarget_categoryを絶対維持し、変更を行ってはなりません。 " +
			"ルール2: 各エントリについて移動先フォルダの説明文とのマッチングを評価し適合率(0-100)を算出してください。未分類にあるものの現在適合率は0%とします。入力データのid属性は一文字も違わず出力に含めてください。";
		const responseSchema = {
			type: "OBJECT",
			properties: {
				relocations: {
					type: "ARRAY",
					description: "全ブックマークエントリの再配置決定リスト",
					items: {
						type: "OBJECT",
						properties: {
							id: {
								type: "STRING",
								description: "固有ID"
							},
							title: {
								type: "STRING",
								description: "タイトル"
							},
							url: {
								type: "STRING",
								description: "URL"
							},
							current_category: {
								type: "STRING",
								description: "変更前のフォルダ名"
							},
							target_category: {
								type: "STRING",
								description: "最適な移動先フォルダ名"
							},
							confidence_score: {
								type: "INTEGER",
								description: "適合率"
							},
							reason: {
								type: "STRING",
								description: "論理的な理由"
							}
						},
						required: ["id", "title", "url", "current_category", "target_category",
							"confidence_score", "reason"
						]
					}
				}
			},
			required: ["relocations"]
		};
		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				"Content-Type": "application/json"
			},
			body: JSON.stringify({
				contents: [{
					parts: [{
						text: prompt
					}, {
						text: "既存フォルダ情報:\n" + JSON.stringify(categories) +
							"\n\n処理対象リスト:\n" + JSON.stringify(bookmarks)
					}]
				}],
				generationConfig: {
					temperature: 0.2,
					response_mime_type: "application/json",
					response_schema: responseSchema
				}
			})
		});
		if (!response.ok) throw new Error("再配置シミュレーションAPIの通信に失敗しました。");
		const resData = await response.json();
		const textOutput = resData.candidates[0].content.parts[0].text;
		if (!textOutput) throw new Error(
			"Geminiからの応答データが空、または安全フィルターによってブロックされました。");
		return JSON.parse(textOutput);
	}

	function traverseAndExtract(nodes, resultList) {
		for (const node of nodes) {
			if (!node.url && node.title) {
				const entries = [];
				if (node.children) {
					for (const child of node.children) {
						if (child.url) entries.push({
							title: child.title || "",
							url: child.url
						});
						if (entries.length >= 30) break;
					}
				}
				if (entries.length > 0) resultList.push({
					folder_name: node.title,
					entries: entries
				});
			}
			if (node.children) traverseAndExtract(node.children, resultList);
		}
	}

	// ========================================================
	// クレンジング通信関数（プロンプト抽象化・セーフティ対策版）
	// ========================================================
	async function cleanseTitlesBulk(apiKey, titlesList) {
		if (titlesList.length === 0) return {};
		const endpoint=`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

		const prompt = "# あなたの役割\n" +
			"あなたは入力されたWEBページのタイトルのリストを精査し、AIのシステムポリシーやセーフティフィルター（公序良俗に反する表現、成人向け表現、過激または不適切なトピックなど）に誤判定・過剰検知されそうな単語を検出し、一般的なIT用語やマイルドな表現に置換（サニタイズ）するデータクレンジングの専門AIです。\n\n" +
			"# 処理ルール\n" +
			"1. 各アイテムの 'title' 内に、セーフティポリシーを刺激する恐れのある単語（過激なハッキング、刺激の強いトピック、成人向けコンテンツのタイトル名など）が含まれている場合、それらを元の文脈（技術解説なのか、ニュースなのか）を崩さない範囲で「安全でニュートラルなIT用語」に書き換えてください。\n" +
			"2. セーフティ上全く問題のない健全なタイトルは、1文字も変更せずそのまま出力してください。\n" +
			"3. 入力されたすべてのID（id）について、漏れなく1つずつオブジェクトを維持して返してください。解説文は一切不要です。";

		const responseSchema = {
			type: "OBJECT",
			properties: {
				cleansed_items: {
					type: "ARRAY",
					items: {
						type: "OBJECT",
						properties: {
							id: {
								type: "STRING"
							},
							title: {
								type: "STRING"
							}
						},
						required: ["id", "title"]
					}
				}
			},
			required: ["cleansed_items"]
		};

		try {
			const response = await fetch(endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json"
				},
				body: JSON.stringify({
					contents: [{
						parts: [{
							text: prompt
						}, {
							text: JSON.stringify(titlesList)
						}]
					}],
					generationConfig: {
						temperature: 0.1,
						response_mime_type: "application/json",
						response_schema: responseSchema
					}
				})
			});

			if (!response.ok) return {};
			const resData = await response.json();

			const textOutput = resData.candidates[0].content.parts[0].text;
			if (!textOutput) {
				console.warn("一部のチャンクがフィルター制限を受けたため、フォールバックを実施します。");
				const fallbackMap = {};
				titlesList.forEach(item => {
					fallbackMap[item.id] = item.title;
				});
				return fallbackMap;
			}

			const jsonOutput = JSON.parse(textOutput);
			const resultMap = {};
			if (jsonOutput.cleansed_items) {
				jsonOutput.cleansed_items.forEach(item => {
					resultMap[item.id] = item.title;
				});
			}
			return resultMap;
		} catch (e) {
			console.error("クレンジングチャンク通信エラー。元のタイトルで維持します:", e);
			const fallbackMap = {};
			titlesList.forEach(item => {
				fallbackMap[item.id] = item.title;
			});
			return fallbackMap;
		}
	}

	async function generateDescriptionsViaGemini(apiKey, parsedData) {
		const endpoint=`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;
		const prompt =
			"ユーザーのブックマーク構造を分析し、各フォルダの内容を具体的に捉えた日本語1〜2文のDescriptionを生成してください。";
		const responseSchema = {
			type: "OBJECT",
			properties: {
				analyzed_folders: {
					type: "ARRAY",
					items: {
						type: "OBJECT",
						properties: {
							folder_name: {
								type: "STRING"
							},
							description: {
								type: "STRING"
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
			headers: {
				"Content-Type": "application/json"
			},
			body: JSON.stringify({
				contents: [{
					parts: [{
						text: prompt
					}, {
						text: JSON.stringify(parsedData)
					}]
				}],
				generationConfig: {
					temperature: 0.2,
					response_mime_type: "application/json",
					response_schema: responseSchema
				}
			})
		});
		if (!response.ok) throw new Error("Description生成に失敗しました。");
		const resData = await response.json();
		const textOutput = resData.candidates[0].content.parts[0].text;
		if (!textOutput) throw new Error("Description生成がセーフティフィルターにより拒否されました。");
		const jsonOutput = JSON.parse(textOutput);
		const unifiedObject = {};
		if (jsonOutput.analyzed_folders) {
			jsonOutput.analyzed_folders.forEach(item => {
				unifiedObject[item.folder_name] = item.description;
			});
		}
		return unifiedObject;
	}

	function renderDescriptionPreview(descriptions) {
		const keys = Object.keys(descriptions);
		categoryCountSpan.textContent = keys.length;
		if (keys.length === 0) {
			descListDiv.textContent = "同期されたデータはありません";
			return;
		}
		descListDiv.innerHTML = JSON.stringify(descriptions, null, 2).replace(/\n/g,
			'').replace(/ /g, ' ');
	}
});

// ========================================================
// ページコンテキスト（ナレッジベース）の非同期同期・ライフサイクル管理関数
// ========================================================
async function syncPageKnowledgeBase() {
  const storage = await chrome.storage.local.get(["gemini_key", "page_knowledge_base"]);
  const apiKey = storage.gemini_key;
  const pageKnowledgeBase = storage.page_knowledge_base || {};

  if (!apiKey) return;

  const bookmarkTree = await chrome.bookmarks.getTree();
  const flatBookmarks = [];
  
  // フラットな全ブックマークを走査
  function collectAll(nodes) {
    for (const node of nodes) {
      if (node.url) {
        flatBookmarks.push({ id: node.id, title: node.title, url: node.url, dateAdded: node.dateAdded });
      }
      if (node.children) collectAll(node.children);
    }
  }
  collectAll(bookmarkTree);

  const now = Date.now();
  const oneMonthMs = 30 * 24 * 60 * 60 * 1000; // 1ヶ月のミリ秒換算
  let isUpdated = false;

  for (const bookmark of flatBookmarks) {
    const cache = pageKnowledgeBase[bookmark.url];
    
    // 条件検証: キャッシュが存在しない、または取得日時（あるいはブックマーク登録日時）から1ヶ月以上経過しているか
    const isCacheMissing = !cache;
    const isCacheExpired = cache && (now - cache.last_updated_at > oneMonthMs);
    const isBookmarkNewerThanCache = cache && bookmark.dateAdded && (bookmark.dateAdded > cache.last_updated_at);

    if (isCacheMissing || isCacheExpired || isBookmarkNewerThanCache) {
      console.log(">> ナレッジの新規同期・再取得が必要なURLを発見しました: " + bookmark.url);
      
      try {
        // Gemini APIに直接アクセスし、対象ページのメタデータ情報から安全・無毒化されたコンテキストを1発で生成
        const knowledge = await fetchAndCleansePageMetaContext(apiKey, bookmark.url, bookmark.title);
        
        if (knowledge) {
          pageKnowledgeBase[bookmark.url] = {
            ...knowledge,
            last_updated_at: now // 再取得トリガー管理用のタイムスタンプ
          };
          isUpdated = true;
          
          // APIへの連続負荷を和らげるため、ローカル処理の合間にわずかなウェイトを挟む（セーフティ渋滞対策）
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (error) {
        console.warn("URL: " + bookmark.url + " のナレッジ同期をスキップしました:", error);
      }
    }
  }

  // 変更があった場合のみ、ローカルのストレージに差分を一括永続化（中継サーバーなし）
  if (isUpdated) {
    await chrome.storage.local.set({ page_knowledge_base: pageKnowledgeBase });
    console.log(">> ローカルのページナレッジベースの同期更新が完了しました。");
  }
}
// ========================================================
// ページ情報から直接「無毒化済みナレッジJSON」を生成するAI関数
// ========================================================
async function fetchAndCleansePageMetaContext(apiKey, url, title) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

  // URLとタイトルから、AIセーフティを刺激しない綺麗な要約とコンテキストを1発で作成させるプロンプト
  const prompt = "# あなたの役割\n" +
  "あなたは入力されたWebページのURLとタイトルから、そのサイトが持つ本来の『テーマ・概要・文脈』を深く洞察し、AIのセーフティポリシー（有害コンテンツ、過激なハッキング、成人向けなど）に絶対に誤判定されないクリーンかつ学術的・一般的なニュートラル表現にクレンジング（無毒化）されたページナレッジコンテキストを生成する専門AIです。\n\n" +
  "# 処理ルール\n" +
  "1. 入力されたタイトルやURL情報から推測される内容を分析し、刺激の強い表現やポリシーに抵触しそうな不適切単語をすべて排除し、一般的なビジネス用語やマイルドなIT用語に変換したオブジェクト構造（subject, summary, description, keyword）を構築してください。\n" +
  "2. 出力されるすべてのテキストノードに、生のセーフティ違反表現が含まれないよう徹底的にサニタイズしてください。解説文は含めず指定スキーマのJSONのみを返してください。";

  const responseSchema = {
    type: "OBJECT",
    properties: {
      subject: { type: "STRING", description: "無毒化された一般的な大テーマ（例: セキュリティ検証技術、オンラインメディア動向）" },
      summary: { type: "STRING", description: "ページの安全な1文要約" },
      description: { type: "STRING", description: "サイトの内容を具体的に捉えたマイルドな説明文（日本語1〜2文）" },
      keyword: { type: "STRING", description: "カンマ区切りの安全な関連キーワード（最大5つ）" }
    },
    required: ["subject", "summary", "description", "keyword"]
  };

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { text: "対象URL: " + url + "\n対象タイトル: " + title }
          ]
        }],
        generationConfig: {
          temperature: 0.1,
          response_mime_type: "application/json",
          response_schema: responseSchema
        }
      })
    });

    if (!response.ok) return null;
    const resData = await response.json();
    const textOutput = resData.candidates[0].content.parts[0].text;
    if (!textOutput) return null;

    return JSON.parse(textOutput);
  } catch (e) {
    console.error("メタナレッジ生成エラー:", e);
    return null;
  }
}
