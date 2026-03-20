(() => {
	const CGO = (globalThis.CGO = globalThis.CGO || {});

	function isProbablyExternalImage(image) {
		const source = String(image?.source || "");
		const url = String(image?.url || "");

		if (source === "content-reference-image-group") return true;

		// chatgpt 内部 estuary / files/download は内部扱い
		if (/\/backend-api\/estuary\/content/i.test(url)) return false;
		if (/\/backend-api\/files\/download\//i.test(url)) return false;

		// chatgpt.com 以外は外部参照扱い
		try {
			const u = new URL(url, location.origin);
			return u.hostname !== "chatgpt.com" && u.hostname !== "chat.openai.com";
		} catch {
			return false;
		}
	}

	function getImageSourceHref(image) {
		const url = String(image?.url || "");
		if (!url) return "";

		try {
			const u = new URL(url, location.origin);

			// chatgpt 内部URLは Source リンク不要
			if (u.hostname === "chatgpt.com" || u.hostname === "chat.openai.com") {
				return "";
			}

			return u.href;
		} catch {
			return "";
		}
	}

	function renderImageSourceLink(image) {
		const href = getImageSourceHref(image);
		if (!href) return "";

		return `<div class="cgo-image-source">
    <a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">
      ${escapeHtml(t("image_source_link_label"))}
    </a>
  </div>`;
	}

	async function runWithConcurrency(items, worker, concurrency = 3) {
		const safeConcurrency = Math.max(1, Math.min(concurrency, items.length || 1));
		let index = 0;

		async function runner() {
			while (true) {
				const currentIndex = index++;
				if (currentIndex >= items.length) break;
				await worker(items[currentIndex], currentIndex);
			}
		}

		await Promise.all(
			Array.from({ length: safeConcurrency }, () => runner())
		);
	}

	function downloadTextFile(filename, text, mimeType = "text/plain;charset=utf-8") {
		const blob = new Blob([text], { type: mimeType });
		const url = URL.createObjectURL(blob);

		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		a.click();

		setTimeout(() => URL.revokeObjectURL(url), 1000);
	}

	function openHtmlInNewTab(html, messageId = "") {
		const blob = new Blob([html], { type: "text/html" });
		const url = URL.createObjectURL(blob);

		const finalUrl = messageId ? `${url}#mes-${encodeURIComponent(messageId)}` : url;
		window.open(finalUrl, "_blank", "noopener,noreferrer");

		setTimeout(() => URL.revokeObjectURL(url), 60000);
	}

	function buildSafeFilename(baseName, ext = "html") {
		const safeBase = (baseName || "chatgpt_conversation")
			.replace(/[\\/:*?"<>|]/g, "_")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 120);

		const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
		return `${safeBase || "chatgpt_conversation"}_${stamp}.${ext}`;
	}

	async function loadExtensionTextFile(path) {
		const runtimeId = chrome?.runtime?.id;
		if (!runtimeId) {
			throw new Error("Extension context is invalidated. Please reload the page.");
		}

		const url = chrome.runtime.getURL(path);
		const res = await fetch(url);
		if (!res.ok) {
			throw new Error(`Failed to load ${path}: ${res.status}`);
		}
		return res.text();
	}

	async function getHighlightAssets() {
		try {
			const [js, css] = await Promise.all([
				loadExtensionTextFile("vendor/highlight.min.js"),
				loadExtensionTextFile("vendor/github-dark.min.css"),
			]);
			return { js, css };
		} catch (error) {
			CGO.log("[warn] highlight assets unavailable", String(error));
			return null;
		}
	}

	async function resolveDownloadUrlFromFileId(fileId, conversationId, authorization = "") {
		if (!fileId || !conversationId) return "";

		const url =
			`https://chatgpt.com/backend-api/files/download/${encodeURIComponent(fileId)}` +
			`?conversation_id=${encodeURIComponent(conversationId)}` +
			`&inline=false`;

		const headers = new Headers();
		if (authorization) {
			headers.set("authorization", authorization);
		}

		const response = await fetch(url, {
			method: "GET",
			credentials: "include",
			headers,
		});

		if (!response.ok) {
			throw new Error(`files/download failed: ${response.status}`);
		}

		const data = await response.json();
		return typeof data?.download_url === "string" ? data.download_url : "";
	}

	function getLastAuthorizationFromPage(timeoutMs = 800) {
		return new Promise((resolve) => {
			let done = false;
			const requestId =
				`cgo_last_auth_${Date.now()}_${Math.random().toString(36).slice(2)}`;

			const timer = setTimeout(() => {
				cleanup();
				resolve("");
			}, timeoutMs);

			function cleanup() {
				if (done) return;
				done = true;
				clearTimeout(timer);
				window.removeEventListener("message", onMessage);
			}

			function onMessage(event) {
				if (event.source !== window) return;
				const data = event.data;
				if (!data || data.type !== "CGO_LAST_AUTHORIZATION_RESPONSE") return;
				if (data.requestId !== requestId) return;

				cleanup();
				resolve(typeof data.authorization === "string" ? data.authorization : "");
			}

			window.addEventListener("message", onMessage);

			window.postMessage(
				{
					type: "CGO_LAST_AUTHORIZATION_REQUEST",
					requestId,
				},
				"*"
			);
		});
	}

	function getFileDownloadCacheEntry(fileId, conversationId, timeoutMs = 800) {
		return new Promise((resolve) => {
			const requestId =
				`cgo_file_cache_${Date.now()}_${Math.random().toString(36).slice(2)}`;

			const timer = setTimeout(() => {
				window.removeEventListener("message", handler);
				resolve(null);
			}, timeoutMs);

			function handler(event) {
				if (event.source !== window) return;

				const data = event.data;
				if (!data || data.type !== "CGO_FILE_DOWNLOAD_CACHE_RESPONSE") return;
				if (data.requestId !== requestId) return;

				clearTimeout(timer);
				window.removeEventListener("message", handler);
				resolve(data.data || null);
			}

			window.addEventListener("message", handler);

			window.postMessage(
				{
					type: "CGO_FILE_DOWNLOAD_CACHE_REQUEST",
					requestId,
					fileId,
					conversationId,
				},
				"*"
			);
		});
	}

	async function imageUrlToDataUrl(url) {
		const response = await fetch(url, {
			credentials: "include",
			cache: "no-store",
		});

		if (!response.ok) {
			throw new Error(`Image fetch failed: ${response.status}`);
		}

		const blob = await response.blob();

		return await new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result);
			reader.onerror = () => reject(new Error("Failed to read blob as data URL."));
			reader.readAsDataURL(blob);
		});
	}

	async function resolveImageUrlsWithDownloadApi(messages, conversationId, authorization = "", onProgress, concurrency = 3) {
		const imagesNeedingResolution = [];

		for (const message of messages || []) {
			for (const image of message.images || []) {
				if (!image?.fileId) continue;
				if (image.embeddedUrl) continue;
				if (typeof image.url === "string" && /[?&]sig=/.test(image.url)) continue;
				imagesNeedingResolution.push(image);
			}
		}

		const total = imagesNeedingResolution.length;
		let done = 0;

		await runWithConcurrency(
			imagesNeedingResolution,
			async (image) => {
				try {
					const cached = await getFileDownloadCacheEntry(image.fileId, conversationId);

					if (cached?.downloadUrl) {
						image.url = cached.downloadUrl;
						image.unresolved = false;
						image.source = `${image.source || "file-id"}+download-cache`;
						image.fileName = image.fileName || cached.fileName || "";
						image.fileSizeBytes = image.fileSizeBytes || cached.fileSizeBytes || 0;
						image.mimeType = image.mimeType || cached.mimeType || "";
					} else {
						const downloadUrl = await resolveDownloadUrlFromFileId(
							image.fileId,
							conversationId,
							authorization
						);

						if (downloadUrl) {
							image.url = downloadUrl;
							image.unresolved = false;
							image.source = `${image.source || "file-id"}+download-api`;
						} else {
							image.unresolved = true;
						}
					}
				} catch (error) {
					CGO.log("[warn] export resolveImageUrlsWithDownloadApi failed", {
						fileId: image.fileId,
						error: String(error),
					});
					image.unresolved = true;
				}

				done += 1;
				if (onProgress) onProgress({ done, total, phase: "resolve" });
			},
			concurrency
		);
	}

	function renderImagesForZip(images) {
		if (!Array.isArray(images) || images.length === 0) return "";

		const internalItems = [];
		const externalItems = [];

		for (const image of images) {
			const html = renderSingleImageFigure(image, { mode: "zip" });

			if (isProbablyExternalImage(image)) {
				externalItems.push(html);
			} else {
				internalItems.push(html);
			}
		}

		return [
			internalItems.length
				? `<div class="cgo-images cgo-images-internal">${internalItems.join("\n")}</div>`
				: "",
			externalItems.length
				? `<div class="cgo-images cgo-images-external">${externalItems.join("\n")}</div>`
				: "",
		].join("\n");
	}


	function renderAttachmentsForZip(attachments) {
		if (!Array.isArray(attachments) || attachments.length === 0) return "";

		const items = attachments.map((attachment) => {
			const icon = getAttachmentIcon(attachment.kind, attachment.isSandboxArtifact);
			const name = CGO.escapeHtml(attachment.name || CGO.t("attachment_unknown_name"));
			const kindLabel = CGO.escapeHtml(
				CGO.t(`attachment_kind_${attachment.kind || "attachment"}`)
			);
			const sizeText = CGO.escapeHtml(CGO.formatBytes(attachment.fileSizeBytes));
			const meta = [kindLabel, sizeText].filter(Boolean).join(" · ");

			const skipLabel = getAttachmentSkipLabel(attachment);
			let actionHtml = `<span>${CGO.escapeHtml(CGO.t("attachment_not_embedded_label"))}</span>`;

			if (skipLabel) {
				actionHtml = `<span class="cgo-attachment-skip">${CGO.escapeHtml(skipLabel)}</span>`;
			} else if (attachment.localPath) {
				actionHtml = `<a href="${CGO.escapeHtml(attachment.localPath)}" target="_blank" rel="noopener noreferrer">
        ${CGO.escapeHtml(CGO.t("attachment_open_local_link"))}
      </a>`;
			} else if (attachment.url) {
				actionHtml = `<a href="${CGO.escapeHtml(attachment.url)}" target="_blank" rel="noopener noreferrer">
        ${CGO.escapeHtml(CGO.t("attachment_open_link"))}
      </a>`;
			}

			return `<div class="cgo-attachment cgo-attachment-${CGO.escapeHtml(attachment.kind || "attachment")}">
      <div class="cgo-attachment-icon" aria-hidden="true">${CGO.escapeHtml(icon)}</div>
      <div class="cgo-attachment-main">
        <div class="cgo-attachment-name">${name}</div>
        ${meta ? `<div class="cgo-attachment-meta">${meta}</div>` : ""}
      </div>
      <div class="cgo-attachment-actions">
        ${actionHtml}
      </div>
    </div>`;
		});

		return `<div class="cgo-attachments">${items.join("\n")}</div>`;
	}

	function renderSingleImageFigure(image, options = {}) {
		const mode = options.mode || "html"; // "html" | "zip"
		const alt = CGO.escapeHtml(image.alt || "");
		const caption = CGO.escapeHtml(image.alt || image.title || "");
		const sourceLink = renderImageSourceLink(image);
		const skipLabel = getImageSkipLabel(image);
		const isExternal = isProbablyExternalImage(image);

		// ZIP内ローカル画像
		if (mode === "zip" && image.localPath) {
			return `<figure class="cgo-image${isExternal ? " cgo-image-external" : ""}">
      <img src="${CGO.escapeHtml(image.localPath)}" alt="${alt}">
      ${caption ? `<figcaption>${caption}</figcaption>` : ""}
      ${renderImageMeta(image)}
      ${sourceLink}
    </figure>`;
		}

		// HTML埋め込み済み画像
		if (mode === "html" && image.embeddedUrl) {
			return `<figure class="cgo-image${isExternal ? " cgo-image-external" : ""}">
      <img src="${image.embeddedUrl}" alt="${alt}">
      ${caption ? `<figcaption>${caption}</figcaption>` : ""}
      ${renderImageMeta(image)}
      ${sourceLink}
    </figure>`;
		}

		// 外部画像は参照用としてそのまま表示
		if (image.url && !image.unresolved && isExternal) {
			return `<figure class="cgo-image cgo-image-external">
      <img src="${CGO.escapeHtml(image.url)}" loading="lazy" referrerpolicy="no-referrer">
      ${renderImageMeta(image)}
      ${sourceLink}
    </figure>`;
		}

		// HTML側で未埋め込みだが内部URLが生きている場合
		if (mode === "html" && image.url && !image.unresolved && !isExternal) {
			return `<figure class="cgo-image">
      <img src="${CGO.escapeHtml(image.url)}" alt="${alt}">
      ${caption ? `<figcaption>${caption}</figcaption>` : ""}
      ${renderImageMeta(image)}
      ${sourceLink}
    </figure>`;
		}

		// fallback
		return `<figure class="cgo-image cgo-image-missing${isExternal ? " cgo-image-external" : ""}">
    <div class="cgo-image-missing-box">${CGO.escapeHtml(CGO.t("image_unavailable_label"))}</div>
    <figcaption>
      ${caption || CGO.escapeHtml(CGO.t("generated_image_present_label"))}
      ${skipLabel ? `<div class="cgo-image-skip">${CGO.escapeHtml(skipLabel)}</div>` : ""}
    </figcaption>
    ${sourceLink}
  </figure>`;
	}

	async function resolveAttachmentUrlsWithDownloadApi(messages, conversationId, authorization = "", onProgress, concurrency = 3) {
		const attachmentsNeedingResolution = [];

		for (const message of messages || []) {
			for (const attachment of message.attachments || []) {
				if (!attachment?.fileId) continue;
				if (attachment.localPath) continue;
				if (attachment.url) continue;
				attachmentsNeedingResolution.push(attachment);
			}
		}

		const total = attachmentsNeedingResolution.length;
		let done = 0;

		await runWithConcurrency(
			attachmentsNeedingResolution,
			async (attachment) => {
				try {
					const cached = await getFileDownloadCacheEntry(attachment.fileId, conversationId);

					if (cached?.downloadUrl) {
						attachment.url = cached.downloadUrl;
						attachment.unresolved = false;
						attachment.name = attachment.name || cached.fileName || "";
						attachment.fileSizeBytes = attachment.fileSizeBytes || cached.fileSizeBytes || 0;
						attachment.kind = CGO.guessAttachmentKind
							? CGO.guessAttachmentKind(attachment.name, attachment.mimeType)
							: attachment.kind;
						attachment.source = `${attachment.source || "file-id"}+download-cache`;
					} else {
						const downloadUrl = await resolveDownloadUrlFromFileId(
							attachment.fileId,
							conversationId,
							authorization
						);

						if (downloadUrl) {
							attachment.url = downloadUrl;
							attachment.unresolved = false;
							attachment.source = `${attachment.source || "file-id"}+download-api`;
						} else {
							attachment.unresolved = true;
						}
					}
				} catch (error) {
					CGO.log("[warn] export resolveAttachmentUrlsWithDownloadApi failed", {
						fileId: attachment.fileId,
						error: String(error),
					});
					attachment.unresolved = true;
				}

				done += 1;
				if (onProgress) onProgress({ done, total, phase: "resolve-attachments" });
			},
			concurrency
		);
	}

	async function embedImagesInMessages(messages, onProgress, concurrency = 3) {
		const allImages = messages.flatMap((m) => m.images || []);
		const total = allImages.length;
		let done = 0;

		await runWithConcurrency(
			allImages,
			async (image) => {
				if (image.unresolved === false && image.url) {
					try {
						image.embeddedUrl = await imageUrlToDataUrl(image.url);
						image.skipReason = "";
					} catch (error) {
						CGO.log("[warn] export image embed failed", {
							url: image.url,
							fileId: image.fileId,
							error: String(error),
						});
						image.embeddedUrl = null;
						image.skipReason = "network";
					}
				} else {
					image.embeddedUrl = null;
					image.skipReason = image.skipReason || "unresolved";
				}

				done += 1;
				if (onProgress) onProgress({ done, total, phase: "embed" });
			},
			concurrency
		);

		return messages;
	}

	function blobToArrayBuffer(blob) {
		return blob.arrayBuffer();
	}

	function guessExtensionFromMimeType(mimeType) {
		const mime = (mimeType || "").toLowerCase();

		if (mime === "image/png") return "png";
		if (mime === "image/jpeg") return "jpg";
		if (mime === "image/webp") return "webp";
		if (mime === "image/gif") return "gif";
		if (mime === "image/svg+xml") return "svg";
		if (mime === "application/pdf") return "pdf";
		if (mime === "text/plain") return "txt";
		if (mime === "application/json") return "json";

		return "bin";
	}

	function sanitizeZipFileName(name) {
		return String(name || "file")
			.replace(/[\\/:*?"<>|]+/g, "_")
			.replace(/\s+/g, " ")
			.trim();
	}

	async function fetchBlobWithAuth(url) {
		const authorization = await getLastAuthorizationFromPage();

		const headers = new Headers();
		if (authorization) {
			headers.set("authorization", authorization);
		}

		const response = await fetch(url, {
			method: "GET",
			credentials: "include",
			headers,
		});

		if (!response.ok) {
			throw new Error(`Blob fetch failed: ${response.status}`);
		}

		return response.blob();
	}

	function getImageSkipLabel(image) {
		const rawSkipReason = image?.skipReason || "";
		const [skipReason] = String(rawSkipReason).split(":");

		switch (skipReason) {
			case "unresolved":
				return t("image_skip_unresolved");
			case "unsupported_media":
				return t("image_skip_unsupported_media");
			case "auth":
				return t("image_skip_auth");
			case "server":
				return t("image_skip_server");
			case "network":
				return t("image_skip_network");
			case "not_found":
				return t("image_skip_not_found");
			default:
				return "";
		}
	}

	function getAttachmentSkipLabel(attachment) {
		const rawSkipReason = attachment?.skipReason || "";
		const [skipReason, skipValue] = String(rawSkipReason).split(":");

		switch (skipReason) {
			case "too_large":
				return t("attachment_skip_too_large", [
					formatBytes(Number(skipValue || 0))
				]);
			case "unresolved":
				return t("attachment_skip_unresolved");
			case "sandbox":
				return t("attachment_skip_sandbox");
			case "unsupported_media":
				return t("attachment_skip_unsupported_media");
			case "auth":
				return t("attachment_skip_auth");
			case "server":
				return t("attachment_skip_server");
			case "network":
				return t("attachment_skip_network");
			case "not_found":
				return t("attachment_skip_not_found");
			default:
				return "";
		}
	}

	async function saveImagesToZip(messages, zip, onProgress, concurrency = 3) {
		const imageFolder = zip.folder("images");
		const allImages = messages.flatMap((m) => m.images || []);
		const zipTargetImages = allImages.filter(
			(image) => !CGO.isProbablyExternalImage || !CGO.isProbablyExternalImage(image)
		);

		const total = zipTargetImages.length;
		let done = 0;
		let counter = 1;

		await runWithConcurrency(
			zipTargetImages,
			async (image) => {
				try {
					if (image.unresolved === false && image.url) {
						const blob = await fetchBlobWithAuth(image.url);
						const ext = guessExtensionFromMimeType(blob.type);
						const fileName = `img_${String(counter++).padStart(4, "0")}.${ext}`;
						const localPath = `images/${fileName}`;

						image.localPath = localPath;
						image.embeddedUrl = null;

						const buffer = await blobToArrayBuffer(blob);
						imageFolder.file(fileName, buffer);
					} else {
						image.localPath = "";
					}
				} catch (error) {
					CGO.log("[warn] zip image save failed", {
						url: image.url,
						fileId: image.fileId,
						error: String(error),
					});
					image.localPath = "";
				}

				done += 1;
				if (onProgress) onProgress({ done, total, phase: "zip-images" });
			},
			concurrency
		);
	}

	function getZipSubfolderForAttachment(attachment) {
		switch (attachment.kind) {
			case "archive":
				return "files/archives";
			case "pdf":
				return "files/documents";
			case "text":
				return "files/text";
			case "code":
				return "files/code";
			default:
				return "files/misc";
		}
	}

	async function saveAttachmentsToZip(messages, zip, onProgress, concurrency = 3, maxBytes = 10 * 1024 * 1024) {
		const allAttachments = messages.flatMap((m) => m.attachments || []);
		const zipTargetAttachments = [];

		for (const attachment of allAttachments) {
			attachment.skipReason = "";

			if (attachment.isSandboxArtifact) {
				attachment.skipReason = "sandbox";
				continue;
			}

			if (!attachment?.url || attachment.unresolved) {
				attachment.skipReason = "unresolved";
				continue;
			}

			if (attachment.fileSizeBytes && attachment.fileSizeBytes > maxBytes) {
				attachment.skipReason = `too_large:${attachment.fileSizeBytes}`;
				continue;
			}

			zipTargetAttachments.push(attachment);
		}

		const total = zipTargetAttachments.length;
		let done = 0;
		let counter = 1;

		await runWithConcurrency(
			zipTargetAttachments,
			async (attachment) => {
				try {
					const blob = await fetchBlobWithAuth(attachment.url);
					const ext = guessExtensionFromMimeType(attachment.mimeType || blob.type);
					const safeBaseName = sanitizeZipFileName(
						attachment.name || `file_${String(counter).padStart(4, "0")}`
					);

					const hasExt = /\.[A-Za-z0-9]+$/.test(safeBaseName);
					const fileName = hasExt ? safeBaseName : `${safeBaseName}.${ext}`;
					const numberedName = `${String(counter++).padStart(4, "0")}_${fileName}`;

					const folderPath = getZipSubfolderForAttachment(attachment);
					const folder = zip.folder(folderPath);
					const localPath = `${folderPath}/${numberedName}`;

					attachment.localPath = localPath;
					attachment.fileSizeBytes = attachment.fileSizeBytes || blob.size || 0;
					attachment.mimeType = attachment.mimeType || blob.type || "";
					attachment.skipReason = "";

					const buffer = await blobToArrayBuffer(blob);
					folder.file(numberedName, buffer);
				} catch (error) {
					CGO.log("[warn] zip attachment save failed", {
						name: attachment.name,
						fileId: attachment.fileId,
						error: String(error),
					});
					attachment.localPath = "";
					attachment.skipReason = "network";
				}

				done += 1;
				if (onProgress) onProgress({ done, total, phase: "zip-attachments" });
			},
			concurrency
		);
	}

	async function exportCurrentConversationAsHtml(button, action = "download", options = {}) {
		try {
			const includeImages =
				options.includeImages ?? (CGO.SETTINGS?.htmlDownloadIncludeImages ?? true);

			const isLightweight = action !== "download";

			const conversationId = CGO.getConversationIdFromLocation();
			if (!conversationId) {
				throw new Error("conversationId not found");
			}

			const conversationData = await CGO.getConversationFromCache();
			if (!conversationData) {
				throw new Error("conversation cache not found");
			}

			const mapping = conversationData?.mapping || {};
			const currentNode = conversationData?.current_node || null;

			if (!currentNode || !mapping[currentNode]) {
				throw new Error("Current conversation node not found.");
			}

			const chain = CGO.buildExportChain(mapping, currentNode);
			const baseMessages = CGO.normalizeMessagesForExport(chain, mapping);
			const domAssets = CGO.buildDomAssetMap();
			const messages = CGO.mergeMessagesWithDomAssets(baseMessages, domAssets);

			const authorization = await getLastAuthorizationFromPage();

			if (includeImages && !isLightweight) {
				await resolveImageUrlsWithDownloadApi(
					messages,
					conversationId,
					authorization,
					({ done, total }) => {
						if (total > 0 && button) {
							button.textContent = CGO.t("export_resolving_progress", [done, total]);
						}
					},
					3
				);

				await embedImagesInMessages(
					messages,
					({ done, total }) => {
						if (total > 0 && button) {
							button.textContent = CGO.t("export_progress", [done, total]);
						}
					},
					3
				);
			} else {
				for (const message of messages) {
					message.images = [];
				}
			}

			const title =
				conversationData?.title ||
				document.title.replace(/\s*-\s*ChatGPT\s*$/i, "") ||
				"ChatGPT Conversation";

			const highlightAssets = !isLightweight
				? await getHighlightAssets()
				: null;

			const html = CGO.buildConversationExportHtml(
				title,
				conversationId,
				messages,
				{
					interactiveCode: !isLightweight,
					includeImages,
					highlightAssets,
				}
			);

			if (action === "download") {
				CGO.downloadTextFile(
					CGO.buildSafeFilename(title, "html"),
					html,
					"text/html;charset=utf-8"
				);
			} else {
				CGO.openHtmlInNewTab(html, action);
			}

			CGO.log("HTML exported", { title, messages: messages.length });
		} catch (error) {
			CGO.log("[error] export html failed", error);
			throw error;
		}
	}

	async function exportCurrentConversationAsZip(button) {
		try {
			const conversationId = CGO.getConversationIdFromLocation();
			if (!conversationId) {
				throw new Error("conversationId not found");
			}

			const conversationData = await CGO.getConversationFromCache();
			if (!conversationData) {
				throw new Error("conversation cache not found");
			}

			const mapping = conversationData?.mapping || {};
			const currentNode = conversationData?.current_node || null;

			if (!currentNode || !mapping[currentNode]) {
				throw new Error("Current conversation node not found.");
			}

			const chain = CGO.buildExportChain(mapping, currentNode);
			const baseMessages = CGO.normalizeMessagesForExport(chain, mapping);
			const domAssets = CGO.buildDomAssetMap();
			const messages = CGO.mergeMessagesWithDomAssets(baseMessages, domAssets);
			const authorization = await getLastAuthorizationFromPage();
			const highlightJsContent = await loadExtensionTextFile("vendor/highlight.min.js");
			const highlightCssContent = await loadExtensionTextFile("vendor/github-dark.min.css");

			await resolveImageUrlsWithDownloadApi(
				messages,
				conversationId,
				authorization,
				({ done, total }) => {
					if (total > 0 && button) {
						button.textContent = CGO.t("export_resolving_progress", [done, total]);
					}
				},
				3
			);

			await resolveAttachmentUrlsWithDownloadApi(
				messages,
				conversationId,
				authorization,
				({ done, total }) => {
					if (total > 0 && button) {
						button.textContent = CGO.t("export_attachments_progress", [done, total]);
					}
				},
				3
			);

			const zip = new JSZip();

			await saveImagesToZip(messages, zip, ({ done, total }) => {
				if (total > 0 && button) {
					button.textContent = CGO.t("zip_images_progress", [done, total]);
				}
			}, 3);

			await saveAttachmentsToZip(
				messages,
				zip,
				({ done, total }) => {
					if (total > 0 && exportButton) {
						setToolbarButtonText(exportButton, CGO.t("export_zip_attachments_progress", [done, total]));
					}
				},
				3,
				10 * 1024 * 1024
			);

			const title =
				conversationData?.title ||
				document.title.replace(/\s*-\s*ChatGPT\s*$/i, "") ||
				"ChatGPT Conversation";

			const html = CGO.buildConversationExportHtml(
				title,
				conversationId,
				messages,
				{
					imageRenderer: renderImagesForZip,
					attachmentRenderer: renderAttachmentsForZip,
					highlightAttach: true
				}
			);

			zip.file("index.html", html);
			zip.file("assets/highlight.min.js", highlightJsContent);
			zip.file("assets/github-dark.min.css", highlightCssContent);

			const zipBlob = await zip.generateAsync({ type: "blob" });

			const fileNameBase = sanitizeZipFileName(conversationData.title || "conversation");
			const downloadName = buildSafeFilename(fileNameBase, "zip");

			const url = URL.createObjectURL(zipBlob);
			const a = document.createElement("a");
			a.href = url;
			a.download = downloadName;
			document.body.appendChild(a);
			a.click();
			a.remove();

			setTimeout(() => URL.revokeObjectURL(url), 5000);
  
		} catch (error) {
			CGO.log("[error] export zip failed", error);
			throw error;
		}
	}

	CGO.openHtmlInNewTab = openHtmlInNewTab;
	CGO.buildSafeFilename = buildSafeFilename;
	CGO.downloadTextFile = downloadTextFile;
	CGO.loadExtensionTextFile = loadExtensionTextFile;
	CGO.getHighlightAssets = getHighlightAssets;
	CGO.exportCurrentConversationAsHtml = exportCurrentConversationAsHtml;
	CGO.exportCurrentConversationAsZip = exportCurrentConversationAsZip;
})();