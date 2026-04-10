(() => {
  if (globalThis.__CGO_SKIP__) return;
  const CGO = (globalThis.__CGO ||= {});

  CGO.extractProjectNameFromDocumentTitle = function extractProjectNameFromDocumentTitle(
    docTitle,
    conversationTitle
  ) {
    const rawDocTitle = String(docTitle || "").replace(/\s*-\s*ChatGPT\s*$/i, "").trim();
    const rawConversationTitle = String(conversationTitle || "").trim();

    if (!rawDocTitle || !rawConversationTitle) return "";
    if (rawDocTitle === rawConversationTitle) return "";

    if (rawDocTitle.endsWith(rawConversationTitle)) {
      const prefix = rawDocTitle.slice(0, -rawConversationTitle.length).trim();
      return prefix.replace(/[\/｜|>\-]\s*$/, "").trim();
    }

    return "";
  }

  CGO.getLastAuthorizationFromPage = function getLastAuthorizationFromPage(timeoutMs = 800) {
    return new Promise((resolve) => {
      let done = false;
      const requestId =
        `cgo_last_auth_${Date.now()}_${Math.random().toString(36).slice(2)}`;

      const timer = setTimeout(() => {
        cleanup();
        resolve("");
      }, timeoutMs);

      /**
       * Abort the pending request and clean up associated resources.
       *
       * Ensures idempotent cleanup by clearing the timeout and removing the window message listener only once.
       */
      function cleanup() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
      }

      /**
       * Process window message events for CGO_LAST_AUTHORIZATION_RESPONSE; when a message with the expected requestId is received, perform cleanup and resolve the pending authorization with the provided string or an empty string.
       * @param {MessageEvent} event - The window message event to inspect; ignored unless it originates from window, has `type === "CGO_LAST_AUTHORIZATION_RESPONSE"`, and matches the expected requestId.
       */
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
          secret: window.__CGO_BRIDGE_SECRET__ || "",
        },
        "*"
      );
    });
  }

  // NOTE:
  // Prefer cached /backend-api/files/download responses first.
  // ChatGPT often resolves signed estuary URLs before or during DOM rendering.
  // Export should reuse those results when possible, and only request missing ones.
  // Missing items are resolved sequentially with a small delay to avoid burst traffic.
  // 
  // Resolve signed image URLs and embed image data with limited concurrency.
  // Full parallelism is intentionally avoided to reduce burst traffic and
  // keep export stable on large conversations.
  CGO.resolveImageUrlsWithDownloadApi = async function resolveImageUrlsWithDownloadApi(
    messages,
    conversationId,
    authorization = "",
    onProgress,
    concurrency = 3
  ) {
    const imagesNeedingResolution = [];
    const includeImages = CGO.SETTINGS.htmlDownloadIncludeImages !== false;

    for (const message of messages || []) {
      for (const image of message.images || []) {
        if (!image?.fileId) continue;
        if (image.embeddedUrl) continue;

        if (!includeImages) {
          image.url = "";
          image.unresolved = false;
          image.skipReason = "setting";
        } else {
          // すでに署名付きURLなら不要
          if (typeof image.url === "string" && /[?&]sig=/.test(image.url)) continue;

          imagesNeedingResolution.push(image);
        }
      }
    }

    const total = imagesNeedingResolution.length;
    let done = 0;

    await CGO.runWithConcurrency(
      imagesNeedingResolution,
      async (image) => {
        try {
          // 1) まず cache
          const cached = await CGO.getFileDownloadCacheEntry(image.fileId, conversationId);

          if (cached?.downloadUrl) {
            image.url = cached.downloadUrl;
            image.unresolved = false;
            image.source = `${image.source || "file-id"}+download-cache`;
            image.fileName = image.fileName || cached.fileName || "";
            image.fileSizeBytes = image.fileSizeBytes || cached.fileSizeBytes || 0;
            image.mimeType = image.mimeType || cached.mimeType || "";
          } else {
            // 2) 無ければ API
            const downloadUrl = includeImages ? await CGO.resolveDownloadUrlFromFileId(
              image.fileId,
              conversationId,
              authorization
            ) : "";

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
        if (onProgress) {
          onProgress({ done, total, phase: "resolve" });
        }
      },
      concurrency
    );
  }

  CGO.resolveAttachmentUrlsWithDownloadApi = async function resolveAttachmentUrlsWithDownloadApi(
    messages,
    conversationId,
    authorization = "",
    onProgress,
    concurrency = 3
  ) {
    const attachmentsNeedingResolution = [];

    for (const message of messages || []) {
      for (const attachment of message.attachments || []) {
        if (attachment?.isSandboxArtifact && attachment?.sandboxPath) {
          attachment.messageId = message.id;
        } else {
          if (!attachment?.fileId) continue;
          if (attachment.localPath) continue;
          if (attachment.url) continue;
        }

        attachmentsNeedingResolution.push(attachment);
      }
    }

    const total = attachmentsNeedingResolution.length;
    let done = 0;

    await CGO.runWithConcurrency(
      attachmentsNeedingResolution,
      async (attachment) => {
        try {
          const cached = await CGO.getFileDownloadCacheEntry(attachment.fileId, conversationId);

          if (cached?.downloadUrl) {
            attachment.url = cached.downloadUrl;
            attachment.unresolved = false;
            attachment.name = attachment.name || cached.fileName || "";
            attachment.fileSizeBytes = attachment.fileSizeBytes || cached.fileSizeBytes || 0;
            attachment.kind = CGO.guessAttachmentKind(attachment.name, attachment.mimeType);
            attachment.source = `${attachment.source || "file-id"}+download-cache`;
          } else {
            let downloadUrl = "";
            if (attachment.isSandboxArtifact && attachment.sandboxPath) {
              downloadUrl = await CGO.resolveSandboxDownloadUrl(
                conversationId,
                attachment.messageId,
                attachment.sandboxPath,
                authorization
              );
            } else {
              downloadUrl = await CGO.resolveDownloadUrlFromFileId(
                attachment.fileId,
                conversationId,
                authorization
              );
            }

            if (downloadUrl) {
              attachment.url = downloadUrl;
              attachment.unresolved = false;
              attachment.source = `${attachment.source || "file-id"}+download-api`;
            } else {
              attachment.unresolved = true;
            }
          }
        } catch (error) {
          CGO.log("[warn] export CGO.resolveAttachmentUrlsWithDownloadApi failed", {
            fileId: attachment.fileId,
            code: CGO.classifyFetchError(error),
            status: error?.status,
            detail: error?.detail,
            error: String(error),
          });
          attachment.unresolved = true;
          attachment.skipReason = CGO.classifyFetchError(error);
        }

        done += 1;
        if (onProgress) {
          onProgress({ done, total, phase: "resolve-attachments" });
        }
      },
      concurrency
    );
  }

  CGO.getFileDownloadCacheEntry = function getFileDownloadCacheEntry(fileId, conversationId, timeoutMs = 800) {
    return new Promise((resolve) => {
      const requestId =
        `cgo_file_cache_${Date.now()}_${Math.random().toString(36).slice(2)}`;

      const timer = setTimeout(() => {
        window.removeEventListener("message", handler);
        resolve(null);
      }, timeoutMs);

      /**
       * Handle window "message" events for a specific CGO file download cache request and finalize the associated promise when a matching response arrives.
       * @param {MessageEvent} event - The message event to inspect; ignored unless it originates from the same window, has type `"CGO_FILE_DOWNLOAD_CACHE_RESPONSE"`, and matches the current `requestId`. On match, clears the timeout, removes this listener, and resolves with `data.data` or `null`.
       */
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
          secret: window.__CGO_BRIDGE_SECRET__ || "",
        },
        "*"
      );
    });
  }

  CGO.buildDomImageUrlIndex = function buildDomImageUrlIndex(domAssets) {
    const map = new Map();

    for (const asset of domAssets || []) {
      if (!asset) continue;

      for (const image of asset.images || []) {
        if (!image?.fileId || !image?.url) continue;

        if (!map.has(image.fileId)) {
          map.set(image.fileId, image.url);
        }
      }
    }

    return map;
  }

  CGO.buildDomAssetMap = function buildDomAssetMap() {
    const turns = CGO.getTurnArticlesForExport();
    const items = [];

    for (const turn of turns) {
      const role = CGO.getTurnRoleFromDom(turn);
      if (role !== "user" && role !== "assistant") continue;

      const messageId = CGO.extractMessageIdFromTurn(turn);
      const images = CGO.extractImagesFromTurn(turn);
      const attachments = CGO.extractAttachmentsFromTurn(turn);

      items.push({
        role,
        messageId,
        images,
        attachments,
      });
    }

    CGO.log("export dom asset map", items.map((item) => ({
      role: item.role,
      messageId: item.messageId,
      imageCount: item.images.length,
      attachmentCount: item.attachments.length,
    })));

    return items;
  }

  CGO.imageUrlToDataUrl = async function imageUrlToDataUrl(url) {
    const blob = await CGO.fetchBlobWithAuth(url, "image");

    if (!blob.type || !blob.type.startsWith("image/")) {
      const error = new Error(
        `Unexpected content-type: ${blob.type || "unknown"}`
      );
      error.code = "unsupported_media";
      error.contentType = blob.type || "";
      throw error;
    }

    return await new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Failed to read blob as data URL."));

      reader.readAsDataURL(blob);
    });
  }

  // NOTE:
  // Resolve signed image URLs and embed image data with limited concurrency.
  // Full parallelism is intentionally avoided to reduce burst traffic and
  // keep export stable on large conversations.
  CGO.embedImagesInMessages = async function embedImagesInMessages(messages, onProgress, concurrency = 3) {
    const allImages = messages.flatMap((m) => m.images || []);
    const total = allImages.length;
    const includeImages = CGO.SETTINGS.htmlDownloadIncludeImages !== false;
    let done = 0;

    await CGO.runWithConcurrency(
      allImages,
      async (image) => {
        if (image.unresolved === false && image.url && includeImages) {
          try {
            image.embeddedUrl = await CGO.imageUrlToDataUrl(image.url);
            image.skipReason = "";
          } catch (error) {
            CGO.log("[warn] export image embed failed", {
              url: image.url,
              fileId: image.fileId,
              code: CGO.classifyFetchError(error),
              status: error?.status,
              contentType: error?.contentType,
              error: String(error),
            });
            image.embeddedUrl = null;
            image.skipReason = CGO.classifyFetchError(error);
          }
        } else {
          image.embeddedUrl = null;
          image.skipReason = image.skipReason || "unresolved";
        }

        done += 1;
        if (onProgress) {
          onProgress({ done, total, phase: "embed" });
        }
      },
      concurrency
    );

    return messages;
  }

  CGO.extractPromptFromJsonParamMessage = function extractPromptFromJsonParamMessage(message) {
    const text = Array.isArray(message?.content?.parts)
      ? message.content.parts.filter((v) => typeof v === "string").join("\n").trim()
      : "";

    if (!text) return "";

    try {
      const obj = JSON.parse(text);
      return typeof obj.prompt === "string" ? obj.prompt.trim() : "";
    } catch {
      return "";
    }
  }

  CGO.extractImageAssetsFromContentReferences = function extractImageAssetsFromContentReferences(message) {
    const refs = Array.isArray(message?.metadata?.content_references)
      ? message.metadata.content_references
      : [];

    const results = [];
    const seen = new Set();

    for (const ref of refs) {
      if (!ref || ref.type !== "image_group") continue;
      if (!Array.isArray(ref.images)) continue;

      for (const item of ref.images) {
        const imageResult = item?.image_result || {};
        const rawUrl =
          imageResult.content_url ||
          imageResult.url ||
          imageResult.source_url ||
          "";

        const url = CGO.normalizeMaybeRelativeChatgptUrl(rawUrl);
        if (!url || seen.has(url)) continue;
        seen.add(url);

        results.push(CGO.normalizeImageMeta({
          url,
          alt: ref.alt || imageResult.alt || "",
          hint: ref.prompt_text || "",
          title: imageResult.title || "",
          fileName: imageResult.file_name || ref.file_name || "",
          mimeType: imageResult.mime_type || ref.mime_type || "",
          fileSizeBytes: Number(imageResult.file_size_bytes || ref.file_size_bytes || 0),
          width: Number(imageResult.width || 0),
          height: Number(imageResult.height || 0),
          source: "content-reference-image-group",
        }));
      }
    }

    return results;
  }

  CGO.isProbablyExternalImage = function isProbablyExternalImage(image) {
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

  CGO.getImageSourceHref = function getImageSourceHref(image) {
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

  CGO.renderImageSourceLink = function renderImageSourceLink(image) {
    const href = CGO.getImageSourceHref(image);
    if (!href) return "";

    return `<div class="cgo-image-source">
      <a href="${CGO.escapeHtml(href)}" target="_blank" rel="noopener noreferrer">
        ${CGO.escapeHtml(CGO.t("image_source_link_label"))}
      </a>
    </div>`;
  }

  CGO.getToolMessageIds = function getToolMessageIds(message) {
    if (!Array.isArray(message?.toolMessages)) return [];
    return message.toolMessages
      .map((msg) => msg?.id)
      .filter((id) => typeof id === "string" && id);
  }

  CGO.hasToolGeneratedImages = function hasToolGeneratedImages(message) {
    if (!Array.isArray(message?.toolMessages)) return false;
    return message.toolMessages.some(
      (toolMsg) => CGO.extractImageAssetsFromToolMessage(toolMsg).length > 0
    );
  }

  CGO.isImageCandidateMessage = function isImageCandidateMessage(message) {
    return (
      CGO.hasToolGeneratedImages(message) ||
      CGO.extractImageAssetsFromContentReferences(message?.rawMessage || {}).length > 0 ||
      !!CGO.extractPromptFromJsonParamMessage(message?.rawMessage || {})
    );
  }

  CGO.extractPromptHintsFromMessage = function extractPromptHintsFromMessage(message) {
    const prompts = [];

    const jsonPrompt = CGO.extractPromptFromJsonParamMessage(message?.rawMessage || {});
    if (jsonPrompt) {
      prompts.push({
        text: jsonPrompt,
        source: "json-prompt",
      });
    }

    const hints = CGO.extractImageHintsFromMessage(message?.rawMessage || null);
    for (const hint of hints) {
      if (!prompts.some((item) => item.text === hint)) {
        prompts.push({
          text: hint,
          source: "data-hint",
        });
      }
    }

    return prompts;
  }

  CGO.buildAssistantDomImagePools = function buildAssistantDomImagePools(domAssets) {
    const byMessageId = new Map();
    const anonymous = [];

    for (const asset of domAssets || []) {
      if (!asset || asset.role !== "assistant") continue;
      if (!CGO.isNonEmptyArray(asset.images)) continue;

      if (asset.messageId) {
        byMessageId.set(asset.messageId, asset);
      } else {
        anonymous.push(asset);
      }
    }

    return { byMessageId, anonymous };
  }

  CGO.blobToArrayBuffer = function blobToArrayBuffer(blob) {
    return blob.arrayBuffer();
  }

  CGO.guessExtensionFromMimeType = function guessExtensionFromMimeType(mimeType) {
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

  CGO.sanitizeZipFileName = function sanitizeZipFileName(name) {
    return String(name || "file")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ")
      .trim();
  }

  CGO.fetchBlobWithAuth = async function fetchBlobWithAuth(url, type = "", timeoutMs = 30000) {
    const authorization = await CGO.getLastAuthorizationFromPage();

    const headers = new Headers();

    // Only add auth for trusted OpenAI/ChatGPT origins
    let credentials = "omit";
    try {
      const parsedUrl = new URL(url, location.origin);
      const hostname = parsedUrl.hostname.toLowerCase();
      const isTrustedOrigin = (
        hostname === "chatgpt.com" ||
        hostname === "chat.openai.com" ||
        hostname.endsWith(".chatgpt.com") ||
        hostname.endsWith(".openai.com")
      );

      if (isTrustedOrigin && authorization) {
        headers.set("authorization", authorization);
        credentials = "include";
      }
    } catch {
      // Invalid URL; proceed without auth
    }

    if (type == "image") {
      headers.set("accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8");
    } else if (type === "attachment") {
      headers.set("accept", "application/octet-stream,application/*,text/plain,text/*,*/*;q=0.8");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "GET",
        credentials,
        headers,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        throw CGO.createHttpError(response, "Blob fetch");
      }

      return response.blob();
    } catch (error) {
      clearTimeout(timer);

      if (error.name === "AbortError") {
        const timeoutError = new Error("Fetch timeout");
        timeoutError.code = "aborted";
        throw timeoutError;
      }

      throw error;
    }
  }

  CGO.saveImagesToZip = async function saveImagesToZip(
    messages,
    zip,
    onProgress,
    concurrency = 3,
    projectFolderName = ""
  ) {
    const imageFolder = zip.folder(projectFolderName ? `${projectFolderName}/images` : "images");
    const allImages = messages.flatMap((m) => m.images || []);
    const zipTargetImages = allImages.filter(
      (image) => !CGO.isProbablyExternalImage(image)
    );

    const total = zipTargetImages.length;
    let done = 0;
    let counter = 1;

    await CGO.runWithConcurrency(
      zipTargetImages,
      async (image) => {
        try {
          if (image.unresolved === false && image.url) {
            const blob = await CGO.fetchBlobWithAuth(image.url, "image");
            if (!/^image\//i.test(blob.type || "")) {
              image.localPath = "";
              image.skipReason = "unsupported_media";
              return;
            }
            const ext = CGO.guessExtensionFromMimeType(blob.type);
            const fileName = `img_${String(counter++).padStart(4, "0")}.${ext}`;
            const localPath = `images/${fileName}`;

            image.localPath = localPath;
            image.embeddedUrl = null;
            image.skipReason = "";

            const buffer = await CGO.blobToArrayBuffer(blob);
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
        if (onProgress) {
          onProgress({ done, total, phase: "zip-images" });
        }
      },
      concurrency
    );
  }

  CGO.getZipSubfolderForAttachment = function getZipSubfolderForAttachment(attachment) {
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

  CGO.getImageSkipLabel = function getImageSkipLabel(image) {
    const rawSkipReason = image?.skipReason || "";
    const [skipReason] = String(rawSkipReason).split(":");

    switch (skipReason) {
      case "unresolved":
        return CGO.t("image_skip_unresolved");
      case "unsupported_media":
        return CGO.t("image_skip_unsupported_media");
      case "auth":
        return CGO.t("image_skip_auth");
      case "server":
        return CGO.t("image_skip_server");
      case "network":
        return CGO.t("image_skip_network");
      case "not_found":
        return CGO.t("image_skip_not_found");
      case "setting":
        return CGO.t("image_skip_setting");
      default:
        return "";
    }
  }

  CGO.getAttachmentSkipLabel = function getAttachmentSkipLabel(attachment) {
    const rawSkipReason = attachment?.skipReason || "";
    const [skipReason, skipValue] = String(rawSkipReason).split(":");

    switch (skipReason) {
      case "too_large":
        return CGO.t("attachment_skip_too_large", [
          CGO.formatBytes(Number(skipValue || 0))
        ]);
      case "unresolved":
        return CGO.t("attachment_skip_unresolved");
      case "sandbox":
        return CGO.t("attachment_skip_sandbox");
      case "unsupported_media":
        return CGO.t("attachment_skip_unsupported_media");
      case "auth":
        return CGO.t("attachment_skip_auth");
      case "server":
        return CGO.t("attachment_skip_server");
      case "network":
        return CGO.t("attachment_skip_network");
      case "not_found":
        return CGO.t("attachment_skip_not_found");
      case "expired":
        return CGO.t("attachment_skip_expired");
      default:
        return "";
    }
  }

  CGO.saveAttachmentsToZip = async function saveAttachmentsToZip(
    messages,
    zip,
    onProgress,
    concurrency = 3,
    maxBytes = 10 * 1024 * 1024,
    projectFolderName = ""
  ) {
    const allAttachments = messages.flatMap((m) => m.attachments || []);
    const candidates = allAttachments;
    const zipTargetAttachments = [];

    for (const attachment of candidates) {
      if (!attachment?.skipReason || String(attachment.skipReason).startsWith("too_large:")) {
        attachment.skipReason = "";
      }

      if (!attachment?.url) {
        if (!attachment.skipReason) {
          attachment.skipReason = attachment.isSandboxArtifact ? "sandbox" : "unresolved";
        }
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

    await CGO.runWithConcurrency(
      zipTargetAttachments,
      async (attachment) => {
        try {
          const blob = await CGO.fetchBlobWithAuth(attachment.url, "attachment");
          const ext = CGO.guessExtensionFromMimeType(attachment.mimeType || blob.type);
          const safeBaseName = sanitizeZipFileName(
            attachment.name || `file_${String(counter).padStart(4, "0")}`
          );

          const hasExt = /\.[A-Za-z0-9]+$/.test(safeBaseName);
          const fileName = hasExt ? safeBaseName : `${safeBaseName}.${ext}`;
          const numberedName = `${String(counter++).padStart(4, "0")}_${fileName}`;

          const folderPath = CGO.getZipSubfolderForAttachment(attachment);
          const folder = zip.folder(projectFolderName ? `${projectFolderName}/${folderPath}` : folderPath);
          const localPath = `${folderPath}/${numberedName}`;

          attachment.localPath = localPath;
          attachment.fileSizeBytes = attachment.fileSizeBytes || blob.size || 0;
          attachment.mimeType = attachment.mimeType || blob.type || "";
          attachment.skipReason = "";

          const buffer = await CGO.blobToArrayBuffer(blob);
          folder.file(numberedName, buffer);
        } catch (error) {
          CGO.log("[warn] zip attachment save failed", {
            name: attachment.name,
            fileId: attachment.fileId,
            code: CGO.classifyFetchError(error),
            status: error?.status,
            contentType: error?.contentType,
            error: String(error),
          });
          attachment.localPath = "";
          attachment.skipReason = CGO.classifyFetchError(error);
        }

        done += 1;
        if (onProgress) {
          onProgress({ done, total, phase: "zip-attachments" });
        }
      },
      concurrency
    );
  }

  CGO.renderImagesForZip = function renderImagesForZip(images) {
    if (!Array.isArray(images) || images.length === 0) return "";

    const internalItems = [];
    const externalItems = [];

    for (const image of images) {
      const html = CGO.renderSingleImageFigure(image, { mode: "zip" });

      if (CGO.isProbablyExternalImage(image)) {
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


  CGO.renderAttachmentsForZip = function renderAttachmentsForZip(attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) return "";

    const items = attachments.map((attachment) => {
      const icon = CGO.getAttachmentIcon(attachment.kind, (attachment.isSandboxArtifact && !attachment.url));
      const name = CGO.escapeHtml(attachment.name || CGO.t("attachment_unknown_name"));
      const kindLabel = CGO.escapeHtml(
        CGO.t(`attachment_kind_${attachment.kind || "attachment"}`)
      );
      const sizeText = CGO.escapeHtml(CGO.formatBytes(attachment.fileSizeBytes));
      const meta = [kindLabel, sizeText].filter(Boolean).join(" · ");

      const skipLabel = CGO.getAttachmentSkipLabel(attachment);
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

  CGO.renderAttachments = function renderAttachments(attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) return "";

    const items = attachments.map((attachment) => {
      const icon = CGO.getAttachmentIcon(attachment.kind, attachment.isSandboxArtifact);
      const name = CGO.escapeHtml(attachment.name || CGO.t("attachment_unknown_name"));
      const kindLabel = CGO.escapeHtml(
        CGO.t(`attachment_kind_${attachment.kind || "attachment"}`)
      );
      const sizeText = CGO.escapeHtml(CGO.formatBytes(attachment.fileSizeBytes));
      const meta = [kindLabel, sizeText].filter(Boolean).join(" · ");

      let actionHtml = "";

      const skipLabel = CGO.getAttachmentSkipLabel(attachment);

      if (skipLabel) {
        actionHtml = `<span class="cgo-attachment-skip">${CGO.escapeHtml(skipLabel)}</span>`;
      } else if (attachment.isSandboxArtifact) {
        actionHtml = `<span>${CGO.escapeHtml(CGO.t("attachment_sandbox_artifact_label"))}</span>`;
      } else if (attachment.url) {
        actionHtml = `<a href="${CGO.escapeHtml(attachment.url)}" target="_blank" rel="noopener noreferrer">
      ${CGO.escapeHtml(CGO.t("attachment_open_link"))}
    </a>`;
      } else {
        actionHtml = `<span>${CGO.escapeHtml(CGO.t("attachment_not_embedded_label"))}</span>`;
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

  CGO.exportCurrentConversationAsZip = async function exportCurrentConversationAsZip(exportButton) {
    if (typeof JSZip === "undefined") {
      throw new Error("JSZip is not loaded");
    }

    const conversationId = CGO.getConversationIdFromLocation();
    if (!conversationId) {
      throw new Error("conversationId not found");
    }

    const conversationData = await CGO.getConversationFromCache();
    if (!conversationData) {
      throw new Error("conversation cache not found");
    }

    const mapping = conversationData.mapping || {};
    const currentNode = conversationData.current_node || null;

    const chain = CGO.buildExportChain(mapping, currentNode);
    const baseMessages = CGO.normalizeMessagesForExport(chain, mapping);
    const domAssets = CGO.buildDomAssetMap();
    const messages = CGO.mergeMessagesWithDomAssets(baseMessages, domAssets);
    const authorization = await CGO.getLastAuthorizationFromPage();
    const highlightJsContent = await CGO.loadExtensionTextFile("vendor/highlight.min.js");
    const highlightCssContent = await CGO.loadExtensionTextFile("vendor/github-dark.min.css");
    const sharedExportAssets = await CGO.getSharedExportAssets();

    await CGO.resolveImageUrlsWithDownloadApi(
      messages,
      conversationId,
      authorization,
      ({ done, total }) => {
        if (total > 0 && exportButton) {
          CGO.setToolbarButtonText(exportButton, CGO.t("export_resolving_progress", [done, total]));
        }
      },
      3
    );

    await CGO.resolveAttachmentUrlsWithDownloadApi(
      messages,
      conversationId,
      authorization,
      ({ done, total }) => {
        if (total > 0 && exportButton) {
          CGO.setToolbarButtonText(exportButton, CGO.t("export_resolving_attachments_progress", [done, total]));
        }
      },
      3
    );

    const zip = new JSZip();

    /*      const title =
            conversationData?.title ||
            document.title.replace(/\s*-\s*ChatGPT\s*$/i, "") ||
            "ChatGPT Conversation";*/
    const conversationTitle = (conversationData?.title || "").trim() || "ChatGPT Conversation";

    const fallbackProjectName = CGO.extractProjectNameFromDocumentTitle(
      document.title, conversationTitle
    );

    const projectName = (conversationData?.project_name || "").trim() || fallbackProjectName;

    const title = projectName
      ? `${projectName} / ${conversationTitle}`
      : conversationTitle;

    const htmlFileBase = CGO.sanitizeZipFileName(conversationTitle || "ChatGPT Conversation");
    const projectFolderName = projectName
      ? CGO.sanitizeZipFileName(projectName) + "/" + htmlFileBase
      : "";

    const htmlEntryPath = projectFolderName
      ? `${projectFolderName}/index.html`
      : `${htmlFileBase}.html`;

    const assetBasePath = projectFolderName
      ? `${projectFolderName}/assets`
      : "assets";

    const includeImages = CGO.SETTINGS.htmlDownloadIncludeImages !== false;

    await CGO.saveImagesToZip(
      messages,
      zip,
      ({ done, total }) => {
        if (total > 0 && exportButton) {
          CGO.setToolbarButtonText(exportButton, CGO.t("export_zip_progress", [done, total]));
        }
      },
      3,
      projectFolderName
    );

    await CGO.saveAttachmentsToZip(
      messages,
      zip,
      ({ done, total }) => {
        if (total > 0 && exportButton) {
          CGO.setToolbarButtonText(exportButton, CGO.t("export_zip_attachments_progress", [done, total]));
        }
      },
      3,
      10 * 1024 * 1024,
      projectFolderName
    );

    for (const message of messages) {
      CGO.prepareInlineImageData(message);
    }

    const html = CGO.buildConversationExportHtml(
      title,
      conversationId,
      messages,
      {
        zipMode: true,
        imageRenderer: CGO.renderImagesForZip,
        attachmentRenderer: CGO.renderAttachmentsForZip,
        interactiveCode: true,
        highlightAttach: true,
        includeImages,
        projectName,
        conversationTitle,
        highlightAssets: {
          js: highlightJsContent,
          css: highlightCssContent,
        },
        sharedCss: sharedExportAssets.css,
        sharedUiJs: sharedExportAssets.uiJs,

      }
    );

    zip.file(htmlEntryPath, html);
    zip.file(`${assetBasePath}/highlight.min.js`, highlightJsContent);
    zip.file(`${assetBasePath}/github-dark.min.css`, highlightCssContent);

    const zipBlob = await zip.generateAsync({ type: "blob" });

    const fileNameBase = CGO.sanitizeZipFileName(title);
    const downloadName = CGO.buildSafeFilename(fileNameBase, "zip");

    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadName;
    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
})();