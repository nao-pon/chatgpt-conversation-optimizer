(() => {
  const CGO = (globalThis.CGO = globalThis.CGO || {});

  /* -----------------------------
   * Conversation 基本取得
   * ----------------------------- */

  function getConversationIdFromLocation() {
    const match = location.pathname.match(/\/c\/([a-f0-9-]+)/i);
    return match ? match[1] : "";
  }

  function getConversationFromCache() {
    return new Promise((resolve, reject) => {
      const conversationId = getConversationIdFromLocation();
      const requestId = "cgo_export_" + Date.now();

      const timer = setTimeout(() => {
        window.removeEventListener("message", handler);
        reject(new Error("Export cache response timeout"));
      }, 5000);

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

  /* -----------------------------
   * Mapping → chain
   * ----------------------------- */

  function buildExportChain(mapping, currentNode) {
    const chain = [];
    let node = currentNode;

    while (node && mapping[node]) {
      chain.push(node);
      node = mapping[node]?.parent || null;
    }

    return chain.reverse();
  }

  /* -----------------------------
   * normalize
   * ----------------------------- */

  function normalizeMessagesForExport(chain, mapping) {
    const messages = [];

    for (const nodeId of chain) {
      const node = mapping[nodeId];
      if (!node?.message) continue;

      const normalized = normalizeMessage(node.message);
      if (normalized) messages.push(normalized);
    }

    return messages;
  }

  function normalizeMessage(message) {
    const author = message.author?.role || "unknown";
    const createTime = message.create_time || 0;

    const parts = extractMessageParts(message);

    return {
      id: message.id,
      role: author,
      createTime,
      text: parts.text,
      images: parts.images,
      attachments: parts.attachments,
    };
  }

  function extractMessageParts(message) {
    const content = message.content || {};
    const parts = content.parts || [];

    let text = "";
    const images = [];
    const attachments = [];

    for (const part of parts) {
      if (typeof part === "string") {
        text += part;
        continue;
      }

      // image
      if (part?.asset_pointer || part?.image_url) {
        images.push({
          url: part.image_url || "",
          fileId: part.asset_pointer || "",
          width: part.width || 0,
          height: part.height || 0,
          fileName: part.file_name || "",
          mimeType: part.mime_type || "",
          fileSizeBytes: part.file_size || 0,
          source: "message-part",
        });
        continue;
      }

      // attachment
      if (part?.file_id || part?.name) {
        attachments.push({
          fileId: part.file_id || "",
          name: part.name || "",
          mimeType: part.mime_type || "",
          fileSizeBytes: part.file_size || 0,
          url: "",
          source: "message-part",
        });
        continue;
      }

      // fallback
      if (typeof part === "object") {
        text += JSON.stringify(part);
      }
    }

    return { text, images, attachments };
  }

  /* -----------------------------
   * DOM assets
   * ----------------------------- */

  function buildDomAssetMap() {
    const map = new Map();

    document.querySelectorAll("img").forEach((img) => {
      const src = img.src;
      if (!src) return;

      map.set(src, {
        url: src,
        width: img.naturalWidth || 0,
        height: img.naturalHeight || 0,
        source: "dom",
      });
    });

    return map;
  }

  function mergeMessagesWithDomAssets(messages, domMap) {
    return messages.map((msg) => {
      const mergedImages = msg.images.map((img) =>
        mergeMessageAssets(img, domMap)
      );

      return {
        ...msg,
        images: mergedImages,
      };
    });
  }

  function mergeMessageAssets(image, domMap) {
    if (!image?.url) return image;

    const dom = domMap.get(image.url);
    if (!dom) return image;

    return {
      ...image,
      width: image.width || dom.width,
      height: image.height || dom.height,
      source: `${image.source}+dom`,
    };
  }

  /* -----------------------------
   * export
   * ----------------------------- */

  CGO.getConversationIdFromLocation = getConversationIdFromLocation;
  CGO.getConversationFromCache = getConversationFromCache;
  CGO.buildExportChain = buildExportChain;
  CGO.normalizeMessagesForExport = normalizeMessagesForExport;
  CGO.buildDomAssetMap = buildDomAssetMap;
  CGO.mergeMessagesWithDomAssets = mergeMessagesWithDomAssets;
})();