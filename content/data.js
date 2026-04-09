(() => {
  if (globalThis.__CGO_SKIP__) return;
  const CGO = (globalThis.__CGO ||= {});
  with (CGO) {
    CGO.getConversationFromCache = function getConversationFromCache() {
      return new Promise((resolve, reject) => {
        const conversationId = getConversationIdFromLocation();
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
          },
          "*"
        );
      });
    }

    CGO.getConversationIdFromLocation = function getConversationIdFromLocation() {
      const path = location.pathname;

      // 通常会話 /c/<id> だが、WEB:... のような ":" 含みも許可
      let m = path.match(/\/c\/([^/?#]+)/i);
      if (m) return m[1];

      // プロジェクト内チャット
      m = path.match(/\/g\/[^/]+\/c\/([a-z0-9-]+)/i);
      if (m) return m[1];

      return null;
    }

    CGO.buildExportChain = function buildExportChain(mapping, currentNode) {
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

    CGO.isExportableMessage = function isExportableMessage(message) {
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

      const parts = message?.content?.parts;
      if (!Array.isArray(parts)) return false;

      const text = parts
        .filter((v) => typeof v === "string")
        .join("")
        .trim();

      return text.length > 0;
    }

    CGO.findChildToolMessages = function findChildToolMessages(mapping, messageId) {
      if (!mapping || !messageId) return [];

      const node = mapping[messageId];
      if (!node || !Array.isArray(node.children)) return [];

      return node.children
        .map((childId) => mapping[childId]?.message)
        .filter((msg) => msg && msg.author?.role === "tool");
    }

    CGO.extractFileIdFromAssetPointer = function extractFileIdFromAssetPointer(assetPointer) {
      if (typeof assetPointer !== "string") return "";

      const match = assetPointer.match(/^sediment:\/\/(file_[A-Za-z0-9]+)/i);
      return match ? match[1] : "";
    }

    CGO.buildEstuaryUrlFromFileId = function buildEstuaryUrlFromFileId(fileId) {
      if (!fileId || typeof fileId !== "string") return "";
      if (!/^file_/i.test(fileId)) return "";

      return `https://chatgpt.com/backend-api/estuary/content?id=${encodeURIComponent(fileId)}`;
    }

    CGO.isLikelyChatgptAssetUrl = function isLikelyChatgptAssetUrl(url) {
      return (
        typeof url === "string" &&
        (
          /(?:https:\/\/chatgpt\.com)?\/backend-api\/estuary\/content\?/i.test(url) ||
          /(?:https:\/\/chatgpt\.com)?\/backend-api\/files\//i.test(url)
        )
      );
    }

    CGO.normalizeMaybeRelativeChatgptUrl = function normalizeMaybeRelativeChatgptUrl(url) {
      if (!url || typeof url !== "string") return "";
      if (url.startsWith("http://") || url.startsWith("https://")) return url;
      if (url.startsWith("/")) return `https://chatgpt.com${url}`;
      return url;
    }

    CGO.collectObjectsDeep = function collectObjectsDeep(value, out = []) {
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

    CGO.deriveImageAltFromObject = function deriveImageAltFromObject(obj, message) {
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

    CGO.looksLikeImageMime = function looksLikeImageMime(value) {
      return typeof value === "string" && /^image\//i.test(value);
    }

    CGO.looksLikeImageFilename = function looksLikeImageFilename(value) {
      return typeof value === "string" && /\.(png|jpg|jpeg|webp|gif|bmp|svg)$/i.test(value);
    }

    CGO.looksLikeImageObject = function looksLikeImageObject(obj) {
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

    /*  function extractImageAssetsFromToolMessage(message) {
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
    
          results.push({
            fileId,
            url,
            alt: title ? `${t("generated_image")}: ${title}` : "",
            width: Number(part.width || 0),
            height: Number(part.height || 0),
            source: "tool-asset-pointer",
          });
        }
    
        return results;
      }*/
    CGO.extractImageAssetsFromToolMessage = function extractImageAssetsFromToolMessage(message) {
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

        results.push(normalizeImageMeta({
          fileId,
          url,
          alt: title ? `${t("generated_image")}: ${title}` : "",
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

    CGO.extractImageAssetsFromMessageData = function extractImageAssetsFromMessageData(message) {
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

          const url = normalizeMaybeRelativeChatgptUrl(rawUrl.trim());
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

    CGO.extractAttachmentsFromMetadataAttachments = function extractAttachmentsFromMetadataAttachments(message) {
      const attachments = message?.metadata?.attachments;
      if (!Array.isArray(attachments)) return [];

      return attachments.map((att) => ({
        fileId: att.id || "",
        url: "",
        name: att.name || "",
        mimeType: att.mime_type || "",
        fileSizeBytes: Number(att.size || 0),
        kind: guessAttachmentKind(att.name, att.mime_type),
        source: "metadata.attachments",
        unresolved: true,
        localPath: "",
        isSandboxArtifact: false,
      }));
    }

    // page-hook.js に同名関数あり、変更時は合わせて変更
    CGO.buildSandboxFileId = function buildSandboxFileId(messageId, sandboxPath) {
      if (!messageId || !sandboxPath) return "";
      return "sandbox:" + hash(`${messageId}:${sandboxPath}`);
    }

    CGO.extractSandboxArtifacts = function extractSandboxArtifacts(message) {
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
          kind: guessAttachmentKind(name, ""),
          source: "sandbox-artifact",
          unresolved: true,
          localPath: "",
          isSandboxArtifact: true,
          sandboxPath: url,
          messageId: message.id,
        };
      });
    }

    CGO.normalizeFileIdFromAssetPointer = function normalizeFileIdFromAssetPointer(assetPointer) {
      if (typeof assetPointer !== "string") return "";

      const match = assetPointer.match(/(?:file-service|sediment):\/\/(file_[A-Za-z0-9]+)/i);
      return match ? match[1] : "";
    }

    CGO.getAttachmentIcon = function getAttachmentIcon(kind, isSandboxArtifact = false) {
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

    CGO.guessAttachmentKind = function guessAttachmentKind(name, mimeType) {
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

    CGO.dedupeAttachments = function dedupeAttachments(attachments) {
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

    CGO.createHttpError = function createHttpError(response, context = "") {
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

    CGO.createDetailError = function createDetailError(code, detail = "", context = "") {
      const error = new Error(
        `${context || "Request"} failed${detail ? `: ${detail}` : ""}`
      );
      error.code = code || "http";
      error.detail = detail || "";
      return error;
    }

    CGO.classifyFetchError = function classifyFetchError(error) {
      if (!error) return "unknown";
      if (error.code) return error.code;
      if (error.name === "AbortError") return "aborted";
      return "network";
    }

    CGO.formatBytes = function formatBytes(bytes) {
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

    CGO.extractAttachmentsFromMessageData = function extractAttachmentsFromMessageData(message) {
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
            kind: guessAttachmentKind(name, mimeType),
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
          kind: guessAttachmentKind(name, mimeType),
          source: "content-reference-file",
          unresolved: true,
          localPath: "",
        });
      }

      return dedupeAttachments(results);
    }

    CGO.collectImageAssetsFromMessage = function collectImageAssetsFromMessage(message, toolMessages = []) {
      const results = [];

      results.push(...CGO.extractImageAssetsFromMessageData(message));
      results.push(...CGO.extractImageAssetsFromContentReferences(message));

      for (const toolMessage of toolMessages) {
        results.push(...extractImageAssetsFromToolMessage(toolMessage));
      }

      return dedupeImages(results.map(normalizeImageMeta));
    }

    CGO.normalizeThoughtsForExport = function normalizeThoughtsForExport(message) {
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

    CGO.findThoughtTargetMessageId = function findThoughtTargetMessageId(messageId, mapping) {
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

        const parts = Array.isArray(msg?.content?.parts)
          ? msg.content.parts
          : [];

        return parts.some((v) => typeof v === "string" && v.trim());
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

    CGO.normalizeInlineAssetName = function normalizeInlineAssetName(value) {
      return String(value || "")
        .toLowerCase()
        .replace(/\.[a-z0-9]+$/i, (m) => m)
        .replace(/[\s　]+/g, "")
        .replace(/[()（）\[\]［］{}｛｝]/g, "")
        .trim();
    }

    CGO.escapeRegExpLiteral = function escapeRegExpLiteral(value) {
      return String(value || "").replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
    }

    CGO.buildInlineImageToken = function buildInlineImageToken(messageId, index) {
      return `CGO_INLINE_IMAGE_${String(messageId || "msg").replace(/[^A-Za-z0-9_-]+/g, "_")}_${index}__`;
    }

    CGO.prepareInlineImageData = function prepareInlineImageData(message) {
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
          ? normalizeImageMeta(matchedImage)
          : normalizeImageMeta({
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
          image: normalizeImageMeta({
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

    CGO.normalizeMessagesForExport = function normalizeMessagesForExport(chain, mapping) {
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

        const parts = Array.isArray(msg?.content?.parts)
          ? msg.content.parts.filter((v) => typeof v === "string")
          : [];

        let text = parts.join("\n");

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
        });
      }

      return normalized;
    }

    CGO.looksLikeJsonBlob = function looksLikeJsonBlob(text) {
      const trimmed = text.trim();

      return (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      );
    }

    CGO.hasImageMetadataSignature = function hasImageMetadataSignature(message) {
      const metadata = message?.metadata;
      if (!metadata || typeof metadata !== "object") return false;

      const json = JSON.stringify(metadata);

      return /image[_-]?gen|generated[_-]?image|estuary|image_asset|asset_pointer/i.test(json);
    }

    CGO.hasJsonImageParamShape = function hasJsonImageParamShape(text) {
      if (!text) return false;
      const trimmed = text.trim();
      if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;

      return /"size"\s*:|"n"\s*:|"quality"\s*:|"background"\s*:|"prompt"\s*:/i.test(trimmed);
    }

    CGO.isLikelyImageGenerationMessage = function isLikelyImageGenerationMessage(message) {
      if (!message || typeof message !== "object") return false;

      const parts = Array.isArray(message?.content?.parts)
        ? message.content.parts.filter((v) => typeof v === "string")
        : [];

      const text = parts.join("\n").trim();

      if (hasJsonImageParamShape(text)) {
        return true;
      }

      if (matchesGeneratedImagePrefix(text)) {
        return true;
      }

      if (hasImageMetadataSignature(message)) {
        return true;
      }

      return false;
    }

    CGO.extractImageHintsFromMessage = function extractImageHintsFromMessage(message) {
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
        if (matchesGeneratedImagePrefix(text)) {
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

    CGO.isNonEmptyArray = function isNonEmptyArray(value) {
      return Array.isArray(value) && value.length > 0;
    }

    CGO.dedupeImages = function dedupeImages(images) {
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

    CGO.createEmptyImageMeta = function createEmptyImageMeta() {
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

    CGO.normalizeImageMeta = function normalizeImageMeta(image) {
      return {
        ...createEmptyImageMeta(),
        ...(image || {}),
        fileSizeBytes: Number(image?.fileSizeBytes || 0),
        width: Number(image?.width || 0),
        height: Number(image?.height || 0),
        unresolved: !!image?.unresolved,
      };
    }

    CGO.getImageMergeKey = function getImageMergeKey(image) {
      return (
        image?.fileId ||
        image?.url ||
        `${image?.fileName || ""}:${image?.width || 0}x${image?.height || 0}:${image?.source || ""}`
      );
    }

    CGO.mergeImageMeta = function mergeImageMeta(primary, fallback) {
      const a = normalizeImageMeta(primary);
      const b = normalizeImageMeta(fallback);

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

    CGO.mergeImageListsPreferData = function mergeImageListsPreferData(dataImages, domImages) {
      const map = new Map();

      for (const image of dataImages || []) {
        const normalized = normalizeImageMeta(image);
        map.set(getImageMergeKey(normalized), normalized);
      }

      for (const image of domImages || []) {
        const normalized = normalizeImageMeta(image);
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

    CGO.isLikelyDomImageAsset = function isLikelyDomImageAsset(asset) {
      return !!(
        asset &&
        asset.role === "assistant" &&
        isNonEmptyArray(asset.images)
      );
    }

    CGO.runWithConcurrency = async function runWithConcurrency(items, worker, concurrency = 3) {
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

    CGO.extractMessageIdFromTurn = function extractMessageIdFromTurn(turnEl) {
      const imageContainer = turnEl.querySelector('[id^="image-"]');
      if (imageContainer?.id) {
        return imageContainer.id.replace(/^image-/, "");
      }

      return null;
    }

    CGO.getTurnArticlesForExport = function getTurnArticlesForExport() {
      const root = document.querySelector("main");
      if (!root) return [];
    
      return Array.from(
        root.querySelectorAll('article[data-testid^="conversation-turn-"]')
      ).filter((node) => node && node.isConnected);
    }

    CGO.guessFileNameFromUrl = function guessFileNameFromUrl(url) {
      try {
        const u = new URL(url, location.origin);
        return u.pathname.split("/").pop() || "";
      } catch {
        return "";
      }
    }

    CGO.extractImagesFromTurn = function extractImagesFromTurn(turnEl) {
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
        const candidate = normalizeImageMeta({
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

    CGO.extractUserImagesFromMessage = function extractUserImagesFromMessage(message) {
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

    CGO.extractAttachmentsFromTurn = function extractAttachmentsFromTurn(turnEl) {
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

    CGO.isPureJsonParamText = function isPureJsonParamText(text) {
      if (!text) return false;

      const trimmed = text.trim();

      if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
        return false;
      }

      return /"size"\s*:|"n"\s*:|"quality"\s*:|"background"\s*:|"prompt"\s*:/i.test(trimmed);
    }

    CGO.getTurnRoleFromDom = function getTurnRoleFromDom(turnEl) {
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

    CGO.extractFileIdFromEstuaryUrl = function extractFileIdFromEstuaryUrl(url) {
      if (typeof url !== "string") return "";

      try {
        const u = new URL(url, location.origin);
        if (!u.pathname.includes("/backend-api/estuary/content")) return "";
        return u.searchParams.get("id") || "";
      } catch {
        return "";
      }
    }

    CGO.resolveSandboxDownloadUrl = async function resolveSandboxDownloadUrl(
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
        throw createHttpError(res, "Sandbox download resolve");
      }

      const data = await res.json();
      return typeof data?.download_url === "string" ? data.download_url : "";
    };

    CGO.resolveDownloadUrlFromFileId = async function resolveDownloadUrlFromFileId(fileId, conversationId, authorization = "") {
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
        throw createHttpError(response, "files/download resolve");
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

  }
})();
