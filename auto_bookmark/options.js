document.addEventListener('DOMContentLoaded', () => {
	// DOM要素の取得
	const keyInput = document.getElementById('api-key');
	const saveBtn = document.getElementById('save-btn');
	const statusDiv = document.getElementById('status');

	const analyzeBtn = document.getElementById('analyze-btn');
	const spinner = document.getElementById('loading-spinner');
	const syncStatusDiv = document.getElementById('sync-status');
	const categoryCountSpan = document.getElementById('category-count');
	const categoryTableContainer = document.getElementById(
		'category-table-container');

	// 再配置関連のDOM要素
	const relocateBtn = document.getElementById('relocate-btn');
	const relocateSpinner = document.getElementById('relocate-spinner');
	const relocateStatusDiv = document.getElementById('relocate-status');
	const diffSection = document.getElementById('diff-section');
	const diffTableContainer = document.getElementById('diff-table-container');
	const btnViewUnified = document.getElementById('btn-view-unified');
	const btnViewSplit = document.getElementById('btn-view-split');
	const applyRelocateBtn = document.getElementById('apply-relocate-btn');

	// ナレッジベース表示用のDOM要素
	const kbSyncIndicator = document.getElementById('kb-sync-indicator');
	const kbTableContainer = document.getElementById('kb-table-container');

	// グローバルな状態保持
	let currentSimulationData = null;
	let currentViewMode = "unified"; // "unified" | "split"

	initAndSyncKnowledge();

	async function initAndSyncKnowledge() {

		// 1. まずローカルのAPIキーを復元
		const data = await chrome.storage.local.get(['gemini_key',
			'folder_descriptions'
		]);
		if (data.gemini_key) keyInput.value = data.gemini_key;

		// 【上書き初期復元】ロード時に保存されている状態を表示
		chrome.storage.local.get(['gemini_key', 'folder_descriptions'], (data) => {
			if (data.gemini_key) keyInput.value = data.gemini_key;
			// 新しい拡張レイアウトレンダラーをキック
			renderCategoryTableEx();
		});

		// 2. バックグラウンド同期エンジンを実行し、終了を待つ
		kbSyncIndicator.style.display = "block";
		await syncPageKnowledgeBase();

		// 3. 同期完了後にインジケータを隠してナレッジベース表をレンダリング
		kbSyncIndicator.style.display = "none";
		renderKnowledgeBaseTable();
	}

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
	// ① フォルダコンテキスト自動解析・同期ボタンのイベントハンドラ
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
			spinner.textContent = '処理中: ブックマーク階層をフルスキャン中...';
			syncStatusDiv.textContent = '';

			const bookmarkTree = await chrome.bookmarks.getTree();
			const rawExtractedData = [];

			// 引数に初期コンテキスト（空パス、初期フラグ）を渡して再帰スキャンを実行
			traverseAndExtract(bookmarkTree[0].children, rawExtractedData, "", false,
				false);

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
					folder_id: f.folder_id,
					folder_name: f.folder_name,
					hierarchical_categories: f.hierarchical_categories,
					is_quick_access: f.is_quick_access,
					is_untouchable: f.is_untouchable,
					entries: es
				};
			});

			spinner.textContent = '処理中: 高密度Descriptionを生成中...';
			const aiResult = await generateDescriptionsViaGemini(apiKey,
				cleansedExtractedData);

			// 描画および再配置シミュレーション時にも4大コンテキストを使い回せるよう、
			// 生成された説明文（aiResult）だけでなく、解析したメタツリー構造自体（cleansedExtractedData）も同時にストレージに一括記憶させます
			chrome.storage.local.set({
				folder_descriptions: aiResult,
				folder_meta_tree: cleansedExtractedData
			}, () => {
				syncStatusDiv.textContent = '完了: 階層カテゴリパスおよび4大属性の同期が完了しました！';
				syncStatusDiv.style.color = 'green';
				renderCategoryTableEx(); // 下部で定義する新しい2行・セル結合テーブルレンダラーを呼び出し
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
	// 集約された「属性」列とバッジUIを持つカテゴリ一覧描画関数
	// ========================================================
	// ========================================================
	// 【上書き】省スペース・高視認性に最適化したカテゴリ一覧描画関数
	// ========================================================
	async function renderCategoryTableEx() {
		const storage = await chrome.storage.local.get(["folder_descriptions",
			"folder_meta_tree"
		]);
		const descriptions = storage.folder_descriptions || {};
		const metaTree = storage.folder_meta_tree || [];

		categoryCountSpan.textContent = metaTree.length.toString();
		categoryTableContainer.innerHTML = "";

		if (metaTree.length === 0) {
			categoryTableContainer.textContent =
				"同期されたフォルダ構造データはありません。ボタンを押して解析してください。";
			return;
		}

		const table = document.createElement("table");
		table.className = "category-table";

		const thead = document.createElement("thead");
		const trHead = document.createElement("tr");

		// ご指定通りのシンプルな2列ヘッダー構造（カテゴリ / 説明文）
		const thCat = document.createElement("th");
		thCat.style.width = "40%";
		thCat.textContent = "カテゴリ";
		const thDesc = document.createElement("th");
		thDesc.style.width = "60%";
		thDesc.textContent = "説明文";

		trHead.appendChild(thCat);
		trHead.appendChild(thDesc);
		thead.appendChild(trHead);
		table.appendChild(thead);

		const tbody = document.createElement("tbody");

		metaTree.forEach(folder => {
			const descText = descriptions[folder.folder_name] || "説明文未生成";

			// 1行目 (上段): [カテゴリ名 属性ラベル] | [説明文 (rowspan=2)]
			const trTop = document.createElement("tr");
			trTop.className = folder.is_untouchable ? "category-row-untouchable" :
				"category-row-normal";

			const tdFolder = document.createElement("td");
			tdFolder.style.fontWeight = "bold";
			tdFolder.style.display = "flex";
			tdFolder.style.alignItems = "center";
			tdFolder.style.flexWrap = "wrap";
			tdFolder.style.gap = "8px";
			tdFolder.style.borderBottom = "none"; // 下段と一体化させるため内側の境界線を消去
			tdFolder.textContent = folder.folder_name;

			// 【新規】カテゴリ名のすぐ横に属性ラベル（バッジ）を動的に追加
			if (folder.is_quick_access) {
				const qBadge = document.createElement("span");
				qBadge.className = "tag-item";
				qBadge.style.backgroundColor = "#e1f5fe";
				qBadge.style.color = "#0288d1";
				qBadge.style.borderColor = "#b3e5fc";
				qBadge.style.fontWeight = "bold";
				qBadge.style.fontSize = "10px";
				qBadge.style.padding = "1px 4px";
				qBadge.textContent = "Bookmarkバー";
				tdFolder.appendChild(qBadge);
			}

			if (folder.is_untouchable) {
				const uBadge = document.createElement("span");
				uBadge.className = "tag-item";
				uBadge.style.backgroundColor = "#ffebee";
				uBadge.style.color = "#c62828";
				uBadge.style.borderColor = "#ffcdd2";
				uBadge.style.fontWeight = "bold";
				uBadge.style.fontSize = "10px";
				uBadge.style.padding = "1px 4px";
				uBadge.textContent = "保護";
				tdFolder.appendChild(uBadge);
			}

			trTop.appendChild(tdFolder);

			// 説明文セルの構築 (右側を2行分ぶち抜き、上下中央揃え)
			const tdDesc = document.createElement("td");
			tdDesc.setAttribute("rowspan", "2");
			tdDesc.style.verticalAlign = "middle";
			tdDesc.textContent = descText;
			trTop.appendChild(tdDesc);
			tbody.appendChild(trTop);

			// 2行目 (下段): [階層付きカテゴリ名] | (右側は結合済)
			const trBottom = document.createElement("tr");
			trBottom.className = folder.is_untouchable ? "category-row-untouchable" :
				"category-row-normal";

			const tdPath = document.createElement("td");
			tdPath.style.color = "#57606a";
			tdPath.style.fontSize = "12px";
			tdPath.style.borderTop = "none"; // 上段と一体化させるため内側の境界線を消去

			// 【最重要】階層付きカテゴリ名が絶対に折り返さないように制御
			tdPath.style.whiteSpace = "nowrap";
			tdPath.style.overflow = "hidden";
			tdPath.style.textOverflow = "ellipsis"; // 万が一溢れた場合は綺麗に三点リーダー化
			tdPath.textContent = folder.hierarchical_categories;

			trBottom.appendChild(tdPath);
			tbody.appendChild(trBottom);
		});

		table.appendChild(tbody);
		categoryTableContainer.appendChild(table);
	}


	// カテゴリ一覧のDOM構築関数
	function renderCategoryTable(descriptions) {
		const keys = Object.keys(descriptions);
		categoryCountSpan.textContent = keys.length.toString();
		categoryTableContainer.innerHTML = "";

		if (keys.length === 0) {
			categoryTableContainer.textContent = "同期されたフォルダデータはありません。";
			return;
		}

		const table = document.createElement("table");
		table.className = "category-table";

		const thead = document.createElement("thead");
		const trHead = document.createElement("tr");
		const thName = document.createElement("th");
		thName.textContent = "カテゴリ・フォルダ名称";
		const thDesc = document.createElement("th");
		thDesc.textContent = "AI生成コンテキスト説明文 (Description)";
		trHead.appendChild(thName);
		trHead.appendChild(thDesc);
		thead.appendChild(trHead);
		table.appendChild(thead);

		const tbody = document.createElement("tbody");
		keys.forEach(key => {
			const tr = document.createElement("tr");
			const isUntouchable = key.startsWith("[") && key.endsWith("]");
			tr.className = isUntouchable ? "category-row-untouchable" :
				"category-row-normal";

			const tdName = document.createElement("td");
			tdName.textContent = key;
			if (isUntouchable) {
				const lockBadge = document.createElement("span");
				lockBadge.className = "badge";
				lockBadge.style.backgroundColor = "#ff9800";
				lockBadge.style.marginLeft = "8px";
				lockBadge.textContent = "保護対象";
				tdName.appendChild(lockBadge);
			}

			const tdDesc = document.createElement("td");
			tdDesc.textContent = descriptions[key];

			tr.appendChild(tdName);
			tr.appendChild(tdDesc);
			tbody.appendChild(tr);
		});
		table.appendChild(tbody);
		categoryTableContainer.appendChild(table);
	}

	// ========================================================
	// ② 再配置（再カテゴライズ）シミュレーションロジック
	// ========================================================
	relocateBtn.addEventListener('click', async() => {
		const storage = await chrome.storage.local.get(["gemini_key",
			"folder_descriptions", "page_knowledge_base"
		]);
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
			relocateSpinner.textContent = '処理中: ブックマークリストをロード中...';
			relocateStatusDiv.textContent = '';

			const bookmarkTree = await chrome.bookmarks.getTree();
			const existingFolders = [];
			extractAllFolderNames(bookmarkTree, existingFolders);

			const bookmarksToProcess = [];
			flattenBookmarksToProcessBounded(bookmarkTree, bookmarksToProcess);

			if (bookmarksToProcess.length === 0) throw new Error(
				"処理対象のブックマークエントリが存在しません。");

			const categoriesWithDesc = existingFolders.map(name => {
				const isUntouchable = name.startsWith("[") && name.endsWith("]");
				return {
					folder_name: name,
					description: folderDescriptions[name] || "説明なし（未解析または新規フォルダ）",
					is_untouchable: isUntouchable
				};
			});

			relocateSpinner.textContent = '処理中: AIに送るブックマークタイトルを一括無毒化中...';
			const titlesToCleanse = bookmarksToProcess.map(b => ({
				id: b.id,
				title: b.title
			}));

			const cleansedMap = {};
			const chunkSize = 50;
			for (let i = 0; i < titlesToCleanse.length; i += chunkSize) {
				const chunk = titlesToCleanse.slice(i, i + chunkSize);
				relocateSpinner.textContent = "処理中: クレンジング中 (" + (i + chunk.length) +
					"/" + titlesToCleanse.length + " 件)...";
				const chunkResult = await cleanseTitlesBulk(apiKey, chunk);
				Object.assign(cleansedMap, chunkResult);
			}

			const cleansedBookmarks = bookmarksToProcess.map(b => {
				const cache = pageKnowledgeBase[b.url];
				return {
					id: b.id,
					title: cleansedMap[b.id] || b.title,
					url: b.url,
					current_category: b.current_category,
					ai_knowledge_context: cache ? {
						subject: cache.subject,
						summary: cache.summary,
						description: cache.description,
						keyword: cache.keyword
					} : "無し"
				};
			});

			relocateSpinner.textContent = '処理中: 安全なサイズに分割して再配置シミュレーションを実行中...';
			const aggregatedRelocations = [];

			for (let i = 0; i < cleansedBookmarks.length; i += chunkSize) {
				const chunk = cleansedBookmarks.slice(i, i + chunkSize);
				relocateSpinner.textContent = "処理中: AI適合率判定を実行中 (" + (i + chunk.length) +
					"/" + cleansedBookmarks.length + " 件)...";
				const chunkSimulationResult = await runRelocationSimulationViaGemini(
					apiKey, categoriesWithDesc, chunk);
				if (chunkSimulationResult && chunkSimulationResult.relocations) {
					aggregatedRelocations.push(...chunkSimulationResult.relocations);
				}
			}

			currentSimulationData = aggregatedRelocations.map(decision => {
				const original = bookmarksToProcess.find(b => b.id === decision.id);
				return {
					...decision,
					title: original ? original.title : decision.title
				};
			});

			relocateStatusDiv.textContent = '完了: シミュレーション完了。以下の差分を確認して適用してください。';
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
	// アコーディオン操作と階層付き自然順ソートを備えたナレッジベース描画関数
	// ========================================================
	async function renderKnowledgeBaseTable() {
		const storage = await chrome.storage.local.get(["page_knowledge_base"]);
		const pageKnowledgeBase = storage.page_knowledge_base || {};
		kbTableContainer.innerHTML = "";

		const urls = Object.keys(pageKnowledgeBase);
		if (urls.length === 0) {
			kbTableContainer.textContent = "蓄積されたナレッジベースデータはありません。";
			return;
		}

		// 1. ブックマークツリーからオリジナルの最新「生タイトル」を取得するマップ
		const bookmarkTree = await chrome.bookmarks.getTree();
		const bMap = {};

		function buildBookmarkMap(nodes) {
			for (const node of nodes) {
				if (node.url) bMap[node.url] = node.title || "無題のページ";
				if (node.children) buildBookmarkMap(node.children);
			}
		}
		buildBookmarkMap(bookmarkTree);

		// 2. データを「階層付けカテゴリ」単位でグルーピング
		const groupedData = {};
		urls.forEach(url => {
			const cache = pageKnowledgeBase[url];
			const hCat = cache.hierarchical_categories || "未分類";
			if (!groupedData[hCat]) {
				groupedData[hCat] = [];
			}
			groupedData[hCat].push({
				url: url,
				cache: cache
			});
		});

		// 3. グループのキー（階層付けカテゴリ文字列）を自然順序付け昇順（Natural Sort）でソート
		const sortedCategories = Object.keys(groupedData).sort((a, b) => {
			return a.localeCompare(b, undefined, {
				numeric: true,
				sensitivity: 'base'
			});
		});

		// メインのコンテナにテーブル構造を純粋生成
		const table = document.createElement("table");
		table.className = "knowledge-table";

		const thead = document.createElement("thead");
		const trHead = document.createElement("tr");
		const thCol1 = document.createElement("th");
		thCol1.style.width = "40%";
		thCol1.textContent = "ページタイトル・URL / 大テーマ";
		const thCol2 = document.createElement("th");
		thCol2.style.width = "30%";
		thCol2.textContent = "1文要約 / キーワード";
		const thCol3 = document.createElement("th");
		thCol3.style.width = "30%";
		thCol3.textContent = "AI詳細説明文";
		trHead.appendChild(thCol1);
		trHead.appendChild(thCol2);
		trHead.appendChild(thCol3);
		thead.appendChild(trHead);
		table.appendChild(thead);

		const tbody = document.createElement("tbody");

		// ソートされたカテゴリ単位でループ処理
		sortedCategories.forEach(categoryName => {
			const items = groupedData[categoryName];

			// グルーピングの区切りとなるアコーディオンヘッダー行を生成
			const trGroupHeader = document.createElement("tr");
			trGroupHeader.style.backgroundColor = "#e0e0e0";
			trGroupHeader.style.cursor = "pointer";
			trGroupHeader.style.fontWeight = "bold";

			const tdGroupTitle = document.createElement("td");
			tdGroupTitle.setAttribute("colspan", "3");
			tdGroupTitle.style.padding = "10px 12px";

			// 開閉状態を示すマークを配置
			const toggleIndicator = document.createElement("span");
			toggleIndicator.style.marginRight = "8px";
			toggleIndicator.textContent = "▼ "; // デフォルト開
			tdGroupTitle.appendChild(toggleIndicator);

			const txtCategoryName = document.createTextNode(categoryName + " (" +
				items.length + " 件)");
			tdGroupTitle.appendChild(txtCategoryName);
			trGroupHeader.appendChild(tdGroupTitle);
			tbody.appendChild(trGroupHeader);

			// このカテゴリ配下のエントリ行を保持する配列（アコーディオン操作用）
			const itemRows = [];

			items.forEach(item => {
				const url = item.url;
				const cache = item.cache;
				const originalBookmarkTitle = bMap[url] || "未登録のURL";

				// 上段行: Title with Link | Subject | Description (rowspan=2)
				const trTop = document.createElement("tr");
				trTop.className = "row-meta-top";

				const tdTitle = document.createElement("td");
				const anchor = document.createElement("a");
				anchor.href = url;
				anchor.target = "_blank";
				anchor.className = "diff-bookmark-link";
				anchor.textContent = originalBookmarkTitle;
				tdTitle.appendChild(anchor);
				trTop.appendChild(tdTitle);

				const tdSubject = document.createElement("td");
				tdSubject.style.fontWeight = "bold";
				tdSubject.textContent = cache.subject || "未分類"; // 見出しテキストを排除
				trTop.appendChild(tdSubject);

				const tdDesc = document.createElement("td");
				tdDesc.setAttribute("rowspan", "2"); // 2行ぶち抜き
				tdDesc.textContent = cache.description || "無し";
				trTop.appendChild(tdDesc);

				tbody.appendChild(trTop);
				itemRows.push(trTop);

				// 下段行: Summary | Keywords | (Description結合セルのため無し)
				const trBottom = document.createElement("tr");
				trBottom.className = "row-meta-bottom";

				const tdSummary = document.createElement("td");
				tdSummary.textContent = cache.summary || "無し";
				trBottom.appendChild(tdSummary);

				const tdKeywords = document.createElement("td");
				const tagContainer = document.createElement("div");
				tagContainer.className = "tag-container";

				const currentKeywords = cache.keyword ? cache.keyword.split(",").map(
					k => k.trim()).filter(k => k) : [];

				currentKeywords.forEach(keyword => {
					const tag = document.createElement("span");
					tag.className = "tag-item";
					tag.textContent = keyword;

					const delBtn = document.createElement("span");
					delBtn.className = "tag-delete-btn";
					delBtn.textContent = "×";

					delBtn.addEventListener('click', async(e) => {
						e.stopPropagation(); // アコーディオンのクリック伝播を防止
						const updatedKeywords = currentKeywords.filter(k => k !==
							keyword);
						cache.keyword = updatedKeywords.join(", ");
						pageKnowledgeBase[url] = cache;
						await chrome.storage.local.set({
							page_knowledge_base: pageKnowledgeBase
						});
						renderKnowledgeBaseTable();
					});

					tag.appendChild(delBtn);
					tagContainer.appendChild(tag);
				});

				const addBtn = document.createElement("span");
				addBtn.className = "tag-add-btn";
				addBtn.textContent = "+ 追加";
				addBtn.addEventListener('click', async(e) => {
					e.stopPropagation(); // アコーディオンのクリック伝播を防止
					const newTag = prompt("新しいキーワードを入力してください：");
					if (newTag && newTag.trim()) {
						const cleanTag = newTag.trim();
						if (!currentKeywords.includes(cleanTag)) {
							currentKeywords.push(cleanTag);
							cache.keyword = currentKeywords.join(", ");
							pageKnowledgeBase[url] = cache;
							await chrome.storage.local.set({
								page_knowledge_base: pageKnowledgeBase
							});
							renderKnowledgeBaseTable();
						}
					}
				});

				tagContainer.appendChild(addBtn);
				tdKeywords.appendChild(tagContainer);
				trBottom.appendChild(tdKeywords);

				tbody.appendChild(trBottom);
				itemRows.push(trBottom);
			});

			// 👆 アコーディオン開閉クリックイベントのバインド
			let isOpen = true;
			trGroupHeader.addEventListener('click', () => {
				isOpen = !isOpen;
				toggleIndicator.textContent = isOpen ? "▼ " : "▶ ";
				itemRows.forEach(row => {
					row.style.display = isOpen ? "" : "none";
				});
			});
		});

		table.appendChild(tbody);
		kbTableContainer.appendChild(table);
	}


	// ========================================================
	// ④ 差分レンダリングシステム（安全版）
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
	// 確定更新処理・実適用
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
				" 件のブックマーク再配置を実際のブラウザに適用します。よろしいですか？")) return;
		try {
			applyRelocateBtn.disabled = true;
			relocateStatusDiv.textContent = '処理中: 実際のブックマークにフォルダ再配置を適用中...';
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
	function flattenBookmarksToProcessBounded(nodes, result) {
		for (const node of nodes) {
			if (!node.url && node.children) {
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
						if (count >= 30) break;
					}
				}
				node.children.forEach(child => {
					if (!child.url) flattenBookmarksToProcessBounded([child], result);
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
		const endpoint =
			`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;
		const prompt =
			"高度なナレッジマネジメントAIとして、既存フォルダのdescriptionに基づきブックマークを再配置してください。解説文なしの指定スキーマJSONのみを返却してください。";
		const responseSchema = {
			type: "OBJECT",
			properties: {
				relocations: {
					type: "ARRAY",
					items: {
						type: "OBJECT",
						properties: {
							id: {
								type: "STRING"
							},
							title: {
								type: "STRING"
							},
							url: {
								type: "STRING"
							},
							current_category: {
								type: "STRING"
							},
							target_category: {
								type: "STRING"
							},
							confidence_score: {
								type: "INTEGER"
							},
							reason: {
								type: "STRING"
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
						text: "既存フォルダ:\n" + JSON.stringify(categories) + "\n\n処理リスト:\n" +
							JSON.stringify(bookmarks)
					}]
				}],
				generationConfig: {
					temperature: 0.2,
					response_mime_type: "application/json",
					response_schema: responseSchema
				}
			})
		});
		if (!response.ok) throw new Error("API通信失敗");
		const resData = await response.json();
		return JSON.parse(resData.candidates[0].content.parts[0].text);
	}

	// ========================================================
	// 階層パス・QuickAccess・Untouchable属性を再帰解析・抽出する関数
	// ========================================================
	function traverseAndExtract(nodes, resultList, currentPath = "",
		parentQuickAccess = false, parentUntouchable = false) {
		console.log(nodes);
		for (const node of nodes) {
			// フォルダノード（urlを持たない要素）かつ名前があるものを対象とする
			console.log(node.url);
			console.log(node.title);
			if (!node.url && node.title) {
				const folderName = node.title;
				console.log(folderName);

				// 1. ブラケットを除去したクリーンな名前をパス用に取得
				const cleanName = (folderName.startsWith("[") && folderName.endsWith("]")) ?
					folderName.slice(1, -1) : folderName;

				// 2. 階層カテゴリ（HierarchicalCategories）のパスを組み立て
				let newPath = currentPath;
				// ルート直下の固定システムフォルダ名（「ブックマークバー」「その他のブックマーク」など）はパスから除外
				const isSystemRoot = (node.parentId === "0" || node.id === "1" || node.id ===
					"2" || folderName.includes("ブックマーク"));
				console.log("isSystemRoot:" + isSystemRoot);
				if (!isSystemRoot && cleanName) {
					newPath = currentPath ? (currentPath + "." + cleanName) : cleanName;
				}
				console.log(newPath);

				// 3. 属性フラグの判定と親からの継承
				// 「ブックマークバー(通常ID: 1)」の直下、または親がQuickAccessならtrue
				const isQuickAccess = (node.parentId === "1" || parentQuickAccess);
				console.log("isQuickAccess:" + isQuickAccess);

				// 自身がブラケット囲み、または親がUntouchableなら属性を引き継ぐ
				const isCurrentUntouchable = folderName.startsWith("[") && folderName.endsWith(
					"]");
				const isUntouchable = (isCurrentUntouchable || parentUntouchable);
				console.log("isUntouchable:" + isUntouchable);

				// 4. 配下の子ブックマーク（urlがあるもの）のみ最大30件抽出
				const entries = [];
				if (node.children) {
					for (const child of node.children) {
						if (child.url) {
							entries.push({
								title: child.title || "",
								url: child.url
							});
						}
						if (entries.length >= 30) break;
					}
				}

				// ブックマークが1件以上含まれるフォルダ、またはシステムルート以外のユーザー構造を解析対象にする
				if (entries.length > 0 && !isSystemRoot) {
					resultList.push({
						folder_id: node.id,
						folder_name: folderName,
						hierarchical_categories: newPath || folderName,
						is_quick_access: isQuickAccess,
						is_untouchable: isUntouchable,
						entries: entries
					});
				}

				// 下位階層がある場合は、現在の属性状態を引き継がせて再帰走査
				if (node.children) {
					traverseAndExtract(node.children, resultList, newPath, isQuickAccess,
						isUntouchable);
				}
			}
		}
	}


	async function cleanseTitlesBulk(apiKey, titlesList) {
		if (titlesList.length === 0) return {};
		const endpoint =
			`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

		const prompt = "AIセーフティ誤判定を防ぐため、リスト内の過激表現等をマイルドな表現にクレンジングしてください。";
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
			const jsonOutput = JSON.parse(resData.candidates[0].content.parts[0].text);
			const resultMap = {};
			if (jsonOutput.cleansed_items) {
				jsonOutput.cleansed_items.forEach(item => {
					resultMap[item.id] = item.title;
				});
			}
			return resultMap;
		} catch (e) {
			const fallbackMap = {};
			titlesList.forEach(item => {
				fallbackMap[item.id] = item.title;
			});
			return fallbackMap;
		}
	}

	// ========================================================
	// 4大属性（階層・QuickAccess・Untouchable）を含めてDescriptionを生成するAI関数
	// ========================================================
	async function generateDescriptionsViaGemini(apiKey, parsedData) {
		const endpoint =
			`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

		const prompt = "あなたは優秀なデータアナリストです。\n" +
			"提示されたユーザーのブックマーク構造（階層カテゴリパス、配下のエントリ、各種属性）を多角的に分析し、\n" +
			"それぞれのフォルダが『どのような具体的な関心・目的・技術スタック・利用シーン』を網羅しているかを示す高精度なDescription（説明文）を生成してください。\n\n" +
			"【制約事項】\n" +
			"・Descriptionは単なるフォルダ名やパスの言い換えではなく、配下のURLやタイトルの傾向、およびQuickAccessなどの属性から利用目的（例：『日常的に素早くアクセスするフロントエンド開発情報』など）を具体的に捉えた日本語1〜2文にしてください。\n" +
			"・入力されたすべてのfolder_id（またはfolder_name）について、漏れなく1つずつオブジェクトを生成してください。";

		const responseSchema = {
			type: "OBJECT",
			properties: {
				analyzed_folders: {
					type: "ARRAY",
					description: "分析されたフォルダとその説明文のリスト",
					items: {
						type: "OBJECT",
						properties: {
							folder_id: {
								type: "STRING",
								description: "入力データと完全に一致するfolder_id"
							},
							folder_name: {
								type: "STRING",
								description: "フォルダ名"
							},
							description: {
								type: "STRING",
								description: "そのフォルダの具体的な説明文（日本語、1〜2文）"
							}
						},
						required: ["folder_id", "folder_name", "description"]
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
						text: "【解析対象メタデータ】\n" + JSON.stringify(parsedData)
					}]
				}],
				generationConfig: {
					temperature: 0.2,
					response_mime_type: "application/json",
					response_schema: responseSchema
				}
			})
		});

		if (!response.ok) {
			const errText = await response.text();
			throw new Error("API " + response.status + ": " + errText);
		}

		const resData = await response.json();
		const jsonOutput = JSON.parse(resData.candidates[0].content.parts[0].text);

		// 拡張機能のストレージ（background.js側でも一発で引ける構造）へマッピングして返却
		// キーは変わらず「フォルダ名（folder_name）」とすることで既存ロジックとの互換性を完全維持します
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

	// ========================================================
	// ページコンテキスト（ナレッジベース）の非同期同期・ライフサイクル管理関数
	// ========================================================
	async function syncPageKnowledgeBase() {
		console.log("START:syncPageKnowledgeBase()");

		const storage = await chrome.storage.local.get(["gemini_key",
			"page_knowledge_base"
		]);
		const apiKey = storage.gemini_key;
		const pageKnowledgeBase = storage.page_knowledge_base || {};
		if (!apiKey) return;

		const bookmarkTree = await chrome.bookmarks.getTree();

		// 1. 事前に全フォルダの「フォルダID」から「階層付きパス」を割り出すマップを構築
		const folderMetaList = [];
		traverseAndExtract(bookmarkTree[0].children, folderMetaList, "", false,
			false);

		const folderPathMap = {};
		folderMetaList.forEach(f => {
			folderPathMap[f.folder_id] = f.hierarchical_categories;
		});

		// 2. フラットな全ブックマークを走査し、親の階層パスも一緒に引き抜く
		const flatBookmarks = [];

		function collectAll(nodes, currentParentId = "1") {
			for (const node of nodes) {
				if (node.url) {
					// 親フォルダのIDから、先ほど解析した階層パスを取得（無ければ"未分類"）
					const hPath = folderPathMap[node.parentId] || "未分類";
					flatBookmarks.push({
						id: node.id,
						title: node.title,
						url: node.url,
						dateAdded: node.dateAdded,
						hierarchical_categories: hPath
					});
				}
				if (node.children) {
					collectAll(node.children, node.id);
				}
			}
		}
		collectAll(bookmarkTree);

		const now = Date.now();
		const oneMonthMs = 30 * 24 * 60 * 60 * 1000;
		let isUpdated = false;

		for (const b of flatBookmarks) {
			const cache = pageKnowledgeBase[b.url];

			// 条件検証: キャッシュが無い、1ヶ月以上古い、または所属する階層パスが変わったか（NEXT ACTION 1）
			const isCacheMissing = !cache;
			const isCacheExpired = cache && (now - cache.last_updated_at > oneMonthMs);
			const isBookmarkNewer = cache && b.dateAdded && (b.dateAdded > cache.last_updated_at);
			const isPathChanged = cache && (cache.hierarchical_categories !== b.hierarchical_categories);

			if (isCacheMissing || isCacheExpired || isBookmarkNewer || isPathChanged) {
				try {
					const knowledge = await fetchAndCleansePageMetaContext(apiKey, b.url, b.title);
					if (knowledge) {
						// ページコンテキストに階層付けカテゴリを統合保持
						pageKnowledgeBase[b.url] = {
							...knowledge,
							hierarchical_categories: b.hierarchical_categories,
								last_updated_at: now
						};
						isUpdated = true;
						await new Promise(r => setTimeout(r, 500));
					}
				} catch (e) {
					console.warn(e);
				}
			} else if (cache && !cache.hierarchical_categories) {
				// 既存キャッシュに階層パス情報だけが欠落している場合の補完
				pageKnowledgeBase[b.url].hierarchical_categories = b.hierarchical_categories;
				isUpdated = true;
			}
		}

		if (isUpdated) {
			await chrome.storage.local.set({
				page_knowledge_base: pageKnowledgeBase
			});
			console.log(">> ページコンテキストへの階層パス統合同期が完了しました。");
		}
	}

	async function fetchAndCleansePageMetaContext(apiKey, url, title) {
		const endpoint =
			`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;
		const prompt =
			"URLとタイトルから、セーフティ誤判定されないクリーンなテーマ概要文脈オブジェクト(subject, summary, description, keyword)を生成してください。";
		const responseSchema = {
			type: "OBJECT",
			properties: {
				subject: {
					type: "STRING"
				},
				summary: {
					type: "STRING"
				},
				description: {
					type: "STRING"
				},
				keyword: {
					type: "STRING"
				}
			},
			required: ["subject", "summary", "description", "keyword"]
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
							text: "URL: " + url + "\nTitle: " + title
						}]
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
			return JSON.parse(resData.candidates[0].content.parts[0].text);
		} catch (e) {
			return null;
		}
	}
});
