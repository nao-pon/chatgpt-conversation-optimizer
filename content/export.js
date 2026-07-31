(() => {
  if (globalThis.__CGO_SKIP__) return;
  const CGO = (globalThis.__CGO ||= {});

  /**
   * Derive a project name from the browser document title when ChatGPT prefixes the conversation title.
   *
   * @param {string} docTitle - Current document title.
   * @param {string} conversationTitle - Conversation title from data payload.
   * @returns {string} Project name or an empty string.
   */
  function extractProjectNameFromDocumentTitle(
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

  /**
   * Ask the page hook for the latest authorization header observed in network requests.
   *
   * @param {number} [timeoutMs=800] - Maximum wait time for the page response.
   * @returns {Promise<string>} Authorization header value or an empty string.
   */
  function getLastAuthorizationFromPage(timeoutMs = 800) {
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

  /**
   * Fill empty image metadata fields from `/backend-api/files/:fileId/simple`.
   *
   * @param {Object} image - Image metadata to update in place.
   * @param {string} [authorization=""] - Optional authorization header.
   * @returns {Promise<void>}
   */
  async function applyFileSimpleMetadataToImage(image, authorization = "") {
    if (!image?.fileId || !CGO.getFileSimpleMetadata) return;

    try {
      const metadata = await CGO.getFileSimpleMetadata(image.fileId, authorization);
      image.fileName = image.fileName || metadata?.file_name || "";
      image.mimeType = image.mimeType || metadata?.mime_type || "";
    } catch (error) {
      CGO.log("[warn] export image simple metadata fill failed", {
        fileId: image.fileId,
        code: CGO.classifyFetchError(error),
        status: error?.status,
      });
    }
  }

  /**
   * Fill empty attachment metadata fields from `/backend-api/files/:fileId/simple`.
   *
   * @param {Object} attachment - Attachment metadata to update in place.
   * @param {string} [authorization=""] - Optional authorization header.
   * @returns {Promise<void>}
   */
  async function applyFileSimpleMetadataToAttachment(attachment, authorization = "") {
    if (!attachment?.fileId || attachment?.isSandboxArtifact || !CGO.getFileSimpleMetadata) return;

    try {
      const metadata = await CGO.getFileSimpleMetadata(attachment.fileId, authorization);
      attachment.name = attachment.name || metadata?.file_name || "";
      attachment.mimeType = attachment.mimeType || metadata?.mime_type || "";
      attachment.kind = CGO.guessAttachmentKind(attachment.name, attachment.mimeType);
    } catch (error) {
      CGO.log("[warn] export attachment simple metadata fill failed", {
        fileId: attachment.fileId,
        code: CGO.classifyFetchError(error),
        status: error?.status,
      });
    }
  }

  /**
   * Resolve signed download URLs for message images using cache-first lookup and the download API.
   *
   * @param {Object[]} messages - Messages containing images to resolve.
   * @param {string} conversationId - Conversation id.
   * @param {string} [authorization=""] - Optional authorization header.
   * @param {Function} onProgress - Progress callback.
   * @param {number} [concurrency=3] - Maximum concurrent resolutions.
   * @returns {Promise<void>} Resolves when all candidate images are processed.
   */
  async function resolveImageUrlsWithDownloadApi(
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
          const cached = await getFileDownloadCacheEntry(image.fileId, conversationId);

          if (cached?.downloadUrl) {
            image.url = CGO.choosePreferredImageUrl
              ? CGO.choosePreferredImageUrl(image.url, cached.downloadUrl)
              : (image.url || cached.downloadUrl);
            image.unresolved = false;
            image.source = `${image.source || "file-id"}+download-cache`;
            image.fileName = image.fileName || cached.fileName || "";
            image.fileSizeBytes = Number(cached.fileSizeBytes || 0) || image.fileSizeBytes || 0;
            image.mimeType = image.mimeType || cached.mimeType || "";
            await applyFileSimpleMetadataToImage(image, authorization);
          } else if (getCachedDownloadResolveSkipReason(cached)) {
            image.unresolved = true;
            image.skipReason = getCachedDownloadResolveSkipReason(cached);
            image.source = `${image.source || "file-id"}+download-cache`;
          } else {
            // 2) 無ければ API
            const downloadUrl = includeImages ? await CGO.resolveDownloadUrlFromFileId(
              image.fileId,
              conversationId,
              authorization
            ) : "";

            if (downloadUrl) {
              image.url = CGO.choosePreferredImageUrl
                ? CGO.choosePreferredImageUrl(image.url, downloadUrl)
                : (image.url || downloadUrl);
              image.unresolved = false;
              image.source = `${image.source || "file-id"}+download-api`;
              await applyFileSimpleMetadataToImage(image, authorization);
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
          image.skipReason = CGO.classifyFetchError(error);
        }

        done += 1;
        if (onProgress) {
          onProgress({ done, total, phase: "resolve" });
        }
      },
      concurrency
    );
  }

  /**
   * Resolve signed download URLs for file attachments and sandbox artifacts.
   *
   * @param {Object[]} messages - Messages containing attachments to resolve.
   * @param {string} conversationId - Conversation id.
   * @param {string} [authorization=""] - Optional authorization header.
   * @param {Function} onProgress - Progress callback.
   * @param {number} [concurrency=3] - Maximum concurrent resolutions.
   * @returns {Promise<void>} Resolves when all candidate attachments are processed.
   */
  async function resolveAttachmentUrlsWithDownloadApi(
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
          const cached = await getFileDownloadCacheEntry(
            attachment.fileId,
            conversationId,
            attachment.sandboxPath || ""
          );

          if (cached?.downloadUrl) {
            attachment.url = CGO.choosePreferredImageUrl
              ? CGO.choosePreferredImageUrl(attachment.url, cached.downloadUrl)
              : (attachment.url || cached.downloadUrl);
            attachment.unresolved = false;
            attachment.name = attachment.name || cached.fileName || "";
            attachment.mimeType = attachment.mimeType || cached.mimeType || "";
            attachment.fileSizeBytes = Number(cached.fileSizeBytes || 0) || attachment.fileSizeBytes || 0;
            attachment.kind = CGO.guessAttachmentKind(attachment.name, attachment.mimeType);
            attachment.source = `${attachment.source || "file-id"}+download-cache`;
            await applyFileSimpleMetadataToAttachment(attachment, authorization);
          } else if (getCachedDownloadResolveSkipReason(cached)) {
            attachment.unresolved = true;
            attachment.skipReason = getCachedDownloadResolveSkipReason(cached);
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
              attachment.url = CGO.choosePreferredImageUrl
                ? CGO.choosePreferredImageUrl(attachment.url, downloadUrl)
                : (attachment.url || downloadUrl);
              attachment.unresolved = false;
              attachment.source = `${attachment.source || "file-id"}+download-api`;
              await applyFileSimpleMetadataToAttachment(attachment, authorization);
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

  /**
   * Query the page hook for a cached signed download URL for a file asset.
   *
   * @param {string} fileId - ChatGPT file id.
   * @param {string} conversationId - Conversation id used by the cache lookup.
   * @param {string} [sandboxPath=""] - Optional sandbox artifact path used as a fallback cache key.
   * @param {number} [timeoutMs=800] - Time to wait for a cache response.
   * @returns {Promise<?Object>} Cached download metadata or `null`.
   */
  function getFileDownloadCacheEntry(fileId, conversationId, sandboxPath = "", timeoutMs = 800) {
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
          sandboxPath,
          secret: window.__CGO_BRIDGE_SECRET__ || "",
        },
        "*"
      );
    });
  }

  /**
   * Return the skip reason represented by a cached failed download resolution.
   *
   * @param {Object} cached - Cached file-download entry.
   * @returns {string} Export skip reason, or an empty string for usable entries.
   */
  function getCachedDownloadResolveSkipReason(cached) {
    if (!cached || cached.downloadUrl) return "";
    return typeof cached.errorCode === "string" ? cached.errorCode : "";
  }

  /**
   * Build a lookup table from image file ids to the signed URLs already present in the DOM.
   *
   * @param {Object[]} domAssets - DOM asset map entries.
   * @returns {Map<string, string>} File-id to URL index.
   */
  function buildDomImageUrlIndex(domAssets) {
    const map = new Map();

    for (const asset of domAssets || []) {
      if (!asset) continue;

      for (const image of asset.images || []) {
        if (!image?.fileId || !image?.url) continue;

        if (map.has(image.fileId) && CGO.choosePreferredImageUrl) {
          map.set(
            image.fileId,
            CGO.choosePreferredImageUrl(map.get(image.fileId), image.url)
          );
        } else if (!map.has(image.fileId)) {
          map.set(image.fileId, image.url);
        }
      }
    }

    return map;
  }

  /**
   * Build a per-turn asset snapshot from the live DOM to supplement export data.
   *
   * @returns {Object[]} DOM asset descriptors for rendered conversation turns.
   */
  function buildDomAssetMap() {
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

    CGO.log("[export] dom assets collected", {
      turns: items.length,
      imageCount: items.reduce((sum, item) => sum + item.images.length, 0),
      attachmentCount: items.reduce((sum, item) => sum + item.attachments.length, 0),
    });

    return items;
  }

  /**
   * Fetch an image and convert it to a data URL for self-contained HTML exports.
   *
   * @param {string} url - Resolved image URL.
   * @param {Object} [image={}] - Image metadata used to recover generic blob MIME types.
   * @returns {Promise<string>} Data URL representation of the fetched image.
   */
  async function imageUrlToDataUrl(url, image = {}) {
    const blob = await fetchBlobWithAuth(url, "image");
    const mimeType = resolveImageBlobMimeType(image, blob.type);

    if (!mimeType) {
      const error = new Error(
        `Unexpected content-type: ${blob.type || "unknown"}`
      );
      error.code = "unsupported_media";
      error.contentType = blob.type || "";
      throw error;
    }

    const imageBlob = coerceBlobMimeType(blob, mimeType);
    image.mimeType = mimeType;
    image.fileSizeBytes = imageBlob.size || blob.size || image.fileSizeBytes || 0;

    return await new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Failed to read blob as data URL."));

      reader.readAsDataURL(imageBlob);
    });
  }

  // NOTE:
  // Resolve signed image URLs and embed image data with limited concurrency.
  // Full parallelism is intentionally avoided to reduce burst traffic and
  // keep export stable on large conversations.
  /**
   * Embed resolved image URLs as data URLs for standalone HTML exports.
   *
   * @param {Object[]} messages - Messages containing images.
   * @param {Function} onProgress - Progress callback.
   * @param {number} [concurrency=3] - Maximum concurrent embeddings.
   * @returns {Promise<Object[]>} The same message list after embedding.
   */
  async function embedImagesInMessages(messages, onProgress, concurrency = 3) {
    const allImages = messages.flatMap((m) => m.images || []);
    const total = allImages.length;
    const includeImages = CGO.SETTINGS.htmlDownloadIncludeImages !== false;
    let done = 0;

    await CGO.runWithConcurrency(
      allImages,
      async (image) => {
        if (image.unresolved === false && image.url && includeImages) {
          try {
            image.embeddedUrl = await imageUrlToDataUrl(image.url, image);
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

  /**
   * Extract the image-generation prompt from a JSON-only user message when present.
   *
   * @param {Object} message - Raw conversation message payload.
   * @returns {string} Prompt text or an empty string.
   */
  function extractPromptFromJsonParamMessage(message) {
    const content = message?.content || {};
    const candidates = [];

    function add(value) {
      if (typeof value !== "string") return;
      const text = value.trim();
      if (text && !candidates.includes(text)) {
        candidates.push(text);
      }
    }

    add(content.prompt);
    add(content.text);

    if (Array.isArray(content.parts)) {
      const strings = content.parts.filter((v) => typeof v === "string");
      if (strings.length) {
        add(strings.join("\n"));
      }

      for (const part of content.parts) {
        if (!part || typeof part !== "object") continue;
        add(part.prompt);
        add(part.text);
        add(part.content);
        add(part.input?.prompt);
        add(part.args?.prompt);
        add(part.arguments?.prompt);
      }
    } else if (content.parts && typeof content.parts === "object") {
      add(content.parts.prompt);
      add(content.parts.text);
      add(content.parts.content);
    }

    for (const text of candidates) {
      if (!text.startsWith("{") || !text.endsWith("}")) continue;

      try {
        const obj = JSON.parse(text);
        if (typeof obj.prompt === "string") {
          return obj.prompt.trim();
        }
      } catch {
        continue;
      }
    }

    return "";
  }

  /**
   * Extract image metadata from image content references.
   *
   * @param {Object} message - Raw message payload.
   * @returns {Object[]} Normalized referenced image metadata.
   */
  function extractImageAssetsFromContentReferences(message) {
    const refs = Array.isArray(message?.metadata?.content_references)
      ? message.metadata.content_references
      : [];

    const results = [];
    const seen = new Set();

    const normalizeProductSourceUrl = (product) => {
      if (!product || typeof product !== "object") return "";

      const normalizeUsableSourceUrl = (value) => {
        const rawUrl = typeof value === "string" ? value.trim() : "";
        if (!rawUrl) return "";

        try {
          const url = new URL(rawUrl, location.origin);
          if (
            (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com") &&
            url.searchParams.has("hints")
          ) {
            return "";
          }
          return CGO.normalizeMaybeRelativeChatgptUrl(rawUrl);
        } catch {
          return "";
        }
      };

      const directUrl = typeof product.url === "string" ? product.url.trim() : "";
      if (directUrl) return normalizeUsableSourceUrl(directUrl);

      const rawLookupData = product?.product_lookup_key?.data;
      if (typeof rawLookupData !== "string" || !rawLookupData.trim()) return "";

      try {
        const lookupData = JSON.parse(rawLookupData);
        const providerUrl = typeof lookupData?.provider_url === "string"
          ? lookupData.provider_url.trim()
          : "";
        return normalizeUsableSourceUrl(providerUrl);
      } catch {
        return "";
      }
    };

    const buildProductCaption = (product) => {
      if (!product || typeof product !== "object") return "";

      const title = typeof product.title === "string" ? product.title.trim() : "";
      const price = typeof product.price === "string" ? product.price.trim() : "";
      const tag = typeof product.featured_tag === "string" ? product.featured_tag.trim() : "";

      return [title, price, tag].filter(Boolean).join(" · ");
    };

    for (const ref of refs) {
      if (!ref || (ref.type !== "image_group" && ref.type !== "image_v2" && ref.type !== "products")) continue;

      if (ref.type === "products") {
        const products = Array.isArray(ref.products) ? ref.products : [];

        for (const product of products) {
          if (!product || typeof product !== "object") continue;

          const imageUrls = Array.isArray(product.image_urls) ? product.image_urls : [];
          const showcaseImage = product?.showcase_metadata?.image || {};
          const rawUrl =
            showcaseImage.url ||
            imageUrls[0] ||
            "";

          const url = CGO.normalizeMaybeRelativeChatgptUrl(rawUrl);
          if (!url || seen.has(url)) continue;
          seen.add(url);

          const caption = buildProductCaption(product);

          results.push(CGO.normalizeImageMeta({
            url,
            thumbnailUrl: CGO.normalizeMaybeRelativeChatgptUrl(imageUrls[0] || rawUrl),
            sourceUrl: normalizeProductSourceUrl(product),
            alt: caption || product.title || "",
            title: product.title || caption,
            width: Number(showcaseImage.width || 0),
            height: Number(showcaseImage.height || 0),
            source: "content-reference-image-products",
          }));
        }

        continue;
      }

      if (!Array.isArray(ref.images)) continue;

      for (const item of ref.images) {
        const imageResult = item?.image_result || item || {};
        const contentSize = imageResult.content_size || {};
        const thumbnailSize = imageResult.thumbnail_size || {};
        const sourceUrl =
          imageResult.source_url ||
          imageResult.page_url ||
          imageResult.url ||
          "";
        const originalUrl =
          imageResult.original_content_url ||
          imageResult.original_url ||
          "";
        const thumbnailUrl =
          imageResult.thumbnail_url ||
          "";
        const rawUrl =
          imageResult.content_url ||
          (ref.type === "image_group" ? imageResult.url : "") ||
          thumbnailUrl ||
          originalUrl ||
          "";

        const url = CGO.normalizeMaybeRelativeChatgptUrl(rawUrl);
        if (!url || seen.has(url)) continue;
        seen.add(url);

        const title = imageResult.title || "";
        const alt =
          imageResult.alt ||
          title ||
          (ref.type === "image_group" ? ref.alt || "" : "");

        results.push(CGO.normalizeImageMeta({
          url,
          thumbnailUrl: CGO.normalizeMaybeRelativeChatgptUrl(thumbnailUrl),
          originalUrl: CGO.normalizeMaybeRelativeChatgptUrl(originalUrl),
          sourceUrl: CGO.normalizeMaybeRelativeChatgptUrl(sourceUrl),
          alt,
          hint: ref.type === "image_group" ? ref.prompt_text || "" : "",
          title,
          fileName: imageResult.file_name || ref.file_name || "",
          mimeType: imageResult.mime_type || ref.mime_type || "",
          fileSizeBytes: Number(imageResult.file_size_bytes || ref.file_size_bytes || 0),
          width: Number(imageResult.width || contentSize.width || thumbnailSize.width || 0),
          height: Number(imageResult.height || contentSize.height || thumbnailSize.height || 0),
          source: ref.type === "image_v2"
            ? "content-reference-image-v2"
            : "content-reference-image-group",
        }));
      }
    }

    return results;
  }

  /**
   * Determine whether an image should be treated as an external reference.
   *
   * @param {Object} image - Normalized image metadata.
   * @returns {boolean} `true` when the image source is external to ChatGPT.
   */
  function isProbablyExternalImage(image) {
    const source = String(image?.source || "");
    const url = String(image?.url || "");

    if (source === "content-reference-image-group") return true;
    if (source === "content-reference-image-v2") return true;

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

  /**
   * Return the original external image URL that should be exposed as a source link.
   *
   * @param {Object} image - Normalized image metadata.
   * @returns {string} External source URL or an empty string for internal assets.
   */
  function getImageSourceHref(image) {
    const candidates = [
      image?.sourceUrl ||
      "",
      image?.originalUrl || "",
      image?.url || "",
    ];

    for (const candidate of candidates) {
      const url = String(candidate || "");
      if (!url) continue;

      try {
        const u = new URL(url, location.origin);

        // chatgpt 内部URLやOpenAI画像キャッシュは Source リンクにしない
        if (
          u.hostname === "chatgpt.com" ||
          u.hostname === "chat.openai.com" ||
          u.hostname === "images.openai.com" ||
          (
            (u.hostname === "chatgpt.com" || u.hostname === "chat.openai.com") &&
            u.searchParams.has("hints")
          )
        ) {
          continue;
        }

        return u.href;
      } catch {
        continue;
      }
    }

    return "";
  }

  /**
   * Determine whether an external reference image should be archived locally.
   *
   * @param {Object} image - Normalized image metadata.
   * @returns {boolean} `true` when the image has a direct reference-image URL.
   */
  function shouldArchiveExternalReferenceImage(image) {
    const source = String(image?.source || "");
    const url = String(image?.url || "");

    return (
      source === "content-reference-image-v2" &&
      !!url &&
      image?.unresolved !== true
    );
  }

  /**
   * Render the optional external-source link block for an image.
   *
   * @param {Object} image - Normalized image metadata.
   * @returns {string} HTML fragment or an empty string.
   */
  function renderImageSourceLink(image) {
    const href = getImageSourceHref(image);
    if (!href) return "";

    return `<div class="cgo-image-source">
      <a href="${CGO.escapeHtml(href)}" target="_blank" rel="noopener noreferrer">
        ${CGO.escapeHtml(CGO.t("image_source_link_label"))}
      </a>
    </div>`;
  }

  /**
   * Collect ids from tool messages associated with an export message.
   *
   * @param {Object} message - Normalized export message.
   * @returns {string[]} Tool message ids.
   */
  function getToolMessageIds(message) {
    if (!Array.isArray(message?.toolMessages)) return [];
    return message.toolMessages
      .map((msg) => msg?.id)
      .filter((id) => typeof id === "string" && id);
  }

  /**
   * Check whether a message has related tool outputs that contain generated images.
   *
   * @param {Object} message - Normalized export message.
   * @returns {boolean} `true` when tool messages expose image assets.
   */
  function hasToolGeneratedImages(message) {
    if (!Array.isArray(message?.toolMessages)) return false;
    return message.toolMessages.some(
      (toolMsg) => CGO.extractImageAssetsFromToolMessage(toolMsg).length > 0
    );
  }

  /**
   * Decide whether a message should be treated as an image-generation candidate.
   *
   * @param {Object} message - Normalized export message.
   * @returns {boolean} `true` when the message likely represents image output or prompts.
   */
  function isImageCandidateMessage(message) {
    return (
      hasToolGeneratedImages(message) ||
      CGO.extractImageAssetsFromContentReferences(message?.rawMessage || {}).length > 0 ||
      !!extractPromptFromJsonParamMessage(message?.rawMessage || {})
    );
  }

  /**
   * Extract prompt-like hint text for generated-image messages.
   *
   * @param {Object} message - Normalized export message.
   * @returns {Array<{text: string, source: string}>} Prompt descriptors.
   */
  function extractPromptHintsFromMessage(message) {
    const prompts = [];

    const jsonPrompt = extractPromptFromJsonParamMessage(message?.rawMessage || {});
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

  /**
   * Partition assistant DOM image assets into keyed and anonymous pools.
   *
   * @param {Object[]} domAssets - DOM asset entries.
   * @returns {{byMessageId: Map<string, Object>, anonymous: Object[]}} Assistant image pools.
   */
  function buildAssistantDomImagePools(domAssets) {
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

  /**
   * Convert a blob into an ArrayBuffer for ZIP packaging.
   *
   * @param {Blob} blob - Blob to convert.
   * @returns {Promise<ArrayBuffer>} Blob contents as an array buffer.
   */
  function blobToArrayBuffer(blob) {
    return blob.arrayBuffer();
  }

  /**
   * Guess a file extension from a MIME type for exported ZIP entries.
   *
   * @param {string} mimeType - MIME type to inspect.
   * @returns {string} Best-effort file extension without a leading dot.
   */
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

  /**
   * Guess an image MIME type from a filename or URL.
   *
   * @param {string} name - Filename, label, or URL.
   * @returns {string} Image MIME type or an empty string.
   */
  function guessImageMimeTypeFromName(name) {
    const value = String(name || "").toLowerCase();

    if (/\.png(?:[?#].*)?$/.test(value)) return "image/png";
    if (/\.jpe?g(?:[?#].*)?$/.test(value)) return "image/jpeg";
    if (/\.webp(?:[?#].*)?$/.test(value)) return "image/webp";
    if (/\.gif(?:[?#].*)?$/.test(value)) return "image/gif";
    if (/\.bmp(?:[?#].*)?$/.test(value)) return "image/bmp";
    if (/\.svg(?:[?#].*)?$/.test(value)) return "image/svg+xml";

    return "";
  }

  /**
   * Resolve the MIME type to use for an exported image blob.
   *
   * ChatGPT may return uploaded images as `application/octet-stream` with a
   * filename in Content-Disposition. The conversation metadata is the more
   * reliable signal for whether the fetched blob is an image.
   *
   * @param {Object} image - Normalized image metadata.
   * @param {string} [blobType=""] - MIME type reported by fetch.
   * @returns {string} Image MIME type or an empty string.
   */
  function resolveImageBlobMimeType(image, blobType = "") {
    const fetchedType = String(blobType || "").toLowerCase();
    if (/^image\//i.test(fetchedType)) return fetchedType;

    const metadataType = String(image?.mimeType || "").toLowerCase();
    if (/^image\//i.test(metadataType)) return metadataType;

    const candidates = [
      image?.fileName,
      image?.name,
      image?.title,
      image?.alt,
      image?.url,
      image?.originalUrl,
      image?.thumbnailUrl,
    ];

    for (const candidate of candidates) {
      const guessed = guessImageMimeTypeFromName(candidate);
      if (guessed) return guessed;
    }

    return "";
  }

  /**
   * Return a blob with a corrected image MIME type when the server used a generic type.
   *
   * @param {Blob} blob - Fetched blob.
   * @param {string} mimeType - MIME type to assign.
   * @returns {Blob} Original or MIME-corrected blob.
   */
  function coerceBlobMimeType(blob, mimeType) {
    if (!blob || !mimeType) return blob;
    if (String(blob.type || "").toLowerCase() === String(mimeType).toLowerCase()) {
      return blob;
    }

    return new Blob([blob], { type: mimeType });
  }

  /**
   * Choose an image file extension from metadata before falling back to MIME.
   *
   * @param {Object} image - Normalized image metadata.
   * @param {string} mimeType - Image MIME type.
   * @returns {string} File extension without a leading dot.
   */
  function guessImageExtension(image, mimeType) {
    const candidates = [image?.fileName, image?.name, image?.title, image?.alt];

    for (const candidate of candidates) {
      const match = String(candidate || "").match(/\.([A-Za-z0-9]+)$/);
      if (match && /^(png|jpe?g|webp|gif|bmp|svg)$/i.test(match[1])) {
        return match[1].toLowerCase().replace(/^jpeg$/, "jpg");
      }
    }

    return guessExtensionFromMimeType(mimeType);
  }

  /**
   * Sanitize a filename so it is safe to store inside the generated ZIP archive.
   *
   * @param {string} name - Candidate filename.
   * @returns {string} Filesystem-safe filename.
   */
  function sanitizeZipFileName(name) {
    return String(name || "file")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Fetch a blob while conditionally forwarding ChatGPT authorization headers for trusted origins.
   *
   * @param {string} url - Resource URL.
   * @param {string} [type=""] - Resource category used to choose the Accept header.
   * @param {number} [timeoutMs=30000] - Request timeout in milliseconds.
   * @returns {Promise<Blob>} Fetched blob.
   */
  async function fetchBlobWithAuth(url, type = "", timeoutMs = 30000) {
    const authorization = await CGO.getLastAuthorizationFromPage();

    const headers = new Headers();

    // ChatGPT file endpoints may accept cookie auth even when we cannot observe
    // an Authorization header, so include credentials for first-party assets.
    let credentials = "omit";
    try {
      const parsedUrl = new URL(url, location.origin);
      const hostname = parsedUrl.hostname.toLowerCase();
      const pathname = parsedUrl.pathname;
      const isChatGptOrigin = (
        hostname === "chatgpt.com" ||
        hostname === "chat.openai.com" ||
        hostname.endsWith(".chatgpt.com")
      );
      const isChatGptAssetEndpoint = (
        isChatGptOrigin &&
        (
          pathname.includes("/backend-api/estuary/content") ||
          pathname.includes("/backend-api/files/") ||
          pathname.includes("/backend-api/conversation/")
        )
      );
      const isTrustedOrigin = (
        isChatGptOrigin ||
        hostname.endsWith(".openai.com")
      );

      if (isChatGptAssetEndpoint) {
        credentials = "include";
      }

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

  /**
   * Download exportable images and store them under the ZIP image folder structure.
   *
   * @param {Object[]} messages - Messages containing normalized image metadata.
   * @param {JSZip} zip - ZIP archive being assembled.
   * @param {Function} onProgress - Progress callback.
   * @param {number} [concurrency=3] - Maximum concurrent downloads.
   * @param {string} [projectFolderName=""] - Optional root folder inside the ZIP.
   */
  async function saveImagesToZip(
    messages,
    zip,
    onProgress,
    concurrency = 3,
    projectFolderName = ""
  ) {
    const imageFolder = zip.folder(projectFolderName ? `${projectFolderName}/images` : "images");
    const allImages = messages.flatMap((m) => m.images || []);
    const zipTargetImages = allImages.filter(
      (image) => !CGO.isProbablyExternalImage(image) || shouldArchiveExternalReferenceImage(image)
    );

    const total = zipTargetImages.length;
    let done = 0;
    let counter = 1;

    await CGO.runWithConcurrency(
      zipTargetImages,
      async (image) => {
        try {
          if (image.unresolved === false && image.url) {
            const blob = await fetchBlobWithAuth(image.url, "image");
            const mimeType = resolveImageBlobMimeType(image, blob.type);
            if (!mimeType) {
              image.localPath = "";
              image.skipReason = "unsupported_media";
              return;
            }
            const imageBlob = coerceBlobMimeType(blob, mimeType);
            const ext = guessImageExtension(image, mimeType);
            const fileName = `img_${String(counter++).padStart(4, "0")}.${ext}`;
            const localPath = `images/${fileName}`;

            image.localPath = localPath;
            image.embeddedUrl = null;
            image.mimeType = mimeType;
            image.fileSizeBytes = imageBlob.size || blob.size || image.fileSizeBytes || 0;
            image.skipReason = "";

            const buffer = await blobToArrayBuffer(imageBlob);
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

  /**
   * Choose the ZIP subfolder that should contain a given attachment type.
   *
   * @param {Object} attachment - Attachment metadata.
   * @returns {string} Relative folder path inside the archive.
   */
  function getZipSubfolderForAttachment(attachment) {
    switch (attachment.kind) {
      case "archive":
        return "files/archives";
      case "pdf":
        return "files/documents";
      case "spreadsheet":
        return "files/spreadsheets";
      case "text":
        return "files/text";
      case "code":
        return "files/code";
      default:
        return "files/misc";
    }
  }

  /**
   * Convert an image skip reason into a localized user-facing label.
   *
   * @param {Object} image - Image metadata with an optional `skipReason`.
   * @returns {string} Localized explanation or an empty string.
   */
  function getImageSkipLabel(image) {
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

  /**
   * Convert an attachment skip reason into a localized user-facing label.
   *
   * @param {Object} attachment - Attachment metadata with an optional `skipReason`.
   * @returns {string} Localized explanation or an empty string.
   */
  function getAttachmentSkipLabel(attachment) {
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

  /**
   * Download eligible attachments and store them in categorized ZIP folders.
   *
   * @param {Object[]} messages - Messages containing normalized attachments.
   * @param {JSZip} zip - ZIP archive being assembled.
   * @param {Function} onProgress - Progress callback.
   * @param {number} [concurrency=3] - Maximum concurrent downloads.
   * @param {number} [maxBytes=10 * 1024 * 1024] - Per-attachment size limit.
   * @param {string} [projectFolderName=""] - Optional root folder inside the ZIP.
   */
  async function saveAttachmentsToZip(
    messages,
    zip,
    onProgress,
    concurrency = 3,
    maxBytes = 10 * 1024 * 1024,
    projectFolderName = ""
  ) {
    const allAttachments = messages.flatMap((m) => m.attachments || []);
    const candidates = allAttachments.filter((attachment) => attachment?.kind !== "image");
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
          const blob = await fetchBlobWithAuth(attachment.url, "attachment");
          const ext = guessExtensionFromMimeType(attachment.mimeType || blob.type);
          const safeBaseName = sanitizeZipFileName(
            attachment.name || `file_${String(counter).padStart(4, "0")}`
          );

          const hasExt = /\.[A-Za-z0-9]+$/.test(safeBaseName);
          const fileName = hasExt ? safeBaseName : `${safeBaseName}.${ext}`;
          const numberedName = `${String(counter++).padStart(4, "0")}_${fileName}`;

          const folderPath = getZipSubfolderForAttachment(attachment);
          const folder = zip.folder(projectFolderName ? `${projectFolderName}/${folderPath}` : folderPath);
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

  /**
   * Render image galleries for ZIP exports, separating embedded and external images.
   *
   * @param {Object[]} images - Images to render.
   * @returns {string} HTML fragment.
   */
  function renderImagesForZip(images) {
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


  /**
   * Render attachment cards for ZIP exports, preferring local archive paths when available.
   *
   * @param {Object[]} attachments - Attachments to render.
   * @returns {string} HTML fragment.
   */
  function renderAttachmentsForZip(attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) return "";
    const nonImageAttachments = attachments.filter((attachment) => attachment?.kind !== "image");
    if (nonImageAttachments.length === 0) return "";

    const items = nonImageAttachments.map((attachment) => {
      const icon = CGO.getAttachmentIcon(attachment.kind, (attachment.isSandboxArtifact && !attachment.url));
      const name = CGO.escapeHtml(attachment.name || CGO.t("attachment_unknown_name"));
      const kindLabel = CGO.escapeHtml(
        CGO.t(`attachment_kind_${attachment.kind || "attachment"}`)
      );
      const sizeText = Number(attachment.fileSizeBytes || 0) > 0
        ? CGO.escapeHtml(CGO.formatBytes(attachment.fileSizeBytes))
        : "";
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

  /**
   * Render attachment cards for HTML exports.
   *
   * @param {Object[]} attachments - Attachments to render.
   * @returns {string} HTML fragment.
   */
  function renderAttachments(attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) return "";
    const nonImageAttachments = attachments.filter((attachment) => attachment?.kind !== "image");
    if (nonImageAttachments.length === 0) return "";

    const items = nonImageAttachments.map((attachment) => {
      const icon = CGO.getAttachmentIcon(attachment.kind, attachment.isSandboxArtifact);
      const name = CGO.escapeHtml(attachment.name || CGO.t("attachment_unknown_name"));
      const kindLabel = CGO.escapeHtml(
        CGO.t(`attachment_kind_${attachment.kind || "attachment"}`)
      );
      const sizeText = Number(attachment.fileSizeBytes || 0) > 0
        ? CGO.escapeHtml(CGO.formatBytes(attachment.fileSizeBytes))
        : "";
      const meta = [kindLabel, sizeText].filter(Boolean).join(" · ");

      let actionHtml = "";

      const skipLabel = getAttachmentSkipLabel(attachment);

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

  /**
   * Export the current conversation as a ZIP archive with HTML, images, and attachments.
   *
   * @param {HTMLButtonElement} exportButton - Toolbar button used to display progress text.
   * @returns {Promise<void>} Resolves after the ZIP download is triggered.
   */
  async function exportCurrentConversationAsZip(exportButton) {
    if (typeof JSZip === "undefined") {
      throw new Error("JSZip is not loaded");
    }

    const conversationId = CGO.getConversationIdFromLocation();
    if (!conversationId) {
      throw new Error("conversationId not found");
    }

    const conversationData = await CGO.getConversationForExport?.(conversationId) ||
      await CGO.getConversationFromCache(conversationId);
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

    const htmlFileBase = sanitizeZipFileName(conversationTitle || "ChatGPT Conversation");
    const projectFolderName = projectName
      ? sanitizeZipFileName(projectName) + "/" + htmlFileBase
      : "";

    const htmlEntryPath = projectFolderName
      ? `${projectFolderName}/index.html`
      : `${htmlFileBase}.html`;

    const assetBasePath = projectFolderName
      ? `${projectFolderName}/assets`
      : "assets";

    const includeImages = CGO.SETTINGS.htmlDownloadIncludeImages !== false;

    await saveImagesToZip(
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

    await saveAttachmentsToZip(
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
        imageRenderer: renderImagesForZip,
        attachmentRenderer: renderAttachmentsForZip,
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

    const fileNameBase = sanitizeZipFileName(title);
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

  CGO.buildAssistantDomImagePools = buildAssistantDomImagePools;
  CGO.buildDomAssetMap = buildDomAssetMap;
  CGO.buildDomImageUrlIndex = buildDomImageUrlIndex;
  CGO.embedImagesInMessages = embedImagesInMessages;
  CGO.exportCurrentConversationAsZip = exportCurrentConversationAsZip;
  CGO.extractImageAssetsFromContentReferences = extractImageAssetsFromContentReferences;
  CGO.extractProjectNameFromDocumentTitle = extractProjectNameFromDocumentTitle;
  CGO.extractPromptHintsFromMessage = extractPromptHintsFromMessage;
  CGO.getImageSkipLabel = getImageSkipLabel;
  CGO.getLastAuthorizationFromPage = getLastAuthorizationFromPage;
  CGO.getToolMessageIds = getToolMessageIds;
  CGO.isImageCandidateMessage = isImageCandidateMessage;
  CGO.isProbablyExternalImage = isProbablyExternalImage;
  CGO.renderAttachments = renderAttachments;
  CGO.renderImageSourceLink = renderImageSourceLink;
  CGO.resolveAttachmentUrlsWithDownloadApi = resolveAttachmentUrlsWithDownloadApi;
  CGO.resolveImageUrlsWithDownloadApi = resolveImageUrlsWithDownloadApi;
})();
