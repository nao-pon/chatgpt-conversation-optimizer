(() => {
  if (globalThis.__CGO_SKIP__) return;
  const CGO = (globalThis.__CGO ||= {});
  /**
   * Request the current conversation payload from the page hook's in-memory cache.
   *
   * @param {string} [conversationId=CGO.getConversationIdFromLocation()] - Conversation id to request from the page cache.
   * @returns {Promise<Object>} Cached conversation data used for export.
   */
  function getConversationFromCache(conversationId = CGO.getConversationIdFromLocation()) {
    return new Promise((resolve, reject) => {
      const requestId = "cgo_export_" + Date.now();

      const timer = setTimeout(() => {
        window.removeEventListener("message", handler);
        reject(new Error("Export cache response timeout"));
      }, 5000);

      /**
       * Handle window "message" events for CGO export cache responses and settle the export promise.
       *
       * Filters incoming messages to those from the same window with `data.type === "CGO_EXPORT_CACHE_RESPONSE"` and a matching `requestId`, then clears the associated timeout, removes the message listener, and either resolves with `data.data` or rejects with `data.error`.
       *
       * @param {MessageEvent} event - The window message event; expected to carry an object `data` with `type`, `requestId`, and either `data` (response payload) or `error`.
       */
      function handler(event) {
        if (event.source !== window) return;

        const data = event.data;
        if (!data || data.type !== "CGO_EXPORT_CACHE_RESPONSE") return;
        if (data.requestId !== requestId) return;

        clearTimeout(timer);
        window.removeEventListener("message", handler);

        if (data.error) {
          reject(new Error(data.error));
        } else {
          resolve(data.data);
        }
      }

      window.addEventListener("message", handler);

      window.postMessage(
        {
          type: "CGO_EXPORT_CACHE_REQUEST",
          requestId,
          conversationId,
          secret: window.__CGO_BRIDGE_SECRET__ || "",
        },
        "*"
      );
    });
  }

  /**
   * Extract the current conversation id from the active ChatGPT URL.
   *
   * @returns {?string} Conversation id or `null` when the page is not a conversation route.
   */
  function getConversationIdFromLocation() {
    const path = location.pathname;

    // 通常会話 /c/<id> だが、WEB:... のような ":" 含みも許可
    let m = path.match(/\/c\/([^/?#]+)/i);
    if (m) return m[1];

    // プロジェクト内チャット
    m = path.match(/\/g\/[^/]+\/c\/([a-z0-9-]+)/i);
    if (m) return m[1];

    return null;
  }

  /**
   * Walk backward from the current node and build the ordered message chain for export.
   *
   * @param {Object} mapping - Conversation node map keyed by node id.
   * @param {?string} currentNode - Current leaf node id.
   * @returns {Object[]} Ordered message chain from oldest to newest.
   */
  function buildExportChain(mapping, currentNode) {
    const chain = [];
    const seen = new Set();
    let cursor = currentNode;

    while (cursor && mapping[cursor] && !seen.has(cursor)) {
      seen.add(cursor);
      const node = mapping[cursor];

      if (node?.message) {
        chain.push(node.message);
      }

      cursor = node?.parent || null;
    }

    return chain.reverse();
  }

  /**
   * Decide whether a raw message should be included in export output.
   *
   * @param {Object} message - Raw conversation message.
   * @returns {boolean} `true` when the message has exportable content.
   */
  function isExportableMessage(message) {
    const role = message?.author?.role;

    if (role !== "user" && role !== "assistant") {
      return false;
    }

    if (message?.content?.content_type === "thoughts") {
      const thoughts = message?.content?.thoughts;
      return Array.isArray(thoughts) && thoughts.length > 0;
    }

    if (isLikelyImageGenerationMessage(message)) {
      return true;
    }

    const parts = Array.isArray(message?.content?.parts)
      ? message.content.parts
      : [];

    // Check for asset pointers (attachments/uploads)
    const hasAssetPointer = parts.some((part) => {
      if (!part || typeof part !== "object") return false;
      const contentType = part.content_type || "";
      return (
        contentType === "image_asset_pointer" ||
        contentType === "file_asset_pointer" ||
        contentType === "attachment_asset_pointer" ||
        !!part.asset_pointer
      );
    });

    if (hasAssetPointer) {
      return true;
    }

    const cgoMeta = message?.metadata?.cgo || {};
    if (cgoMeta.is_voice_transcription) {
      return true;
    }

    const text = getMessageTextForExport(message).trim();

    return text.length > 0;
  }

  /**
   * Resolve the best-effort message text used by export normalization.
   *
   * Prefers `message.metadata.cgo.text_fallback` when present so page-hook-derived
   * transcription text can flow through export and lightweight viewer rendering.
   *
   * @param {Object} message - Raw conversation message.
   * @returns {string} Best-effort export text.
   */
  function getMessageTextForExport(message) {
    const cgoText = message?.metadata?.cgo?.text_fallback;
    if (typeof cgoText === "string" && cgoText.length > 0) {
      return cgoText;
    }

    const parts = Array.isArray(message?.content?.parts)
      ? message.content.parts.filter((value) => typeof value === "string")
      : [];

    return parts.join("\n");
  }

  /**
   * Collect tool-role child messages for a given message node.
   *
   * @param {Object} mapping - Conversation node map.
   * @param {string} messageId - Parent message id.
   * @returns {Object[]} Tool messages attached to the node.
   */
  function findChildToolMessages(mapping, messageId) {
    if (!mapping || !messageId) return [];

    const node = mapping[messageId];
    if (!node || !Array.isArray(node.children)) return [];

    return node.children
      .map((childId) => mapping[childId]?.message)
      .filter((msg) => msg && msg.author?.role === "tool");
  }

  /**
   * Extract a ChatGPT file id from an asset pointer string.
   *
   * @param {string} assetPointer - Asset pointer URI.
   * @returns {string} File id or an empty string.
   */
  function extractFileIdFromAssetPointer(assetPointer) {
    if (typeof assetPointer !== "string") return "";

    const match = assetPointer.match(/^sediment:\/\/(file_[A-Za-z0-9]+)/i);
    return match ? match[1] : "";
  }

  /**
   * Build the estuary content URL for a file id.
   *
   * @param {string} fileId - ChatGPT file id.
   * @returns {string} Estuary URL or an empty string.
   */
  function buildEstuaryUrlFromFileId(fileId) {
    if (!fileId || typeof fileId !== "string") return "";
    if (!/^file_/i.test(fileId)) return "";

    return `https://chatgpt.com/backend-api/estuary/content?id=${encodeURIComponent(fileId)}`;
  }

  /**
   * Check whether a URL points to a ChatGPT-hosted asset endpoint.
   *
   * @param {string} url - Candidate URL.
   * @returns {boolean} `true` when the URL looks like a ChatGPT asset.
   */
  function isLikelyChatgptAssetUrl(url) {
    return (
      typeof url === "string" &&
      (
        /(?:https:\/\/chatgpt\.com)?\/backend-api\/estuary\/content\?/i.test(url) ||
        /(?:https:\/\/chatgpt\.com)?\/backend-api\/files\//i.test(url)
      )
    );
  }

  /**
   * Convert relative ChatGPT asset URLs into absolute URLs when needed.
   *
   * @param {string} url - Candidate URL.
   * @returns {string} Absolute or original URL string.
   */
  function normalizeMaybeRelativeChatgptUrl(url) {
    if (!url || typeof url !== "string") return "";
    if (url.startsWith("http://") || url.startsWith("https://")) return url;
    if (url.startsWith("/")) return `https://chatgpt.com${url}`;
    return url;
  }

  /**
   * Recursively collect nested objects from an arbitrary value tree.
   *
   * @param {*} value - Value to traverse.
   * @param {Object[]} [out=[]] - Accumulator for discovered objects.
   * @returns {Object[]} Collected object references.
   */
  function collectObjectsDeep(value, out = []) {
    if (!value) return out;

    if (Array.isArray(value)) {
      for (const item of value) {
        collectObjectsDeep(item, out);
      }
      return out;
    }

    if (typeof value === "object") {
      out.push(value);
      for (const v of Object.values(value)) {
        collectObjectsDeep(v, out);
      }
    }

    return out;
  }

  /**
   * Derive a useful alt/caption label from an image-like object and message context.
   *
   * @param {Object} obj - Candidate image-like object.
   * @param {Object} message - Parent message.
   * @returns {string} Best-effort alt text.
   */
  function deriveImageAltFromObject(obj, message) {
    if (!obj || typeof obj !== "object") return "";

    const candidates = [
      obj.alt_text,
      obj.alt,
      obj.caption,
      obj.title,
      obj.label,
      obj.name,
      message?.metadata?.title,
      message?.title,
    ];

    for (const value of candidates) {
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }

    return "";
  }

  /**
   * Test whether a MIME type is an image MIME.
   *
   * @param {*} value - Candidate MIME type.
   * @returns {boolean} `true` when the value starts with `image/`.
   */
  function looksLikeImageMime(value) {
    return typeof value === "string" && /^image\//i.test(value);
  }

  /**
   * Test whether a filename has a common image extension.
   *
   * @param {*} value - Candidate filename.
   * @returns {boolean} `true` when the filename looks image-like.
   */
  function looksLikeImageFilename(value) {
    return typeof value === "string" && /\.(png|jpg|jpeg|webp|gif|bmp|svg)$/i.test(value);
  }

  /**
   * Check whether an object looks like it describes an image asset.
   *
   * @param {Object} obj - Candidate object.
   * @returns {boolean} `true` when the object appears image-related.
   */
  function looksLikeImageObject(obj) {
    if (!obj || typeof obj !== "object") return false;

    const contentType = String(obj.content_type || obj.type || "").toLowerCase();

    return (
      contentType === "image_asset_pointer" ||
      contentType === "image" ||
      looksLikeImageMime(obj.mime_type) ||
      looksLikeImageMime(obj.mimeType) ||
      looksLikeImageFilename(obj.filename) ||
      looksLikeImageFilename(obj.name) ||
      !!obj.alt_text ||
      !!obj.image_url
    );
  }

  /**
   * Extract generated image metadata from tool-role messages.
   *
   * @param {Object} message - Tool message payload.
   * @returns {Object[]} Normalized image metadata entries.
   */
  function extractImageAssetsFromToolMessage(message) {
    if (!message || typeof message !== "object") return [];
    if (message?.author?.role !== "tool") return [];

    const parts = Array.isArray(message?.content?.parts)
      ? message.content.parts
      : [];

    const results = [];
    const seen = new Set();

    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      if (part.content_type !== "image_asset_pointer") continue;

      const fileId = extractFileIdFromAssetPointer(part.asset_pointer);
      if (!fileId) continue;

      const url = buildEstuaryUrlFromFileId(fileId);
      if (!url || seen.has(url)) continue;
      seen.add(url);

      const title =
        message?.metadata?.image_gen_title ||
        message?.metadata?.async_task_title ||
        "";

      results.push(CGO.normalizeImageMeta({
        fileId,
        url,
        alt: title ? `${CGO.t("generated_image")}: ${title}` : "",
        title,
        fileName: part.file_name || "",
        mimeType: part.mime_type || "",
        fileSizeBytes: Number(part.size_bytes || part.file_size_bytes || 0),
        width: Number(part.width || 0),
        height: Number(part.height || 0),
        source: "tool-asset-pointer",
      }));
    }

    return results;
  }

  /**
   * Scan a raw message payload for image-like objects and URLs.
   *
   * @param {Object} message - Raw message payload.
   * @returns {Object[]} Image metadata inferred from nested message data.
   */
  function extractImageAssetsFromMessageData(message) {
    if (!message || typeof message !== "object") return [];

    const objects = collectObjectsDeep(message, []);
    const byUrl = new Map();

    for (const obj of objects) {
      if (!obj || typeof obj !== "object") continue;

      const imageLike = looksLikeImageObject(obj);
      const mimeType = String(obj.mime_type || obj.mimeType || "").toLowerCase();
      const fileName = String(obj.file_name || obj.filename || obj.name || "").toLowerCase();
      const contentType = String(obj.content_type || obj.type || "").toLowerCase();

      const definitelyImage = (
        imageLike ||
        contentType === "image_asset_pointer" ||
        contentType === "image" ||
        looksLikeImageMime(mimeType) ||
        looksLikeImageFilename(fileName)
      );

      if (!definitelyImage) continue;

      const rawUrlCandidates = [
        obj.url,
        obj.download_url,
        obj.downloadUrl,
        obj.asset_url,
        obj.assetUrl,
        obj.image_url,
        obj.imageUrl,
        obj.src,
        obj.href,
        obj.signed_url,
        obj.signedUrl,
        obj.public_url,
        obj.publicUrl,
      ];

      const fileIdCandidates = [
        obj.file_id,
        obj.fileId,
        obj.asset_id,
        obj.assetId,
        obj.id,
      ];

      const alt = deriveImageAltFromObject(obj, message);

      for (const rawUrl of rawUrlCandidates) {
        if (typeof rawUrl !== "string" || !rawUrl.trim()) continue;

        const url = CGO.normalizeMaybeRelativeChatgptUrl(rawUrl.trim());
        if (!isLikelyChatgptAssetUrl(url)) continue;

        const prev = byUrl.get(url);
        const candidate = {
          url,
          alt,
          source: "data-url",
          score: (imageLike ? 100 : 0) + (alt ? 10 : 0),
        };

        if (!prev || candidate.score > prev.score) {
          byUrl.set(url, candidate);
        }
      }

      for (const maybeFileId of fileIdCandidates) {
        if (typeof maybeFileId !== "string" || !maybeFileId.trim()) continue;

        const url = buildEstuaryUrlFromFileId(maybeFileId.trim());
        if (!url) continue;

        const prev = byUrl.get(url);
        const candidate = {
          url,
          alt,
          source: "data-file-id",
          score: (imageLike ? 80 : 0) + (alt ? 10 : 0),
        };

        if (!prev || candidate.score > prev.score) {
          byUrl.set(url, candidate);
        }
      }
    }

    return Array.from(byUrl.values()).map(({ url, alt, source }) => ({
      url,
      alt,
      source,
    }));
  }

  /**
   * Extract attachment metadata from `message.metadata.attachments`.
   *
   * @param {Object} message - Raw message payload.
   * @returns {Object[]} Normalized attachment metadata.
   */
  function extractAttachmentsFromMetadataAttachments(message) {
    const attachments = message?.metadata?.attachments;
    if (!Array.isArray(attachments)) return [];

    return attachments.map((att) => ({
      fileId: att.id || "",
      url: "",
      name: att.name || "",
      mimeType: att.mime_type || "",
      fileSizeBytes: Number(att.size || 0),
      kind: CGO.guessAttachmentKind(att.name, att.mime_type),
      source: "metadata.attachments",
      unresolved: true,
      localPath: "",
      isSandboxArtifact: false,
    }));
  }

  // page-hook.js に同名関数あり、変更時は合わせて変更
  /**
   * Build a stable synthetic file id for sandbox artifacts.
   *
   * @param {string} messageId - Message identifier.
   * @param {string} sandboxPath - Sandbox file path.
   * @returns {string} Synthetic sandbox file id or an empty string.
   */
  function buildSandboxFileId(messageId, sandboxPath) {
    if (!messageId || !sandboxPath) return "";
    return "sandbox:" + CGO.hash(`${messageId}:${sandboxPath}`);
  }

  /**
   * Discover interpreter sandbox file references embedded in rendered message text.
   *
   * @param {Object} message - Normalized export message.
   * @returns {Object[]} Attachment-like records for sandbox artifacts.
   */
  function extractSandboxArtifacts(message) {
    const text = message.text
    const source = typeof text === "string" ? text : "";
    const matches = source.match(/sandbox:\/mnt\/data\/[^\s)\]]+/g);
    if (!matches) return [];

    return matches.map((url) => {
      const name = url.split("/").pop() || "sandbox-file";
      const fileId = buildSandboxFileId(message.id, url);

      return {
        fileId,
        url: "",
        name,
        mimeType: "",
        fileSizeBytes: 0,
        kind: CGO.guessAttachmentKind(name, ""),
        source: "sandbox-artifact",
        unresolved: true,
        localPath: "",
        isSandboxArtifact: true,
        sandboxPath: url,
        messageId: message.id,
      };
    });
  }

  /**
   * Extract a file id from either sediment or file-service asset pointers.
   *
   * @param {string} assetPointer - Asset pointer URI.
   * @returns {string} File id or an empty string.
   */
  function normalizeFileIdFromAssetPointer(assetPointer) {
    if (typeof assetPointer !== "string") return "";

    const match = assetPointer.match(/(?:file-service|sediment):\/\/(file_[A-Za-z0-9]+)/i);
    return match ? match[1] : "";
  }

  /**
   * Return a UI icon glyph for an attachment kind.
   *
   * @param {string} kind - Attachment category.
   * @param {boolean} [isSandboxArtifact=false] - Whether the attachment is a sandbox artifact.
   * @returns {string} Icon glyph.
   */
  function getAttachmentIcon(kind, isSandboxArtifact = false) {
    if (isSandboxArtifact) return "🧪";

    switch (kind) {
      case "archive":
        return "🗜️";
      case "pdf":
        return "📄";
      case "image":
        return "🖼️";
      case "text":
        return "📝";
      case "code":
        return "💻";
      default:
        return "📎";
    }
  }

  /**
   * Infer a high-level attachment kind from filename and MIME type.
   *
   * @param {string} name - Attachment filename.
   * @param {string} mimeType - Attachment MIME type.
   * @returns {"archive"|"pdf"|"image"|"text"|"code"|"attachment"} Attachment kind.
   */
  function guessAttachmentKind(name, mimeType) {
    const fileName = String(name || "").toLowerCase();
    const mime = String(mimeType || "").toLowerCase();

    if (
      /\.(zip|7z|rar|tar|gz|tgz|bz2|xz)$/i.test(fileName) ||
      [
        "application/zip",
        "application/x-7z-compressed",
        "application/vnd.rar",
        "application/x-tar",
        "application/gzip",
        "application/x-gzip"
      ].includes(mime)
    ) {
      return "archive";
    }

    if (mime === "application/pdf" || /\.pdf$/i.test(fileName)) {
      return "pdf";
    }

    if (
      /\.(png|jpg|jpeg|webp|gif|svg)$/i.test(fileName) ||
      mime.startsWith("image/")
    ) {
      return "image";
    }

    if (
      /\.(txt|md|json|csv|log|yaml|yml|xml)$/i.test(fileName) ||
      mime.startsWith("text/") ||
      mime === "application/json"
    ) {
      return "text";
    }

    if (
      /\.(py|js|ts|tsx|jsx|html|css|sh|bash|zsh|java|c|cpp|rs|go|php)$/i.test(fileName)
    ) {
      return "code";
    }

    return "attachment";
  }

  /**
   * Remove duplicate attachments while preserving their original order.
   *
   * @param {Object[]} attachments - Candidate attachment list.
   * @returns {Object[]} Deduplicated attachments.
   */
  function dedupeAttachments(attachments) {
    const out = [];
    const seen = new Set();

    for (const item of attachments || []) {
      if (!item || typeof item !== "object") continue;

      const key =
        item.fileId ||
        item.url ||
        `${item.name || ""}:${item.mimeType || ""}:${item.fileSizeBytes || 0}:${item.source || ""}`;

      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }

    return out;
  }

  /**
   * Build a normalized error object for failed HTTP requests.
   *
   * @param {Response} response - Fetch response.
   * @param {string} [context=""] - Human-readable request context.
   * @returns {Error} Error enriched with status and classification fields.
   */
  function createHttpError(response, context = "") {
    const contentType = response.headers.get("content-type") || "";

    const error = new Error(
      `${context || "Request"} failed: ${response.status}`
    );

    error.status = response.status;
    error.contentType = contentType;
    error.code =
      response.status === 401 || response.status === 403 ? "auth" :
        response.status === 404 ? "not_found" :
          response.status === 415 ? "unsupported_media" :
            response.status >= 500 ? "server" :
              "http";

    return error;
  }

  /**
   * Create an error object from an API detail code and message.
   *
   * @param {string} code - Normalized error code.
   * @param {string} [detail=""] - API detail text.
   * @param {string} [context=""] - Human-readable request context.
   * @returns {Error} Error carrying `code` and `detail`.
   */
  function createDetailError(code, detail = "", context = "") {
    const error = new Error(
      `${context || "Request"} failed${detail ? `: ${detail}` : ""}`
    );
    error.code = code || "http";
    error.detail = detail || "";
    return error;
  }

  /**
   * Reduce different fetch failure shapes into a small export-oriented error code set.
   *
   * @param {Error} error - Error thrown by fetch or a helper.
   * @returns {string} Normalized error code.
   */
  function classifyFetchError(error) {
    if (!error) return "unknown";
    if (error.code) return error.code;
    if (error.name === "AbortError") return "aborted";
    return "network";
  }

  /**
   * Format a byte count into a short human-readable string.
   *
   * @param {number} bytes - Byte count.
   * @returns {string} Formatted size label.
   */
  function formatBytes(bytes) {
    if (!bytes || isNaN(bytes)) return '0 B';
    
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let value = Number(bytes);
    
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i++;
    }
    
    // 表示ルール（UI向け）
    if (i === 0) {
      // Bは整数
      return `${Math.round(value)} B`;
    }
    
    if (value >= 100) {
      return `${Math.round(value)} ${units[i]}`;
    }
    
    if (value >= 10) {
      return `${value.toFixed(1)} ${units[i]}`;
    }
    
    return `${value.toFixed(2)} ${units[i]}`;
  }

  /**
   * Extract file attachments from message parts and content references.
   *
   * @param {Object} message - Raw message payload.
   * @returns {Object[]} Deduplicated attachment metadata.
   */
  function extractAttachmentsFromMessageData(message) {
    const results = [];
    const parts = Array.isArray(message?.content?.parts) ? message.content.parts : [];

    for (const part of parts) {
      if (!part || typeof part !== "object") continue;

      // 画像は既存の image flow に任せる
      if (part.content_type === "image_asset_pointer") continue;

      // 汎用 file asset
      if (
        part.content_type === "file_asset_pointer" ||
        part.content_type === "attachment_asset_pointer"
      ) {
        const fileId = normalizeFileIdFromAssetPointer(part.asset_pointer || "");
        if (!fileId) continue;

        const name =
          part.file_name ||
          part.name ||
          "";

        const mimeType =
          part.mime_type ||
          part.content_type_hint ||
          "";

        const fileSizeBytes =
          Number(part.size_bytes || part.file_size_bytes || 0);

        results.push({
          fileId,
          url: "",
          name,
          mimeType,
          fileSizeBytes,
          kind: CGO.guessAttachmentKind(name, mimeType),
          source: "message-part-asset-pointer",
          unresolved: true,
          localPath: "",
        });
      }
    }

    // metadata.content_references 側も一応見る
    const refs = Array.isArray(message?.metadata?.content_references)
      ? message.metadata.content_references
      : [];

    for (const ref of refs) {
      if (!ref || typeof ref !== "object") continue;

      if (ref.type === "image_group") continue;

      const fileId =
        ref.file_id ||
        normalizeFileIdFromAssetPointer(ref.asset_pointer || "");

      if (!fileId) continue;

      const name = ref.file_name || ref.title || "";
      const mimeType = ref.mime_type || "";
      const fileSizeBytes = Number(ref.file_size_bytes || 0);

      results.push({
        fileId,
        url: "",
        name,
        mimeType,
        fileSizeBytes,
        kind: CGO.guessAttachmentKind(name, mimeType),
        source: "content-reference-file",
        unresolved: true,
        localPath: "",
      });
    }

    return CGO.dedupeAttachments(results);
  }

  /**
   * Gather image assets reachable from a message and its related tool messages.
   *
   * @param {Object} message - Normalized export message.
   * @param {Object[]} [toolMessages=[]] - Related tool-role messages.
   * @returns {Object[]} Deduplicated image metadata.
   */
  function collectImageAssetsFromMessage(message, toolMessages = []) {
    const results = [];

    results.push(...CGO.extractImageAssetsFromMessageData(message));
    results.push(...CGO.extractImageAssetsFromContentReferences(message));

    for (const toolMessage of toolMessages) {
      results.push(...CGO.extractImageAssetsFromToolMessage(toolMessage));
    }

    return CGO.dedupeImages(results.map(CGO.normalizeImageMeta));
  }

  /**
   * Normalize exported thought items into a consistent array shape.
   *
   * @param {Object} message - Raw message payload.
   * @returns {Object[]} Normalized thought entries.
   */
  function normalizeThoughtsForExport(message) {
    const thoughts = Array.isArray(message?.content?.thoughts)
      ? message.content.thoughts
      : [];

    return thoughts.map((item, index) => ({
      index,
      summary: typeof item?.summary === "string" ? item.summary : "",
      content: typeof item?.content === "string" ? item.content : "",
      chunks: Array.isArray(item?.chunks)
        ? item.chunks.filter((v) => typeof v === "string" && v.trim())
        : [],
      finished: !!item?.finished,
    }));
  }

  /**
   * Resolve the assistant message id that a thought message should attach to.
   *
   * @param {string} messageId - Thought message id.
   * @param {Object} mapping - Conversation node map.
   * @returns {string} Target assistant message id or an empty string.
   */
  function findThoughtTargetMessageId(messageId, mapping) {
    if (!messageId || !mapping || !mapping[messageId]) return "";

    /**
     * Determine whether a message is a renderable assistant message.
     *
     * A message is considered renderable if it is authored by the assistant, its
     * content type is not `"thoughts"`, and it contains at least one non-empty
     * string in `content.parts`.
     *
     * @param {Object} msg - The message object to evaluate.
     * @returns {boolean} `true` if the message meets the renderable criteria, `false` otherwise.
     */
    function isRenderableAssistantMessage(msg) {
      if (!msg || msg?.author?.role !== "assistant") return false;
      if (msg?.content?.content_type === "thoughts") return false;

      return getMessageTextForExport(msg).trim().length > 0;
    }

    // 1) parent を再帰的に辿る
    {
      const seen = new Set();
      let cursor = mapping[messageId]?.parent || "";

      while (cursor && mapping[cursor] && !seen.has(cursor)) {
        seen.add(cursor);

        const msg = mapping[cursor]?.message;
        if (isRenderableAssistantMessage(msg)) {
          return cursor;
        }

        cursor = mapping[cursor]?.parent || "";
      }
    }

    // 2) child 側は浅めに探索
    {
      const queue = Array.isArray(mapping[messageId]?.children)
        ? [...mapping[messageId].children]
        : [];
      const seen = new Set();

      while (queue.length) {
        const id = queue.shift();
        if (!id || seen.has(id) || !mapping[id]) continue;
        seen.add(id);

        const msg = mapping[id]?.message;
        if (isRenderableAssistantMessage(msg)) {
          return id;
        }

        const children = Array.isArray(mapping[id]?.children)
          ? mapping[id].children
          : [];

        queue.push(...children);
      }
    }

    return "";
  }

  /**
   * Normalize a filename-like label for inline asset matching.
   *
   * @param {*} value - Candidate asset name.
   * @returns {string} Normalized asset name.
   */
  function normalizeInlineAssetName(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[\s　]+/g, "")
      .replace(/[()（）\[\]［］{}｛｝]/g, "")
      .trim();
  }

  /**
   * Escape a string for safe use inside a regular-expression literal.
   *
   * @param {*} value - Raw text.
   * @returns {string} Escaped text.
   */
  function escapeRegExpLiteral(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Create the placeholder token used for inline exported images.
   *
   * @param {string} messageId - Message identifier.
   * @param {number} index - Image index within the message.
   * @returns {string} Placeholder token.
   */
  function buildInlineImageToken(messageId, index) {
    return `CGO_INLINE_IMAGE_${String(messageId || "msg").replace(/[^A-Za-z0-9_-]+/g, "_")}_${index}__`;
  }

  /**
   * Convert a content-reference entry into replacement text for export rendering.
   *
   * @param {Object} ref - Content-reference descriptor.
   * @returns {string} Replacement text.
   */
  function getContentReferenceReplacement(ref) {
    if (!ref || typeof ref !== "object") return "";

    if (ref.type === "entity" || ref.type === "alt_text") {
      const candidates = [ref.alt, ref.prompt_text, ref.name];

      for (const value of candidates) {
        if (typeof value === "string" && value.trim()) {
          return value.trim();
        }
      }

      return "";
    }

    if (ref.type === "grouped_webpages") {
      const items = Array.isArray(ref.items) ? ref.items : [];
      const primary = items[0];
      if (!primary || typeof primary !== "object") return "";

      const url = typeof primary.url === "string" ? primary.url.trim() : "";
      if (!url) return "";

      const labelCandidates = [primary.attribution, primary.title, "Source"];
      let label = "Source";

      for (const value of labelCandidates) {
        if (typeof value === "string" && value.trim()) {
          label = value.trim();
          break;
        }
      }

      const safeLabel = label.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
      return `[${safeLabel}](${url})`;
    }

    return "";
  }

  /**
   * Replace ChatGPT content reference markers in text with readable text or links.
   *
   * @param {string} text - Raw message text.
   * @param {Object} rawMessage - Raw message payload.
   * @returns {string} Text with supported content references applied.
   */
  function applyContentReferencesToText(text, rawMessage) {
    const sourceText = typeof text === "string" ? text : "";
    if (!sourceText) return sourceText;

    const refs = Array.isArray(rawMessage?.metadata?.content_references)
      ? rawMessage.metadata.content_references
      : [];

    if (!refs.length) return sourceText;

    const replacements = [];

    for (const ref of refs) {
      if (!ref || typeof ref !== "object") continue;

      const matchedText = typeof ref.matched_text === "string"
        ? ref.matched_text
        : "";
      if (!matchedText) continue;

      const replacement = getContentReferenceReplacement(ref);
      if (!replacement) continue;

      replacements.push({
        matchedText,
        replacement,
      });
    }

    if (!replacements.length) return sourceText;

    replacements.sort((a, b) => b.matchedText.length - a.matchedText.length);

    let result = sourceText;

    for (const { matchedText, replacement } of replacements) {
      result = result.split(matchedText).join(replacement);
    }

    return result;
  }

  /**
   * Match inline image placeholders in message text with image/attachment metadata.
   *
   * @param {Object} message - Normalized export message.
   * @returns {Object} The same message object with inline image fields populated.
   */
  function prepareInlineImageData(message) {
    const sourceText = typeof message?.text === "string" ? message.text : "";
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    const images = Array.isArray(message?.images) ? message.images : [];
    const imageAttachments = attachments.filter((attachment) => attachment?.kind === "image");

    if (!sourceText || !imageAttachments.length) {
      message.inlineImages = [];
      message.renderText = sourceText;
      message.visibleAttachments = attachments.slice();
      message.visibleImages = images.slice();
      return message;
    }

    let renderText = sourceText;
    const inlineImages = [];
    const consumedKeys = new Set();

    for (const attachment of imageAttachments) {
      const attachmentName = String(attachment?.name || "").trim();
      if (!attachmentName) continue;

      const normalizedAttachmentName = normalizeInlineAssetName(attachmentName);
      const token = buildInlineImageToken(message.id, inlineImages.length + 1);

      let matched = false;

      renderText = renderText.replace(
        /\[([^\]]+)\]\(([^)\n]+)\)/g,
        (all, label, href) => {
          try {
            const fileName = String(href || "").split("/").pop() || "";
            if (normalizeInlineAssetName(fileName) !== normalizedAttachmentName) {
              return all;
            }

            matched = true;
            return token;
          } catch {
            return all;
          }
        }
      );

      if (!matched) {
        const escapedName = escapeRegExpLiteral(attachmentName);
        const bareLinePattern = new RegExp(`(^|\\n)${escapedName}(?=\\n|$)`, "i");

        if (bareLinePattern.test(renderText)) {
          renderText = renderText.replace(
            bareLinePattern,
            (all, prefix) => `${prefix}${token}`
          );
          matched = true;
        }
      }

      if (!matched) {
        const escapedName = escapeRegExpLiteral(attachmentName);
        const bareTextPattern = new RegExp(escapedName, "i");

        if (bareTextPattern.test(renderText)) {
          renderText = renderText.replace(bareTextPattern, token);
          matched = true;
        }
      }

      if (!matched) continue;

      const attachmentKey = attachment.fileId || attachment.url || attachment.name || "";
      consumedKeys.add(attachmentKey);

      const matchedImage = images.find((image) => {
        const imageKey = image?.fileId || image?.url || image?.fileName || image?.title || image?.alt || "";
        if (attachment.fileId && image?.fileId && attachment.fileId === image.fileId) {
          return true;
        }
        if (attachment.url && image?.url && attachment.url === image.url) {
          return true;
        }
        if (
          normalizeInlineAssetName(image?.fileName || "") === normalizedAttachmentName ||
          normalizeInlineAssetName(image?.title || "") === normalizedAttachmentName ||
          normalizeInlineAssetName(image?.alt || "") === normalizedAttachmentName
        ) {
          return true;
        }
        return imageKey === attachmentKey;
      });

      const baseImage = matchedImage
        ? CGO.normalizeImageMeta(matchedImage)
        : CGO.normalizeImageMeta({
          fileId: attachment.fileId || "",
          url: attachment.url || "",
          fileName: attachment.name || "",
          mimeType: attachment.mimeType || "",
          fileSizeBytes: Number(attachment.fileSizeBytes || 0),
          alt: attachment.name || "",
          title: attachment.name || "",
          source: `${attachment.source || "attachment"}+inline-data`,
          unresolved: attachment.unresolved !== false,
          skipReason: attachment.skipReason || "",
          localPath: attachment.localPath || "",
        });

      inlineImages.push({
        token,
        image: CGO.normalizeImageMeta({
          ...baseImage,
          fileId: baseImage.fileId || attachment.fileId || "",
          url: baseImage.url || attachment.url || "",
          fileName: baseImage.fileName || attachment.name || "",
          mimeType: baseImage.mimeType || attachment.mimeType || "",
          fileSizeBytes: Number(baseImage.fileSizeBytes || attachment.fileSizeBytes || 0),
          alt: baseImage.alt || attachment.name || "",
          title: baseImage.title || attachment.name || "",
          source: baseImage.source || `${attachment.source || "attachment"}+inline-data`,
          unresolved: !!baseImage.unresolved,
          skipReason: baseImage.skipReason || attachment.skipReason || "",
          localPath: baseImage.localPath || attachment.localPath || "",
          embeddedUrl: baseImage.embeddedUrl || null,
        }),
      });
    }

    message.inlineImages = inlineImages;
    message.renderText = renderText;
    message.visibleAttachments = attachments.filter((attachment) => {
      if (attachment?.kind !== "image") return true;
      const key = attachment.fileId || attachment.url || attachment.name || "";
      return !consumedKeys.has(key);
    });
    message.visibleImages = images.filter((image) => {
      const key = image?.fileId || image?.url || image?.fileName || image?.title || image?.alt || "";
      return !consumedKeys.has(key);
    });

    return message;
  }

  /**
   * Convert raw conversation messages into the normalized export message structure.
   *
   * @param {Object[]} chain - Ordered message chain.
   * @param {Object} mapping - Full conversation node map.
   * @returns {Object[]} Normalized export messages.
   */
  function normalizeMessagesForExport(chain, mapping) {
    const normalized = [];
    const byId = new Map();
    const pendingThoughts = [];

    for (const msg of chain) {
      if (!isExportableMessage(msg)) continue;

      const isThoughtMessage = msg?.content?.content_type === "thoughts";

      if (isThoughtMessage) {
        pendingThoughts.push({
          id: msg.id,
          thoughts: normalizeThoughtsForExport(msg),
        });
        continue;
      }

      const cgoMeta = msg?.metadata?.cgo || {};
      let text = getMessageTextForExport(msg);
      text = applyContentReferencesToText(text, msg);

      if (
        isLikelyImageGenerationMessage(msg) &&
        isPureJsonParamText(text)
      ) {
        text = "";
      }

      const toolMessages = findChildToolMessages(mapping, msg.id);

      const item = {
        id: msg.id,
        role: msg.author.role,
        text,
        thoughts: [],
        hasThoughts: false,
        createTime: msg.create_time ?? null,
        rawMessage: msg,
        toolMessages,
        dataImages: collectImageAssetsFromMessage(msg, toolMessages),
        inlineImages: [],
        renderText: text,
        visibleAttachments: [],
        visibleImages: [],
        isVoiceTranscription: !!cgoMeta.is_voice_transcription,
        voiceDirection: cgoMeta.voice_direction || "",
        hasVoiceAudio: !!cgoMeta.has_voice_audio,
      };

      normalized.push(item);
      byId.set(item.id, item);
    }

    for (const entry of pendingThoughts) {
      const targetId = findThoughtTargetMessageId(entry.id, mapping);
      const target = targetId ? byId.get(targetId) : null;

      if (target) {
        target.thoughts.push(...entry.thoughts);
        target.hasThoughts = target.thoughts.length > 0;
        continue;
      }

      // 紐づけ先が見つからない場合だけ単独表示にフォールバック
      normalized.push({
        id: entry.id,
        role: "assistant",
        text: "",
        thoughts: entry.thoughts,
        hasThoughts: entry.thoughts.length > 0,
        createTime: mapping?.[entry.id]?.message?.create_time ?? null,
        rawMessage: mapping?.[entry.id]?.message || null,
        toolMessages: [],
        dataImages: [],
        inlineImages: [],
        renderText: "",
        visibleAttachments: [],
        visibleImages: [],
        isVoiceTranscription: !!mapping?.[entry.id]?.message?.metadata?.cgo?.is_voice_transcription,
        voiceDirection: mapping?.[entry.id]?.message?.metadata?.cgo?.voice_direction || "",
        hasVoiceAudio: !!mapping?.[entry.id]?.message?.metadata?.cgo?.has_voice_audio,
      });
    }

    return normalized;
  }

  /**
   * Test whether text looks like a JSON blob.
   *
   * @param {string} text - Candidate text.
   * @returns {boolean} `true` when the text looks like JSON.
   */
  function looksLikeJsonBlob(text) {
    const trimmed = text.trim();

    return (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    );
  }

  /**
   * Detect image-generation signals inside message metadata.
   *
   * @param {Object} message - Raw message payload.
   * @returns {boolean} `true` when metadata suggests image generation.
   */
  function hasImageMetadataSignature(message) {
    const metadata = message?.metadata;
    if (!metadata || typeof metadata !== "object") return false;

    const json = JSON.stringify(metadata);

    return /image[_-]?gen|generated[_-]?image|estuary|image_asset|asset_pointer/i.test(json);
  }

  /**
   * Detect JSON parameter blobs that resemble image-generation requests.
   *
   * @param {string} text - Candidate JSON text.
   * @returns {boolean} `true` when the JSON shape looks image-related.
   */
  function hasJsonImageParamShape(text) {
    if (!text) return false;
    const trimmed = text.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;

    return /"size"\s*:|"n"\s*:|"quality"\s*:|"background"\s*:|"prompt"\s*:/i.test(trimmed);
  }

  /**
   * Decide whether a message most likely represents an image-generation interaction.
   *
   * @param {Object} message - Raw message payload.
   * @returns {boolean} `true` when the message looks image-generation related.
   */
  function isLikelyImageGenerationMessage(message) {
    if (!message || typeof message !== "object") return false;

    const parts = Array.isArray(message?.content?.parts)
      ? message.content.parts.filter((v) => typeof v === "string")
      : [];

    const text = parts.join("\n").trim();

    if (hasJsonImageParamShape(text)) {
      return true;
    }

    if (CGO.matchesGeneratedImagePrefix(text)) {
      return true;
    }

    if (hasImageMetadataSignature(message)) {
      return true;
    }

    return false;
  }

  /**
   * Collect short image-generation hints from message text and metadata.
   *
   * @param {Object} message - Raw message payload.
   * @returns {string[]} Unique hint strings.
   */
  function extractImageHintsFromMessage(message) {
    if (!isLikelyImageGenerationMessage(message)) {
      return [];
    }

    const hints = [];

    const parts = Array.isArray(message?.content?.parts)
      ? message.content.parts
      : [];

    for (const part of parts) {
      if (typeof part !== "string") continue;

      const text = part.trim();
      if (!text) continue;
      if (looksLikeJsonBlob(text)) continue;

      // 短い画像ラベルだけ許可
      if (CGO.matchesGeneratedImagePrefix(text)) {
        hints.push(text);
      }
    }

    const metadata = message?.metadata;
    if (metadata && typeof metadata === "object") {
      for (const [key, value] of Object.entries(metadata)) {
        if (typeof value !== "string") continue;

        const text = value.trim();
        if (!text) continue;
        if (looksLikeJsonBlob(text)) continue;
        if (text.length > 120) continue;

        if (
          /alt|caption|title|label|image/i.test(key) &&
          !/^https?:\/\//i.test(text)
        ) {
          hints.push(text);
        }
      }
    }

    return [...new Set(hints)];
  }

  /**
   * Test whether a value is an array with at least one item.
   *
   * @param {*} value - Value to inspect.
   * @returns {boolean} `true` when the value is a non-empty array.
   */
  function isNonEmptyArray(value) {
    return Array.isArray(value) && value.length > 0;
  }

  /**
   * Remove duplicate images while preserving order.
   *
   * @param {Object[]} images - Candidate image list.
   * @returns {Object[]} Deduplicated image metadata.
   */
  function dedupeImages(images) {
    const out = [];
    const seen = new Set();

    for (const image of images || []) {
      if (!image || typeof image !== "object") continue;

      const key =
        image.embeddedUrl ||
        image.url ||
        image.fileId ||
        `${image.alt || ""}:${image.hint || ""}:${image.source || ""}`;

      if (seen.has(key)) continue;
      seen.add(key);
      out.push(image);
    }

    return out;
  }

  /**
   * Create an empty normalized image metadata object.
   *
   * @returns {Object} Blank image metadata template.
   */
  function createEmptyImageMeta() {
    return {
      url: "",
      fileId: "",
      alt: "",
      title: "",
      hint: "",
      fileName: "",
      mimeType: "",
      fileSizeBytes: 0,
      width: 0,
      height: 0,
      source: "",
      unresolved: false,
      embeddedUrl: null,
      localPath: "",
      skipReason: "",
    };
  }

  /**
   * Normalize an image metadata object by applying defaults and numeric coercions.
   *
   * @param {Object} image - Partial image metadata.
   * @returns {Object} Normalized image metadata.
   */
  function normalizeImageMeta(image) {
    return {
      ...createEmptyImageMeta(),
      ...(image || {}),
      fileSizeBytes: Number(image?.fileSizeBytes || 0),
      width: Number(image?.width || 0),
      height: Number(image?.height || 0),
      unresolved: !!image?.unresolved,
    };
  }

  /**
   * Build a merge key used to identify equivalent image records.
   *
   * @param {Object} image - Image metadata.
   * @returns {string} Merge key string.
   */
  function getImageMergeKey(image) {
    return (
      image?.fileId ||
      image?.url ||
      `${image?.fileName || ""}:${image?.width || 0}x${image?.height || 0}:${image?.source || ""}`
    );
  }

  /**
   * Merge two image metadata records, preferring populated fields from the primary record.
   *
   * @param {Object} primary - Preferred image metadata.
   * @param {Object} fallback - Fallback image metadata.
   * @returns {Object} Merged image metadata.
   */
  function mergeImageMeta(primary, fallback) {
    const a = CGO.normalizeImageMeta(primary);
    const b = CGO.normalizeImageMeta(fallback);

    return {
      ...a,
      url: a.url || b.url,
      fileId: a.fileId || b.fileId,
      alt: a.alt || b.alt,
      title: a.title || b.title,
      hint: a.hint || b.hint,
      fileName: a.fileName || b.fileName,
      mimeType: a.mimeType || b.mimeType,
      fileSizeBytes: a.fileSizeBytes || b.fileSizeBytes,
      width: a.width || b.width,
      height: a.height || b.height,
      source: a.source || b.source,
      unresolved: a.unresolved && !b.url ? true : a.unresolved,
      embeddedUrl: a.embeddedUrl || b.embeddedUrl || null,
      localPath: a.localPath || b.localPath || "",
      skipReason: a.skipReason || b.skipReason || "",
    };
  }

  /**
   * Merge API-derived and DOM-derived image metadata, preferring richer data entries.
   *
   * @param {Object[]} dataImages - Images extracted from message data.
   * @param {Object[]} domImages - Images extracted from the rendered DOM.
   * @returns {Object[]} Merged image list.
   */
  function mergeImageListsPreferData(dataImages, domImages) {
    const map = new Map();

    for (const image of dataImages || []) {
      const normalized = CGO.normalizeImageMeta(image);
      map.set(getImageMergeKey(normalized), normalized);
    }

    for (const image of domImages || []) {
      const normalized = CGO.normalizeImageMeta(image);
      const key = getImageMergeKey(normalized);

      if (map.has(key)) {
        map.set(key, mergeImageMeta(map.get(key), normalized));
        continue;
      }

      let matchedKey = null;
      for (const [existingKey, existing] of map.entries()) {
        if (
          (normalized.fileId && existing.fileId && normalized.fileId === existing.fileId) ||
          (normalized.url && existing.url && normalized.url === existing.url)
        ) {
          matchedKey = existingKey;
          break;
        }
      }

      if (matchedKey) {
        map.set(matchedKey, mergeImageMeta(map.get(matchedKey), normalized));
      } else {
        map.set(key, normalized);
      }
    }

    return Array.from(map.values());
  }

  /**
   * Process items with a bounded number of concurrent worker executions.
   *
   * @param {Array} items - Items to process.
   * @param {Function} worker - Async worker invoked with `(item, index)`.
   * @param {number} [concurrency=3] - Maximum concurrent workers.
   * @returns {Promise<void>} Resolves when all items are processed.
   */
  async function runWithConcurrency(items, worker, concurrency = 3) {
    const safeConcurrency = Math.max(1, Math.min(concurrency, items.length || 1));
    let index = 0;

    /**
     * Continuously pulls the next available item index and invokes `worker` on it until no items remain.
     *
     * This runner increments a shared `index` and processes items[index] in a loop, exiting when the index reaches `items.length`.
     * It is intended to be used as one concurrent worker in a pool created by `runWithConcurrency`.
     * @returns {Promise<void>} Resolves when this runner has processed all items assigned to it.
     */
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

  /**
   * Extract a message id from a rendered conversation turn element.
   *
   * @param {Element} turnEl - Conversation turn element.
   * @returns {?string} Message id or `null`.
   */
  function extractMessageIdFromTurn(turnEl) {
    const imageContainer = turnEl.querySelector('[id^="image-"]');
    if (imageContainer?.id) {
      return imageContainer.id.replace(/^image-/, "");
    }

    return null;
  }

  /**
   * Collect visible conversation turn articles from the page for export-time DOM scraping.
   *
   * @returns {Element[]} Connected conversation turn elements.
   */
  function getTurnArticlesForExport() {
    const root = document.querySelector("main");
    if (!root) return [];
    
    return Array.from(
      root.querySelectorAll('article[data-testid^="conversation-turn-"]')
    ).filter((node) => node && node.isConnected);
  }

  /**
   * Guess a filename from a URL path.
   *
   * @param {string} url - Candidate URL.
   * @returns {string} Filename or an empty string.
   */
  function guessFileNameFromUrl(url) {
    try {
      const u = new URL(url, location.origin);
      return u.pathname.split("/").pop() || "";
    } catch {
      return "";
    }
  }

  /**
   * Extract rendered image metadata from a conversation turn DOM node.
   *
   * @param {Element} turnEl - Conversation turn element.
   * @returns {Object[]} Deduplicated image metadata from the DOM.
   */
  function extractImagesFromTurn(turnEl) {
    const byUrl = new Map();
    const imgNodes = turnEl.querySelectorAll("img");

    for (const img of imgNodes) {
      const url = img.currentSrc || img.src || "";
      if (!url) continue;

      const alt = (img.alt || "").trim();
      const width = Number(img.getAttribute("width") || img.naturalWidth || 0);
      const height = Number(img.getAttribute("height") || img.naturalHeight || 0);
      const fileId = extractFileIdFromEstuaryUrl(url);

      const score =
        (alt ? 1000 : 0) +
        (width * height) +
        (img.id ? 10 : 0);

      const prev = byUrl.get(url);
      const candidate = CGO.normalizeImageMeta({
        url,
        alt,
        width,
        height,
        fileId,
        fileName: guessFileNameFromUrl(url),
        source: "dom",
      });

      if (!prev || score > prev.score) {
        byUrl.set(url, { ...candidate, score });
      }
    }

    return Array.from(byUrl.values()).map(({ score, ...item }) => item);
  }

  /**
   * Extract user-uploaded image assets from a raw user message payload.
   *
   * @param {Object} message - Raw message payload.
   * @returns {Object[]} User image metadata.
   */
  function extractUserImagesFromMessage(message) {
    const parts = message?.content?.parts;
    if (!Array.isArray(parts)) return [];

    const images = [];

    for (const part of parts) {
      if (
        part &&
        typeof part === "object" &&
        part.content_type === "image_asset_pointer"
      ) {
        const asset = part.asset_pointer || "";
        const fileId = extractFileIdFromAssetPointer(asset);

        if (fileId) {
          images.push({
            fileId,
            url: `https://chatgpt.com/backend-api/estuary/content?id=${fileId}`,
            source: "user-asset-pointer",
          });
        }
      }
    }

    return images;
  }

  /**
   * Extract downloadable attachment links from a rendered conversation turn.
   *
   * @param {Element} turnEl - Conversation turn element.
   * @returns {Object[]} Attachment link metadata.
   */
  function extractAttachmentsFromTurn(turnEl) {
    const results = [];
    const seen = new Set();

    const links = turnEl.querySelectorAll("a[href]");

    for (const link of links) {
      const url = link.href || "";
      const name = (link.textContent || "").trim();

      if (!url) continue;

      const looksLikeFile =
        link.hasAttribute("download") ||
        /\/files?\//i.test(url) ||
        /download/i.test(url);

      if (!looksLikeFile) continue;
      if (seen.has(url)) continue;

      seen.add(url);

      results.push({
        name: name || url,
        url,
        kind: "file",
      });
    }

    return results;
  }

  /**
   * Detect whether text is a pure JSON image-parameter blob.
   *
   * @param {string} text - Candidate text.
   * @returns {boolean} `true` when the text looks like image params only.
   */
  function isPureJsonParamText(text) {
    if (!text) return false;

    const trimmed = text.trim();

    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      return false;
    }

    return /"size"\s*:|"n"\s*:|"quality"\s*:|"background"\s*:|"prompt"\s*:/i.test(trimmed);
  }

  /**
   * Infer whether a rendered conversation turn belongs to the user or assistant.
   *
   * @param {Element} turnEl - Conversation turn element.
   * @returns {?string} `"user"`, `"assistant"`, or `null`.
   */
  function getTurnRoleFromDom(turnEl) {
    if (!turnEl) return null;

    const directRole =
      turnEl.getAttribute("data-turn") ||
      turnEl.dataset?.turn;

    if (directRole === "user" || directRole === "assistant") {
      return directRole;
    }

    const roleNode = turnEl.querySelector("[data-message-author-role]");
    const nestedRole = roleNode?.getAttribute("data-message-author-role") || null;

    if (nestedRole === "user" || nestedRole === "assistant") {
      return nestedRole;
    }

    return null;
  }

  /**
   * Extract the estuary file id from a ChatGPT estuary URL.
   *
   * @param {string} url - Candidate estuary URL.
   * @returns {string} File id or an empty string.
   */
  function extractFileIdFromEstuaryUrl(url) {
    if (typeof url !== "string") return "";

    try {
      const u = new URL(url, location.origin);
      if (!u.pathname.includes("/backend-api/estuary/content")) return "";
      return u.searchParams.get("id") || "";
    } catch {
      return "";
    }
  }

  /**
   * Resolve a signed download URL for an interpreter sandbox file.
   *
   * @param {string} conversationId - Conversation id.
   * @param {string} messageId - Message id that owns the sandbox file.
   * @param {string} sandboxPath - Sandbox file path.
   * @param {string} [authorization=""] - Optional authorization header.
   * @returns {Promise<string>} Signed download URL or an empty string.
   */
  async function resolveSandboxDownloadUrl(
    conversationId,
    messageId,
    sandboxPath,
    authorization = ""
  ) {
    if (!conversationId || !messageId || !sandboxPath) return "";

    const url =
      `/backend-api/conversation/${encodeURIComponent(conversationId)}` +
      `/interpreter/download` +
      `?message_id=${encodeURIComponent(messageId)}` +
      `&sandbox_path=${encodeURIComponent(sandboxPath.replace(/^sandbox:/, ""))}`;

    const headers = new Headers();
    if (authorization) {
      headers.set("authorization", authorization);
    }

    const res = await fetch(url, {
      method: "GET",
      headers,
      credentials: "include",
    });

    if (!res.ok) {
      throw CGO.createHttpError(res, "Sandbox download resolve");
    }

    const data = await res.json();
    return typeof data?.download_url === "string" ? data.download_url : "";
  };

  /**
   * Resolve a signed ChatGPT file download URL from a file id.
   *
   * @param {string} fileId - File id.
   * @param {string} conversationId - Conversation id.
   * @param {string} [authorization=""] - Optional authorization header.
   * @returns {Promise<string>} Signed download URL or an empty string.
   */
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

    const contentType = response.headers.get("content-type") || "";
    let data = null;

    if (/application\/json/i.test(contentType)) {
      try {
        data = await response.json();
      } catch (_) {
        data = null;
      }
    }

    if (!response.ok) {
      if (data?.detail === "File not found") {
        const error = createDetailError("expired", data.detail, "files/download resolve");
        error.status = response.status;
        error.contentType = contentType;
        throw error;
      }
      throw CGO.createHttpError(response, "files/download resolve");
    }

    if (!data) {
      data = await response.json();
    }

    if (data?.detail === "File not found") {
      const error = createDetailError("expired", data.detail, "files/download resolve");
      error.status = response.status;
      error.contentType = contentType;
      throw error;
    }

    return typeof data?.download_url === "string" ? data.download_url : "";
  }

  CGO.buildExportChain = buildExportChain;
  CGO.classifyFetchError = classifyFetchError;
  CGO.createHttpError = createHttpError;
  CGO.dedupeAttachments = dedupeAttachments;
  CGO.dedupeImages = dedupeImages;
  CGO.extractAttachmentsFromMessageData = extractAttachmentsFromMessageData;
  CGO.extractAttachmentsFromMetadataAttachments = extractAttachmentsFromMetadataAttachments;
  CGO.extractAttachmentsFromTurn = extractAttachmentsFromTurn;
  CGO.extractImageAssetsFromMessageData = extractImageAssetsFromMessageData;
  CGO.extractImageAssetsFromToolMessage = extractImageAssetsFromToolMessage;
  CGO.extractImageHintsFromMessage = extractImageHintsFromMessage;
  CGO.extractImagesFromTurn = extractImagesFromTurn;
  CGO.extractMessageIdFromTurn = extractMessageIdFromTurn;
  CGO.extractSandboxArtifacts = extractSandboxArtifacts;
  CGO.extractUserImagesFromMessage = extractUserImagesFromMessage;
  CGO.formatBytes = formatBytes;
  CGO.getAttachmentIcon = getAttachmentIcon;
  CGO.getConversationFromCache = getConversationFromCache;
  CGO.getConversationIdFromLocation = getConversationIdFromLocation;
  CGO.getTurnArticlesForExport = getTurnArticlesForExport;
  CGO.getTurnRoleFromDom = getTurnRoleFromDom;
  CGO.guessAttachmentKind = guessAttachmentKind;
  CGO.isNonEmptyArray = isNonEmptyArray;
  CGO.mergeImageListsPreferData = mergeImageListsPreferData;
  CGO.normalizeImageMeta = normalizeImageMeta;
  CGO.normalizeMaybeRelativeChatgptUrl = normalizeMaybeRelativeChatgptUrl;
  CGO.normalizeMessagesForExport = normalizeMessagesForExport;
  CGO.prepareInlineImageData = prepareInlineImageData;
  CGO.resolveDownloadUrlFromFileId = resolveDownloadUrlFromFileId;
  CGO.resolveSandboxDownloadUrl = resolveSandboxDownloadUrl;
  CGO.runWithConcurrency = runWithConcurrency;
})();
