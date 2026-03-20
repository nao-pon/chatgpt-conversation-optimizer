(() => {
  if (window.__cgoInstalled) return;
  window.__cgoInstalled = true;

  const PAGE_HOOK_VERSION = "2";
  const PAGE_BOOTSTRAP_ID = "cgo-page-bootstrap";
  const PAGE_MAIN_HOOK_ID = "cgo-page-hook-script";

  const DETECTION_PATTERNS = {
    ja: {
      generatedImagePrefixes: [
        /^画像が作成されました/,
        /^生成された画像[:：]?/,
      ],
    },
    en: {
      generatedImagePrefixes: [
        /^Image created/i,
        /^Generated image[:：]?/i,
      ],
    },
  };

  const CONFIG = {
    keepDomMessages: 40,
    domTrimDelayMs: 1200,
    debug: true,
  };

  const STATE = {
    trimScheduled: false,
    lastStopVisible: false,
  };

  function getDetectionLanguage() {
    const lang = (
      chrome?.i18n?.getUILanguage?.() ||
      document.documentElement.lang ||
      navigator.language ||
      "en"
    ).toLowerCase();

    if (lang.startsWith("ja")) return "ja";
    return "en";
  }

  const DETECTION_LANG = getDetectionLanguage();

  let toolbarBase;

  function getDetectionPatternSet() {
    return (
      DETECTION_PATTERNS[DETECTION_LANG] ||
      DETECTION_PATTERNS.en
    );
  }

  function injectPageBootstrapScript() {
    const oldScript = document.getElementById(PAGE_BOOTSTRAP_ID);
    if (oldScript) {
      oldScript.remove();
    }

    const script = document.createElement("script");
    script.id = PAGE_BOOTSTRAP_ID;
    script.src = chrome.runtime.getURL("page-bootstrap.js");
    script.dataset.cgoVersion = PAGE_HOOK_VERSION;

    script.onload = () => {
      log("page bootstrap loaded");
    };

    script.onerror = (error) => {
      log("[error] page bootstrap load failed", error);
    };

    (document.documentElement || document.head).prepend(script);
  }

  function waitForBootstrapPong(timeoutMs = 1200) {
    return new Promise((resolve) => {
      let done = false;

      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);

      function cleanup() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
      }

      function sendPing() {
        window.postMessage(
          {
            source: "CGO_CONTENT",
            type: "CGO_PING",
            version: PAGE_HOOK_VERSION,
          },
          "*"
        );
      }

      function onMessage(event) {
        if (event.source !== window) return;

        const data = event.data;
        if (!data || data.source !== "CGO_PAGE") return;

        log("[CGO content] saw window message", data);

        // bootstrap が起動完了したら再 ping
        if (data.type === "CGO_READY" && data.bootstrap === true) {
          sendPing();
          return;
        }

        if (data.type === "CGO_PONG" && data.bootstrap === true) {
          cleanup();
          resolve(data.version === PAGE_HOOK_VERSION);
        }
      }

      window.addEventListener("message", onMessage);

      // 最初の1回
      sendPing();
    });
  }

  function waitForMainHookPong(timeoutMs = 1000) {
    return new Promise((resolve) => {
      let done = false;

      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);

      function cleanup() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
      }

      function sendPing() {
        window.postMessage(
          {
            source: "CGO_CONTENT",
            type: "CGO_PING",
            version: PAGE_HOOK_VERSION,
          },
          "*"
        );
      }

      function onMessage(event) {
        if (event.source !== window) return;

        const data = event.data;
        if (!data || data.source !== "CGO_PAGE") return;

        log("[CGO content] saw window message", data);

        if (data.type === "CGO_PONG" && data.mainHook === true) {
          cleanup();
          resolve(data.version === PAGE_HOOK_VERSION);
        }
      }

      window.addEventListener("message", onMessage);
      sendPing();
    });
  }

  async function injectMainPageHookScript() {
    return new Promise((resolve, reject) => {
      const oldScript = document.getElementById(PAGE_MAIN_HOOK_ID);
      if (oldScript) {
        oldScript.remove();
      }

      const script = document.createElement("script");
      script.id = PAGE_MAIN_HOOK_ID;
      script.src = chrome.runtime.getURL("page-hook.js");
      script.dataset.cgoVersion = PAGE_HOOK_VERSION;

      script.onload = () => {
        log("main page-hook loaded");
        resolve();
      };

      script.onerror = (error) => {
        log("[error] main page-hook load failed", error);
        reject(new Error("page-hook.js load failed"));
      };

      (document.documentElement || document.head).appendChild(script);
    });
  }

  async function ensurePageHooksInjected() {
    const bootstrapAlive = await waitForBootstrapPong();

    if (!bootstrapAlive) {
      log("[warn] bootstrap not responding");
      return false;
    }

    // ChatGPT Web は SPA（シングルページアプリ）のため
    // injection が外れることがあるので毎回 inject する
    // 副作用は殆どない
    try {
      await injectMainPageHookScript();

      const mainHookAliveAfterInject = await waitForMainHookPong();
      if (!mainHookAliveAfterInject) {
        log("[warn] main hook did not respond after inject");
        return false;
      }

      log("main hook injected successfully");
      return true;
    } catch (error) {
      log("[error] failed to inject main hook", error);
      return false;
    }
  }

  let LAST_PATHNAME = location.pathname;

  function observeRouteChanges() {
    const observer = new MutationObserver(async () => {
      if (location.pathname !== LAST_PATHNAME) {
        LAST_PATHNAME = location.pathname;

        updateExportButtonVisibility(false);
        injectExportButtonIntoHeader();

        await ensurePageHooksInjected();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function matchesAnyPattern(text, patterns) {
    if (!text || !Array.isArray(patterns)) return false;
    return patterns.some((pattern) => pattern.test(text));
  }

  function matchesGeneratedImagePrefix(text) {
    const patterns = getDetectionPatternSet().generatedImagePrefixes;
    return matchesAnyPattern(text, patterns);
  }

  function log(...args) {
    if (!CONFIG.debug) return;
    console.log("[CGO]", ...args);
  }

  function t(key, substitutions = []) {
    if (!Array.isArray(substitutions)) {
      substitutions = [substitutions];
    }
    try {
      return chrome.i18n.getMessage(key, substitutions) || key;
    } catch {
      return key;
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /*  function unescapeHtml(str) {
      const textarea = document.createElement("textarea");
      textarea.innerHTML = String(str || "");
      return textarea.value;
    }*/

  /*  function getConversationRoot() {
      return document.querySelector("main");
    }
  
    function getTurnArticles() {
      const root = getConversationRoot();
      if (!root) return [];
  
      return Array.from(
        root.querySelectorAll('article[data-testid^="conversation-turn-"]')
      ).filter((node) => node && node.isConnected);
    }*/

  function trimOldDomTurns() {
    const nodes = getTurnArticles();
    const removeCount = nodes.length - CONFIG.keepDomMessages;

    if (removeCount <= 0 || !nodes.length) return;

    const fragment = document.createDocumentFragment();

    for (const node of nodes.slice(0, removeCount)) {
      fragment.appendChild(node);
    }

    log("DOM trim", {
      total: nodes.length,
      removed: removeCount,
      kept: CONFIG.keepDomMessages,
    });
  }

  function runWhenIdle(fn, timeout = 2000) {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(fn, { timeout });
      return;
    }
    setTimeout(fn, 0);
  }

  function scheduleDomTrim(delayMs = CONFIG.domTrimDelayMs) {
    if (STATE.trimScheduled) return;
    STATE.trimScheduled = true;

    setTimeout(() => {
      runWhenIdle(() => {
        STATE.trimScheduled = false;
        trimOldDomTurns();
      }, 2000);
    }, delayMs);
  }

  function observeStreamCompletion() {
    const observer = new MutationObserver(() => {
      if (!location.pathname.startsWith("/c/")) return;

      const stopButton = document.querySelector('button[data-testid="stop-button"]');
      const stopVisible = !!stopButton;

      if (STATE.lastStopVisible && !stopVisible) {
        scheduleDomTrim();
      }

      STATE.lastStopVisible = stopVisible;
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function handleRuntimeMessage(data) {
    if (data.type === "analysis") {
      updateExportButtonVisibility(true)
      console.group("[CGO prune analysis]");
      console.log("url:", data.url);
      console.log("summary:", data.summary);
      console.groupEnd();
      return;
    }

    if (data.type === "log") {
      log(...(data.args || []));
      return;
    }

    if (data.type === "error") {
      log("[error]", data.error);
    }
  }

  function observeWindowMessages() {
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;

      const data = event.data;
      if (!data || data.source !== "cgo-prune-runtime") return;

      handleRuntimeMessage(data);
    });
  }

  // exporter
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

  function getConversationIdFromLocation() {
    const match = location.pathname.match(/\/c\/([a-z0-9-]+)/i);
    return match ? match[1] : null;
  }

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

  function isExportableMessage(message) {
    const role = message?.author?.role;

    if (role !== "user" && role !== "assistant") {
      return false;
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

  function findChildToolMessages(mapping, messageId) {
    if (!mapping || !messageId) return [];

    const node = mapping[messageId];
    if (!node || !Array.isArray(node.children)) return [];

    return node.children
      .map((childId) => mapping[childId]?.message)
      .filter((msg) => msg && msg.author?.role === "tool");
  }

  function extractFileIdFromAssetPointer(assetPointer) {
    if (typeof assetPointer !== "string") return "";

    const match = assetPointer.match(/^sediment:\/\/(file_[A-Za-z0-9]+)/i);
    return match ? match[1] : "";
  }

  function buildEstuaryUrlFromFileId(fileId) {
    if (!fileId || typeof fileId !== "string") return "";
    if (!/^file_/i.test(fileId)) return "";

    return `https://chatgpt.com/backend-api/estuary/content?id=${encodeURIComponent(fileId)}`;
  }

  function isLikelyChatgptAssetUrl(url) {
    return (
      typeof url === "string" &&
      (
        /(?:https:\/\/chatgpt\.com)?\/backend-api\/estuary\/content\?/i.test(url) ||
        /(?:https:\/\/chatgpt\.com)?\/backend-api\/files\//i.test(url)
      )
    );
  }

  function normalizeMaybeRelativeChatgptUrl(url) {
    if (!url || typeof url !== "string") return "";
    if (url.startsWith("http://") || url.startsWith("https://")) return url;
    if (url.startsWith("/")) return `https://chatgpt.com${url}`;
    return url;
  }

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

  function looksLikeImageMime(value) {
    return typeof value === "string" && /^image\//i.test(value);
  }

  function looksLikeImageFilename(value) {
    return typeof value === "string" && /\.(png|jpg|jpeg|webp|gif|bmp|svg)$/i.test(value);
  }

  function looksLikeImageObject(obj) {
    if (!obj || typeof obj !== "object") return false;

    return (
      looksLikeImageMime(obj.mime_type) ||
      looksLikeImageMime(obj.mimeType) ||
      looksLikeImageFilename(obj.filename) ||
      looksLikeImageFilename(obj.name) ||
      !!obj.alt_text ||
      !!obj.image_url ||
      !!obj.asset_pointer
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

  function extractImageAssetsFromMessageData(message) {
    if (!message || typeof message !== "object") return [];

    const objects = collectObjectsDeep(message, []);
    const byUrl = new Map();

    for (const obj of objects) {
      if (!obj || typeof obj !== "object") continue;

      const imageLike = looksLikeImageObject(obj);

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

  function extractAttachmentsFromMetadataAttachments(message) {
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

  function extractSandboxArtifacts(text) {
    const source = typeof text === "string" ? text : "";
    const matches = source.match(/sandbox:\/mnt\/data\/[^\s)\]]+/g);
    if (!matches) return [];

    return matches.map((url) => {
      const name = url.split("/").pop() || "sandbox-file";
      return {
        fileId: "",
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
      };
    });
  }

  function normalizeFileIdFromAssetPointer(assetPointer) {
    if (typeof assetPointer !== "string") return "";

    const match = assetPointer.match(/(?:file-service|sediment):\/\/(file_[A-Za-z0-9]+)/i);
    return match ? match[1] : "";
  }

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

  function classifyFetchError(error) {
    if (!error) return "unknown";
    if (error.code) return error.code;
    if (error.name === "AbortError") return "aborted";
    return "network";
  }

  /*  function formatBytes(bytes) {
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
    }*/

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

  function collectImageAssetsFromMessage(message, toolMessages = []) {
    const results = [];

    results.push(...extractImageAssetsFromMessageData(message));
    results.push(...extractImageAssetsFromContentReferences(message));

    for (const toolMessage of toolMessages) {
      results.push(...extractImageAssetsFromToolMessage(toolMessage));
    }

    return dedupeImages(results.map(normalizeImageMeta));
  }

  /*  function normalizeMessagesForExport(chain, mapping) {
      return chain
        .filter(isExportableMessage)
        .map((msg) => {
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
  
          return {
            id: msg.id,
            role: msg.author.role,
            text,
            createTime: msg.create_time ?? null,
            rawMessage: msg,
            toolMessages: findChildToolMessages(mapping, msg.id),
          };
        });
    }*/
  function normalizeMessagesForExport(chain, mapping) {
    return chain
      .filter(isExportableMessage)
      .map((msg) => {
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

        return {
          id: msg.id,
          role: msg.author.role,
          text,
          createTime: msg.create_time ?? null,
          rawMessage: msg,
          toolMessages,
          dataImages: collectImageAssetsFromMessage(msg, toolMessages),
        };
      });
  }

  function looksLikeJsonBlob(text) {
    const trimmed = text.trim();

    return (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    );
  }

  function hasImageMetadataSignature(message) {
    const metadata = message?.metadata;
    if (!metadata || typeof metadata !== "object") return false;

    const json = JSON.stringify(metadata);

    return /image[_-]?gen|generated[_-]?image|estuary|image_asset|asset_pointer/i.test(json);
  }

  function hasJsonImageParamShape(text) {
    if (!text) return false;
    const trimmed = text.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;

    return /"size"\s*:|"n"\s*:|"quality"\s*:|"background"\s*:|"prompt"\s*:/i.test(trimmed);
  }

  function isLikelyImageGenerationMessage(message) {
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

  function isNonEmptyArray(value) {
    return Array.isArray(value) && value.length > 0;
  }

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

  function getImageMergeKey(image) {
    return (
      image?.fileId ||
      image?.url ||
      `${image?.fileName || ""}:${image?.width || 0}x${image?.height || 0}:${image?.source || ""}`
    );
  }

  function mergeImageMeta(primary, fallback) {
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

  function mergeImageListsPreferData(dataImages, domImages) {
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

  function isLikelyDomImageAsset(asset) {
    return !!(
      asset &&
      asset.role === "assistant" &&
      isNonEmptyArray(asset.images)
    );
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

  function extractMessageIdFromTurn(turnEl) {
    const imageContainer = turnEl.querySelector('[id^="image-"]');
    if (imageContainer?.id) {
      return imageContainer.id.replace(/^image-/, "");
    }

    return null;
  }

  /*  function getTurnArticlesForExport() {
      const root = document.querySelector("main");
      if (!root) return [];
  
      return Array.from(
        root.querySelectorAll('article[data-testid^="conversation-turn-"]')
      ).filter((node) => node && node.isConnected);
    }*/

  /*  function extractImagesFromTurn(turnEl) {
      const byUrl = new Map();
    
      const imgNodes = turnEl.querySelectorAll("img");
    
      for (const img of imgNodes) {
        const url = img.currentSrc || img.src || "";
        if (!url) continue;
    
        const alt = (img.alt || "").trim();
        const width = Number(img.getAttribute("width") || 0);
        const height = Number(img.getAttribute("height") || 0);
        const fileId = extractFileIdFromEstuaryUrl(url);
    
        const score =
          (alt ? 1000 : 0) +
          (width * height) +
          (img.id ? 10 : 0);
    
        const prev = byUrl.get(url);
        const candidate = {
          url,
          alt,
          width,
          height,
          score,
          fileId,
          source: "dom",
        };
    
        if (!prev || candidate.score > prev.score) {
          byUrl.set(url, candidate);
        }
      }
      return Array.from(byUrl.values()).map((item) => ({
        url: item.url,
        alt: item.alt,
        width: item.width,
        height: item.height,
        fileId: item.fileId,
        source: item.source,
      }));
    }*/
  function guessFileNameFromUrl(url) {
    try {
      const u = new URL(url, location.origin);
      return u.pathname.split("/").pop() || "";
    } catch {
      return "";
    }
  }

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

  function isPureJsonParamText(text) {
    if (!text) return false;

    const trimmed = text.trim();

    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      return false;
    }

    return /"size"\s*:|"n"\s*:|"quality"\s*:|"background"\s*:|"prompt"\s*:/i.test(trimmed);
  }

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

  // NOTE:
  // Prefer cached /backend-api/files/download responses first.
  // ChatGPT often resolves signed estuary URLs before or during DOM rendering.
  // Export should reuse those results when possible, and only request missing ones.
  // Missing items are resolved sequentially with a small delay to avoid burst traffic.
  // 
  // Resolve signed image URLs and embed image data with limited concurrency.
  // Full parallelism is intentionally avoided to reduce burst traffic and
  // keep export stable on large conversations.
  async function resolveImageUrlsWithDownloadApi(
    messages,
    conversationId,
    authorization = "",
    onProgress,
    concurrency = 3
  ) {
    const imagesNeedingResolution = [];

    for (const message of messages || []) {
      for (const image of message.images || []) {
        if (!image?.fileId) continue;
        if (image.embeddedUrl) continue;

        // すでに署名付きURLなら不要
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
          // 1) まず cache
          const cached = await getFileDownloadCacheEntry(image.fileId, conversationId);

          if (cached?.downloadUrl) {
            image.url = cached.downloadUrl;
            image.unresolved = false;
            image.source = `${image.source || "file-id"}+download-cache`;
            image.fileName = image.fileName || cached.fileName || "";
            image.fileSizeBytes = image.fileSizeBytes || cached.fileSizeBytes || 0;
            image.mimeType = image.mimeType || cached.mimeType || "";
          } else {
            // 2) 無ければ API
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
          log("[warn] export resolveImageUrlsWithDownloadApi failed", {
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
            attachment.kind = guessAttachmentKind(attachment.name, attachment.mimeType);
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
          log("[warn] export resolveAttachmentUrlsWithDownloadApi failed", {
            fileId: attachment.fileId,
            error: String(error),
          });
          attachment.unresolved = true;
        }

        done += 1;
        if (onProgress) {
          onProgress({ done, total, phase: "resolve-attachments" });
        }
      },
      concurrency
    );
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

  function buildDomImageUrlIndex(domAssets) {
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

  function buildDomAssetMap() {
    const turns = getTurnArticlesForExport();
    const items = [];

    for (const turn of turns) {
      const role = getTurnRoleFromDom(turn);
      if (role !== "user" && role !== "assistant") continue;

      const messageId = extractMessageIdFromTurn(turn);
      const images = extractImagesFromTurn(turn);
      const attachments = extractAttachmentsFromTurn(turn);

      items.push({
        role,
        messageId,
        images,
        attachments,
      });
    }

    log("export dom asset map", items.map((item) => ({
      role: item.role,
      messageId: item.messageId,
      imageCount: item.images.length,
      attachmentCount: item.attachments.length,
    })));

    return items;
  }

  async function imageUrlToDataUrl(url) {
    const response = await fetch(url, {
      credentials: "include",
      cache: "no-store",
    });

    if (!response.ok) {
      throw createHttpError(response, "Image fetch");
    }

    const blob = await response.blob();

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
            log("[warn] export image embed failed", {
              url: image.url,
              fileId: image.fileId,
              code: classifyFetchError(error),
              status: error?.status,
              contentType: error?.contentType,
              error: String(error),
            });
            image.embeddedUrl = null;
            image.skipReason = classifyFetchError(error);
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

  function extractPromptFromJsonParamMessage(message) {
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

  /*  function extractImageAssetsFromContentReferences(message) {
      const refs = Array.isArray(message?.metadata?.content_references)
        ? message.metadata.content_references
        : [];
   
      const results = [];
      const seen = new Set();
   
      for (const ref of refs) {
        if (!ref || ref.type !== "image_group") continue;
        if (!Array.isArray(ref.images)) continue;
   
        for (const item of ref.images) {
          const imageResult = item?.image_result;
          const rawUrl =
            imageResult?.content_url ||
            imageResult?.url ||
            imageResult?.source_url ||
            "";
   
          const url = normalizeMaybeRelativeChatgptUrl(rawUrl);
          if (!url) continue;
          if (seen.has(url)) continue;
          seen.add(url);
   
          results.push({
            url,
            alt: ref.alt || imageResult?.title || "",
            hint: ref.prompt_text || "",
            title: imageResult?.title || "",
            source: "content-reference-image-group",
          });
        }
      }
   
      return results;
    }*/
  function extractImageAssetsFromContentReferences(message) {
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

        const url = normalizeMaybeRelativeChatgptUrl(rawUrl);
        if (!url || seen.has(url)) continue;
        seen.add(url);

        results.push(normalizeImageMeta({
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

  function getToolMessageIds(message) {
    if (!Array.isArray(message?.toolMessages)) return [];
    return message.toolMessages
      .map((msg) => msg?.id)
      .filter((id) => typeof id === "string" && id);
  }

  function hasToolGeneratedImages(message) {
    if (!Array.isArray(message?.toolMessages)) return false;
    return message.toolMessages.some(
      (toolMsg) => extractImageAssetsFromToolMessage(toolMsg).length > 0
    );
  }

  function isImageCandidateMessage(message) {
    return (
      hasToolGeneratedImages(message) ||
      extractImageAssetsFromContentReferences(message?.rawMessage || {}).length > 0 ||
      !!extractPromptFromJsonParamMessage(message?.rawMessage || {})
    );
  }

  function extractPromptHintsFromMessage(message) {
    const prompts = [];

    const jsonPrompt = extractPromptFromJsonParamMessage(message?.rawMessage || {});
    if (jsonPrompt) {
      prompts.push({
        text: jsonPrompt,
        source: "json-prompt",
      });
    }

    const hints = extractImageHintsFromMessage(message?.rawMessage || null);
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

  function buildAssistantDomImagePools(domAssets) {
    const byMessageId = new Map();
    const anonymous = [];

    for (const asset of domAssets || []) {
      if (!asset || asset.role !== "assistant") continue;
      if (!isNonEmptyArray(asset.images)) continue;

      if (asset.messageId) {
        byMessageId.set(asset.messageId, asset);
      } else {
        anonymous.push(asset);
      }
    }

    return { byMessageId, anonymous };
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
      throw createHttpError(response, "Blob fetch");
    }

    return response.blob();
  }

  async function saveImagesToZip(messages, zip, onProgress, concurrency = 3) {
    const imageFolder = zip.folder("images");
    const allImages = messages.flatMap((m) => m.images || []);
    const zipTargetImages = allImages.filter(
      (image) => !isProbablyExternalImage(image)
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
          log("[warn] zip image save failed", {
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

  async function saveAttachmentsToZip(
    messages,
    zip,
    onProgress,
    concurrency = 3,
    maxBytes = 10 * 1024 * 1024
  ) {
    const allAttachments = messages.flatMap((m) => m.attachments || []);
    const candidates = allAttachments;
    const zipTargetAttachments = [];

    for (const attachment of candidates) {
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
          log("[warn] zip attachment save failed", {
            name: attachment.name,
            fileId: attachment.fileId,
            code: classifyFetchError(error),
            status: error?.status,
            contentType: error?.contentType,
            error: String(error),
          });
          attachment.localPath = "";
          attachment.skipReason = classifyFetchError(error);
        }

        done += 1;
        if (onProgress) {
          onProgress({ done, total, phase: "zip-attachments" });
        }
      },
      concurrency
    );
  }

  /*  function renderImagesForZip(images) {
      if (!Array.isArray(images) || images.length === 0) return "";
   
      const items = images.map((image) => {
        const alt = escapeHtml(image.alt || "");
        const caption = escapeHtml(image.alt || image.title || "");
        const sourceLink = renderImageSourceLink(image);
   
        // 1) ZIP内に保存された内部画像
        if (image.localPath) {
          return `<figure class="cgo-image">
          <img src="${escapeHtml(image.localPath)}" alt="${alt}">
          ${caption ? `<figcaption>${caption}</figcaption>` : ""}
          ${sourceLink}
        </figure>`;
        }
   
        // 2) 外部画像はZIPに保存せずオンライン表示
        if (image.url && !image.unresolved && isProbablyExternalImage(image)) {
          return `<figure class="cgo-image cgo-image-external">
          <img src="${escapeHtml(image.url)}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer">
          ${caption ? `<figcaption>${caption}</figcaption>` : ""}
          ${sourceLink}
        </figure>`;
        }
   
        // 3) それ以外は fallback
        return `<figure class="cgo-image cgo-image-missing">
        <div class="cgo-image-missing-box">${escapeHtml(t("image_unavailable_label"))}</div>
        <figcaption>
          ${caption || escapeHtml(t("generated_image_present_label"))}
          ${skipLabel ? `<div class="cgo-image-skip">${escapeHtml(skipLabel)}</div>` : ""}
        </figcaption>
        ${sourceLink}
      </figure>`;
      });
   
      return `<div class="cgo-images">${items.join("\n")}</div>`;
    }*/
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
      const name = escapeHtml(attachment.name || t("attachment_unknown_name"));
      const kindLabel = escapeHtml(
        t(`attachment_kind_${attachment.kind || "attachment"}`)
      );
      const sizeText = escapeHtml(formatBytes(attachment.fileSizeBytes));
      const meta = [kindLabel, sizeText].filter(Boolean).join(" · ");

      const skipLabel = getAttachmentSkipLabel(attachment);
      let actionHtml = `<span>${escapeHtml(t("attachment_not_embedded_label"))}</span>`;

      if (skipLabel) {
        actionHtml = `<span class="cgo-attachment-skip">${escapeHtml(skipLabel)}</span>`;
      } else if (attachment.localPath) {
        actionHtml = `<a href="${escapeHtml(attachment.localPath)}" target="_blank" rel="noopener noreferrer">
        ${escapeHtml(t("attachment_open_local_link"))}
      </a>`;
      } else if (attachment.url) {
        actionHtml = `<a href="${escapeHtml(attachment.url)}" target="_blank" rel="noopener noreferrer">
        ${escapeHtml(t("attachment_open_link"))}
      </a>`;
      }

      return `<div class="cgo-attachment cgo-attachment-${escapeHtml(attachment.kind || "attachment")}">
      <div class="cgo-attachment-icon" aria-hidden="true">${escapeHtml(icon)}</div>
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

  function renderAttachments(attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) return "";

    const items = attachments.map((attachment) => {
      const icon = getAttachmentIcon(attachment.kind, attachment.isSandboxArtifact);
      const name = escapeHtml(attachment.name || t("attachment_unknown_name"));
      const kindLabel = escapeHtml(
        t(`attachment_kind_${attachment.kind || "attachment"}`)
      );
      const sizeText = escapeHtml(formatBytes(attachment.fileSizeBytes));
      const meta = [kindLabel, sizeText].filter(Boolean).join(" · ");

      let actionHtml = "";

      const skipLabel = getAttachmentSkipLabel(attachment);

      if (skipLabel) {
        actionHtml = `<span class="cgo-attachment-skip">${escapeHtml(skipLabel)}</span>`;
      } else if (attachment.isSandboxArtifact) {
        actionHtml = `<span>${escapeHtml(t("attachment_sandbox_artifact_label"))}</span>`;
      } else if (attachment.url) {
        actionHtml = `<a href="${escapeHtml(attachment.url)}" target="_blank" rel="noopener noreferrer">
    ${escapeHtml(t("attachment_open_link"))}
  </a>`;
      } else {
        actionHtml = `<span>${escapeHtml(t("attachment_not_embedded_label"))}</span>`;
      }

      return `<div class="cgo-attachment cgo-attachment-${escapeHtml(attachment.kind || "attachment")}">
      <div class="cgo-attachment-icon" aria-hidden="true">${escapeHtml(icon)}</div>
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

  async function exportCurrentConversationAsZip(exportButton) {
    if (typeof JSZip === "undefined") {
      throw new Error("JSZip is not loaded");
    }

    const conversationId = getConversationIdFromLocation();
    if (!conversationId) {
      throw new Error("conversationId not found");
    }

    const conversationData = await getConversationFromCache();
    if (!conversationData) {
      throw new Error("conversation cache not found");
    }

    const mapping = conversationData.mapping || {};
    const currentNode = conversationData.current_node || null;

    const chain = buildExportChain(mapping, currentNode);
    const baseMessages = normalizeMessagesForExport(chain, mapping);
    const domAssets = buildDomAssetMap();
    const messages = mergeMessagesWithDomAssets(baseMessages, domAssets);
    const authorization = await getLastAuthorizationFromPage();
    const highlightJsContent = await loadExtensionTextFile("vendor/highlight.min.js");
    const highlightCssContent = await loadExtensionTextFile("vendor/github-dark.min.css");

    await resolveImageUrlsWithDownloadApi(
      messages,
      conversationId,
      authorization,
      ({ done, total }) => {
        if (total > 0 && exportButton) {
          setToolbarButtonText(exportButton, t("export_resolving_progress", [done, total]));
        }
      },
      3
    );

    await resolveAttachmentUrlsWithDownloadApi(
      messages,
      conversationId,
      authorization,
      ({ done, total }) => {
        if (total > 0 && exportButton) {
          setToolbarButtonText(exportButton, t("export_resolving_attachments_progress", [done, total]));
        }
      },
      3
    );

    const zip = new JSZip();

    await saveImagesToZip(
      messages,
      zip,
      ({ done, total }) => {
        if (total > 0 && exportButton) {
          setToolbarButtonText(exportButton, t("export_zip_progress", [done, total]));
        }
      },
      3
    );

    await saveAttachmentsToZip(
      messages,
      zip,
      ({ done, total }) => {
        if (total > 0 && exportButton) {
          setToolbarButtonText(exportButton, t("export_zip_attachments_progress", [done, total]));
        }
      },
      3,
      10 * 1024 * 1024
    );

    const title =
      conversationData?.title ||
      document.title.replace(/\s*-\s*ChatGPT\s*$/i, "") ||
      "ChatGPT Conversation";

    const html = buildConversationExportHtml(
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
  }

  function mergeMessagesWithDomAssets(messages, domAssets) {
    const merged = messages.map((message) => ({
      ...message,
      images: [],
      attachments: [],
      imagePrompts: [],
    }));

    const { byMessageId, anonymous } = buildAssistantDomImagePools(domAssets);
    const domImageUrlIndex = buildDomImageUrlIndex(domAssets);
    let anonymousIndex = anonymous.length - 1;

    for (let i = merged.length - 1; i >= 0; i--) {
      const message = merged[i];
      const isImageMessage = isImageCandidateMessage(message);

      let collectedImages = [];
      let collectedPrompts = [];
      let matchedDomAsset = null;

      // 1) user 添付画像
      if (
        message.role === "user" &&
        isNonEmptyArray(message.rawMessage?.content?.parts)
      ) {
        const userImages = extractUserImagesFromMessage(message.rawMessage);

        for (const image of userImages) {
          if (image.fileId) {
            const domUrl = domImageUrlIndex.get(image.fileId);
            if (domUrl) {
              image.url = domUrl;
              image.source = "user-asset-pointer+dom-url";
            } else {
              image.unresolved = true;
            }
          }
        }

        if (userImages.length) {
          collectedImages.push(...userImages);
        }
      }

      // 2) tool child 由来画像
      if (isImageMessage && isNonEmptyArray(message.toolMessages)) {
        const toolImages = message.toolMessages.flatMap(extractImageAssetsFromToolMessage);

        for (const image of toolImages) {
          if (
            image?.fileId &&
            image.url &&
            !/[?&]sig=/.test(image.url)
          ) {
            const domUrl = domImageUrlIndex.get(image.fileId);
            if (domUrl) {
              image.url = domUrl;
              image.source = "tool-asset-pointer+dom-url";
            } else {
              image.unresolved = true;
            }
          }
        }

        if (toolImages.length) {
          collectedImages.push(...toolImages);
        }
      }

      // 3) content_references.image_group
      if (isImageMessage && collectedImages.length === 0) {
        const contentRefImages = extractImageAssetsFromContentReferences(message.rawMessage || {});
        if (contentRefImages.length) {
          collectedImages.push(...contentRefImages);
        }
      }

      // 4) rawMessage からの汎用復元
      if (isImageMessage && collectedImages.length === 0) {
        const dataImages = extractImageAssetsFromMessageData(message.rawMessage || null);
        if (dataImages.length) {
          collectedImages.push(...dataImages);
        }
      }

      // 5) prompt / hint は画像があっても併記
      if (isImageMessage) {
        const promptHints = extractPromptHintsFromMessage(message);
        if (promptHints.length) {
          collectedPrompts.push(...promptHints);
        }

        // content_references 由来画像の hint も prompt に反映
        for (const image of collectedImages) {
          if (image?.hint && !collectedPrompts.some((p) => p.text === image.hint)) {
            collectedPrompts.push({
              text: image.hint,
              source: "content-reference-image-group",
            });
          }
        }
      }

      // 6) DOM fallback
      if (isImageMessage && message.role === "assistant" && collectedImages.length === 0) {
        const candidateIds = [
          ...getToolMessageIds(message),
          message.id,
        ];

        for (const candidateId of candidateIds) {
          const asset = byMessageId.get(candidateId);
          if (asset) {
            matchedDomAsset = asset;
            byMessageId.delete(candidateId);
            break;
          }
        }

        if (!matchedDomAsset && anonymousIndex >= 0) {
          matchedDomAsset = anonymous[anonymousIndex];
          anonymousIndex -= 1;
        }

        if (matchedDomAsset) {
          collectedImages.push(...(matchedDomAsset.images || []));
          if (isNonEmptyArray(matchedDomAsset.attachments)) {
            message.attachments = [...matchedDomAsset.attachments];
          }
        }
      }

      //message.images = dedupeImages(collectedImages);
      const dataImages = Array.isArray(message.dataImages) ? message.dataImages : [];
      message.images = mergeImageListsPreferData(
        dataImages,
        dedupeImages(collectedImages)
      );
      message.imagePrompts = collectedPrompts;

      const dataAttachments = extractAttachmentsFromMessageData(message.rawMessage || {});
      const metadataAttachments = extractAttachmentsFromMetadataAttachments(message.rawMessage || {});
      const sandboxAttachments = extractSandboxArtifacts(message.text || "");
      const mergedAttachments = dedupeAttachments([
        ...(message.attachments || []),
        ...dataAttachments,
        ...metadataAttachments,
        ...sandboxAttachments,
      ]);

      message.attachments = mergedAttachments;

      log("[export] merge message", {
        id: message.id,
        role: message.role,
        isImageMessage,
        toolMessageIds: getToolMessageIds(message),
        matchedDomMessageId: matchedDomAsset?.messageId || null,
        imageCount: message.images.length,
        attachmentCount: message.attachments.length,
        imageSources: message.images.map((img) => img.source),
        promptCount: message.imagePrompts.length,
        anonymousIndexAfter: anonymousIndex,
      });
    }

    return merged;
  }


  function renderImagePrompts(imagePrompts) {
    if (!Array.isArray(imagePrompts) || imagePrompts.length === 0) return "";

    return imagePrompts
      .map((item) => {
        const text = escapeHtml(item?.text || "");
        if (!text) return "";

        return `<div class="cgo-image-hint">
        <div class="cgo-image-hint-label">${escapeHtml(t("image_prompt_label"))}</div>
        <div class="cgo-image-hint-text">${text}</div>
      </div>`;
      })
      .join("\n");
  }

  /*  function renderImageMeta(image) {
      const parts = [];
  
      if (image.width && image.height) {
        parts.push(`${image.width}×${image.height}`);
      }
  
      if (image.fileSizeBytes) {
        parts.push(formatBytes(image.fileSizeBytes));
      }
  
      if (image.mimeType) {
        parts.push(image.mimeType);
      }
  
      if (parts.length === 0) return "";
      return `<div class="cgo-image-meta">${escapeHtml(parts.join(" · "))}</div>`;
    }*/

  function renderSingleImageFigure(image, options = {}) {
    const mode = options.mode || "html"; // "html" | "zip"
    const alt = escapeHtml(image.alt || "");
    const caption = escapeHtml(image.alt || image.title || "");
    const sourceLink = renderImageSourceLink(image);
    const skipLabel = getImageSkipLabel(image);
    const isExternal = isProbablyExternalImage(image);

    // ZIP内ローカル画像
    if (mode === "zip" && image.localPath) {
      return `<figure class="cgo-image${isExternal ? " cgo-image-external" : ""}">
      <img src="${escapeHtml(image.localPath)}" alt="${alt}">
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
      <img src="${escapeHtml(image.url)}" loading="lazy" referrerpolicy="no-referrer">
      ${renderImageMeta(image)}
      ${sourceLink}
    </figure>`;
    }

    // HTML側で未埋め込みだが内部URLが生きている場合
    if (mode === "html" && image.url && !image.unresolved && !isExternal) {
      return `<figure class="cgo-image">
      <img src="${escapeHtml(image.url)}" alt="${alt}">
      ${caption ? `<figcaption>${caption}</figcaption>` : ""}
      ${renderImageMeta(image)}
      ${sourceLink}
    </figure>`;
    }

    // fallback
    return `<figure class="cgo-image cgo-image-missing${isExternal ? " cgo-image-external" : ""}">
    <div class="cgo-image-missing-box">${escapeHtml(t("image_unavailable_label"))}</div>
    <figcaption>
      ${caption || escapeHtml(t("generated_image_present_label"))}
      ${skipLabel ? `<div class="cgo-image-skip">${escapeHtml(skipLabel)}</div>` : ""}
    </figcaption>
    ${sourceLink}
  </figure>`;
  }

  /*  function renderImages(images) {
      if (!Array.isArray(images) || images.length === 0) return "";
   
      const items = images.map((image) => {
        const alt = escapeHtml(image.alt || "");
        const caption = escapeHtml(image.alt || image.title || "");
        const sourceLink = renderImageSourceLink(image);
        const skipLabel = getImageSkipLabel(image);
   
        // 1) 埋め込み済み
        if (image.embeddedUrl) {
          return `<figure class="cgo-image">
          <img src="${image.embeddedUrl}" alt="${alt}">
          ${caption ? `<figcaption>${caption}</figcaption>` : ""}
          ${sourceLink}
        </figure>`;
        }
   
        // 2) 外部参照画像はオンラインURLのまま表示
        if (image.url && !image.unresolved && isProbablyExternalImage(image)) {
          return `<figure class="cgo-image cgo-image-external">
          <img src="${escapeHtml(image.url)}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer">
          ${caption ? `<figcaption>${caption}</figcaption>` : ""}
          ${sourceLink}
        </figure>`;
        }
   
        // 3) 通常URL
        if (image.url && !image.unresolved) {
          return `<figure class="cgo-image">
          <img src="${escapeHtml(image.url)}" alt="${alt}">
          ${caption ? `<figcaption>${caption}</figcaption>` : ""}
          ${sourceLink}
        </figure>`;
        }
   
        // 4) fallback
        return `<figure class="cgo-image cgo-image-missing">
        <div class="cgo-image-missing-box">${escapeHtml(t("image_unavailable_label"))}</div>
        <figcaption>
          ${caption || escapeHtml(t("generated_image_present_label"))}
          ${skipLabel ? `<div class="cgo-image-skip">${escapeHtml(skipLabel)}</div>` : ""}
        </figcaption>
        ${sourceLink}
      </figure>`;
      });
   
      return `<div class="cgo-images">${items.join("\n")}</div>`;
    }*/
  function renderImages(images) {
    if (!Array.isArray(images) || images.length === 0) return "";

    const internalItems = [];
    const externalItems = [];

    for (const image of images) {
      const html = renderSingleImageFigure(image, { mode: "html" });

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

  async function loadExtensionTextFile(path) {
    const url = chrome.runtime.getURL(path);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load ${path}`);
    return res.text();
  }

  async function getHighlightAssets() {
    const [js, css] = await Promise.all([
      loadExtensionTextFile("vendor/highlight.min.js"),
      loadExtensionTextFile("vendor/github-dark.min.css"),
    ]);
    return { js, css };
  }

  /*  function escapeHtml(text) {
      return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }*/

  function stripChatgptUiArtifacts(text) {
    if (!text) return "";

    return text
      // ChatGPT rich UI markers
      // 例:  /  / 
      .replace(/\uE200[\s\S]*?\uE201/g, "")

      // まれに残る不要な空行を整理
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function postProcessRenderedMarkdown(containerHtml) {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = containerHtml;

    for (const a of wrapper.querySelectorAll("a")) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    }

    return wrapper.innerHTML;
  }

  /*  function getMarkedTextValue(value) {
      if (typeof value === "string") return value;
      if (value && typeof value === "object") {
        if (typeof value.text === "string") return value.text;
        if (typeof value.raw === "string") return value.raw;
        if (typeof value.lang === "string") return value.lang;
      }
      return String(value ?? "");
    }*/

  /*  function createMarkedRenderer(options = {}) {
      const interactiveCode = options.interactiveCode !== false;
  
      const renderer = new marked.Renderer();
  
      renderer.code = function (codeOrToken, maybeLang) {
        let codeText = "";
        let langText = "";
  
        if (codeOrToken && typeof codeOrToken === "object") {
          codeText =
            typeof codeOrToken.text === "string" ? codeOrToken.text :
              typeof codeOrToken.raw === "string" ? codeOrToken.raw :
                "";
  
          langText =
            typeof codeOrToken.lang === "string" ? codeOrToken.lang :
              "";
        } else {
          codeText = getMarkedTextValue(codeOrToken);
          langText = getMarkedTextValue(maybeLang).trim();
        }
  
        const unescaped = unescapeHtml(codeText);
        const safe = escapeHtml(unescaped);
        const cls = langText ? ` language-${escapeHtml(langText)}` : "";
        const lineCount = unescaped.split("\n").length;
        const collapsible = interactiveCode && lineCount > 18;
  
        if (!interactiveCode) {
          return `
  <div class="cgo-code-block">
    <div class="cgo-code-toolbar">
      <span class="cgo-code-lang">${escapeHtml(langText || "text")}</span>
    </div>
    <pre class="cgo-code-pre"><code class="cgo-code${cls}">${safe}</code></pre>
  </div>`;
        }
  
        return `
  <div class="cgo-code-block${collapsible ? " is-collapsible is-collapsed" : ""}">
    <div class="cgo-code-toolbar">
      <span class="cgo-code-lang">${escapeHtml(langText || "text")}</span>
      <div class="cgo-code-actions">
        ${collapsible ? `<button type="button" class="cgo-code-toggle-btn">${escapeHtml(t("expand_code_button"))}</button>` : ""}
        <button type="button" class="cgo-code-copy-btn">${escapeHtml(t("copy_button"))}</button>
      </div>
    </div>
    <pre class="cgo-code-pre"><code class="cgo-code${cls}">${safe}</code></pre>
  </div>`;
      };
  
      renderer.codespan = function (codeOrToken) {
        const codeText = getMarkedTextValue(codeOrToken);
        const unescaped = unescapeHtml(codeText);
        const safe = escapeHtml(unescaped);
        return `<code>${safe}</code>`;
      };
  
      return renderer;
    }*/

  /*  function renderMessageTextToHtml(text, options = {}) {
      const source = typeof text === "string" ? text : "";
      if (!source.trim()) return "";
  
      const escapedSrc = escapeHtml(stripChatgptUiArtifacts(source));
  
      if (typeof marked !== "undefined") {
        const renderer = createMarkedRenderer(options);
  
        const rawHtml = marked.parse(escapedSrc, {
          breaks: true,
          gfm: true,
          renderer,
        });
  
        const safeHtml =
          typeof DOMPurify !== "undefined"
            ? DOMPurify.sanitize(rawHtml, {
              USE_PROFILES: { html: true },
              FORBID_TAGS: ["style", "script", "iframe", "object", "embed"],
              FORBID_ATTR: ["style", "onerror", "onclick", "onload"],
            })
            : rawHtml;
  
        return `<div class="cgo-markdown">${postProcessRenderedMarkdown(safeHtml)}</div>`;
      } else {
  
        return `<div class="cgo-markdown"><p>${escapedSrc.replace(/\n/g, "<br>")}</p></div>`;
      }
    }*/

  function formatExportDate(value) {
    if (!value) return "";
    try {
      return new Date(value * 1000).toLocaleString();
    } catch {
      return "";
    }
  }

  /*  function getRawMessageText(message) {
      const parts = Array.isArray(message?.content?.parts)
        ? message.content.parts.filter((v) => typeof v === "string")
        : [];
      return parts.join("\n").trim();
    }*/

  function buildExportCss() {
    return `
:root {
  color-scheme: light dark;
}
body {
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    "Helvetica Neue",
    Arial,
    sans-serif,
    "Apple Color Emoji",
    "Segoe UI Emoji",
    "Segoe UI Symbol",
    "Noto Color Emoji";
  max-width: 980px;
  margin: 0 auto;
  padding: 32px 20px 64px;
  line-height: 1.65;
  background: #ffffff;
  color: #111827;
}
.page-header {
  margin-bottom: 28px;
  padding-bottom: 16px;
  border-bottom: 1px solid #d1d5db;
}
.page-title {
  margin: 0 0 8px;
  font-size: 1.8rem;
  line-height: 1.25;
}
.page-meta {
  font-size: 0.95rem;
  color: #6b7280;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.message {
  margin: 0 0 28px;
  padding: 16px 18px;
  border-radius: 14px;
  border: 1px solid #e5e7eb;
  background: #fafafa;
}
.message.user {
  background: #eff6ff;
  border-color: #bfdbfe;
}
.message.assistant {
  background: #f0fdf4;
  border-color: #bbf7d0;
}
.message-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  font-size: 0.95rem;
}
.message-role {
  font-weight: 700;
  text-transform: capitalize;
}
.message-date {
  color: #6b7280;
  white-space: nowrap;
}
.message-body {
  overflow-wrap: anywhere;
}
.code-block {
  margin: 12px 0;
}
.code-lang {
  font-size: 0.85rem;
  color: #6b7280;
  margin-bottom: 6px;
}
pre {
  margin: 0;
  padding: 14px 16px;
  overflow: auto;
  border-radius: 10px;
  background: #111827;
  color: #f9fafb;
  line-height: 1.5;
}
code {
  font-family:
    ui-monospace,
    SFMono-Regular,
    Menlo,
    Consolas,
    "Liberation Mono",
    monospace;
  font-size: 0.92rem;
}
.cgo-images {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cgo-image img {
  display: block;
  max-width: min(100%, 560px);
  height: auto;
  border-radius: 10px;
  border: 1px solid #d1d5db;
}
.cgo-image figcaption {
  margin-top: 6px;
  font-size: 0.9rem;
  color: #6b7280;
}
.cgo-image-hint {
  margin-top: 10px;
  padding: 12px 14px;
  border: 1px dashed #9ca3af;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.03);
}
.cgo-image-hint-label {
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 4px;
  color: #6b7280;
}
.cgo-image-hint-text {
  font-size: 0.95rem;
}
.cgo-attachments {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px dashed #d1d5db;
  font-size: 0.95rem;
}
.cgo-attachments-title {
  font-weight: 600;
  margin-bottom: 6px;
}
.cgo-attachments ul {
  margin: 0;
  padding-left: 20px;
}
.cgo-markdown > :first-child {
  margin-top: 0;
}
.cgo-markdown > :last-child {
  margin-bottom: 0;
}
.cgo-markdown p {
  margin: 0 0 1em;
}
.cgo-markdown h1,
.cgo-markdown h2,
.cgo-markdown h3,
.cgo-markdown h4,
.cgo-markdown h5,
.cgo-markdown h6 {
  margin: 1.2em 0 0.6em;
  line-height: 1.3;
}
.cgo-markdown ul,
.cgo-markdown ol {
  margin: 0 0 1em 1.4em;
}
.cgo-markdown li + li {
  margin-top: 0.25em;
}
.cgo-markdown blockquote {
  margin: 1em 0;
  padding: 0.1em 0 0.1em 1em;
  border-left: 4px solid #9ca3af;
  color: #4b5563;
}
.cgo-markdown pre {
  margin: 1em 0;
}
.cgo-markdown code {
  font-family:
    ui-monospace,
    SFMono-Regular,
    Menlo,
    Consolas,
    "Liberation Mono",
    monospace;
}
.cgo-markdown :not(pre) > code {
  padding: 0.15em 0.4em;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.08);
  font-size: 0.92em;
}
.cgo-markdown a {
  color: #2563eb;
  text-decoration: underline;
}
.cgo-markdown hr {
  border: 0;
  border-top: 1px solid #d1d5db;
  margin: 1.25em 0;
}
.cgo-image-missing-box {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  max-width: min(100%, 560px);
  padding: 16px;
  border: 1px dashed #9ca3af;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.03);
  color: #6b7280;
  font-size: 0.95rem;
}
.cgo-image-source {
  margin-top: 6px;
  font-size: 0.9rem;
  opacity: 0.9;
}
.cgo-image-source a {
  color: inherit;
  text-decoration: underline;
}
.cgo-image-external img {
  cursor: zoom-in;
}
.cgo-attachments {
  margin-top: 12px;
  display: grid;
  gap: 10px;
}
.cgo-attachment {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 10px;
}
.cgo-attachment-name {
  font-weight: 600;
  word-break: break-word;
}
.cgo-attachment-meta {
  margin-top: 4px;
  font-size: 0.9rem;
  opacity: 0.8;
}
.cgo-attachment-actions {
  flex: 0 0 auto;
  font-size: 0.95rem;
}
.cgo-attachments {
  margin-top: 12px;
  display: grid;
  gap: 10px;
}
.cgo-attachment {
  display: grid;
  grid-template-columns: 32px 1fr auto;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 10px;
}
.cgo-attachment-icon {
  font-size: 1.2rem;
  line-height: 1;
  text-align: center;
}
.cgo-attachment-name {
  font-weight: 600;
  word-break: break-word;
}
.cgo-attachment-meta {
  margin-top: 4px;
  font-size: 0.9rem;
  opacity: 0.8;
}
.cgo-attachment-actions {
  flex: 0 0 auto;
  font-size: 0.95rem;
  white-space: nowrap;
}
.cgo-image-skip {
  margin-top: 6px;
  color: #ffb020;
  font-size: 0.9rem;
  font-weight: 500;
}
.cgo-code-block {
  margin: 16px 0;
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 12px;
  overflow: hidden;
  background: rgba(0,0,0,0.18);
}

.cgo-code-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  font-size: 12px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  background: rgba(255,255,255,0.04);
}

.cgo-code-lang {
  opacity: 0.85;
  font-weight: 600;
}

.cgo-code-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.cgo-code-copy-btn,
.cgo-code-toggle-btn {
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 8px;
  font: inherit;
}

.cgo-code-copy-btn:hover,
.cgo-code-toggle-btn:hover {
  background: rgba(255,255,255,0.08);
}

.cgo-code-pre {
  margin: 0;
  padding: 12px 14px;
  overflow: auto;
}

.cgo-code-pre code {
  white-space: pre;
  display: block;
}

.cgo-code-block.is-collapsed .cgo-code-pre {
  max-height: 280px;
  overflow: hidden;
  position: relative;
}

.cgo-code-block.is-collapsed .cgo-code-pre::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 56px;
  background: linear-gradient(to bottom, rgba(0,0,0,0), rgba(0,0,0,0.45));
  pointer-events: none;
}
.cgo-images {
  margin-top: 12px;
}

.cgo-images-internal {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
}

.cgo-images-external {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin-top: 12px;
}

@media (min-width: 900px) {
  .cgo-images-external {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

.cgo-image {
  margin: 0;
}

.cgo-images-external .cgo-image-external img {
  aspect-ratio: 1 / 1;
  object-fit: contain;
  background: rgba(255,255,255,0.04);
}

.cgo-image figcaption {
  margin-top: 6px;
  font-size: 0.9rem;
  line-height: 1.4;
}

.cgo-image-source {
  margin-top: 4px;
  font-size: 0.85rem;
}

.cgo-image-meta {
  margin-top: 6px;
  font-size: 0.8rem;
  line-height: 1.3;
  opacity: 0.72;
  word-break: break-all;
}

@media (prefers-color-scheme: dark) {
  body {
    background: #0b1020;
    color: #e5e7eb;
  }
  .page-header {
    border-bottom-color: #374151;
  }
  .page-meta,
  .message-date,
  .code-lang,
  .cgo-image figcaption,
  .cgo-image-hint-label {
    color: #9ca3af;
  }
  .message {
    background: #111827;
    border-color: #374151;
  }
  .message.user {
    background: #0f172a;
    border-color: #1d4ed8;
  }
  .message.assistant {
    background: #052e16;
    border-color: #15803d;
  }
  .cgo-image img {
    border-color: #374151;
  }
  .cgo-image-hint {
    border-color: #4b5563;
    background: rgba(255, 255, 255, 0.04);
  }
  .cgo-attachments {
    border-top-color: #4b5563;
  }
  .cgo-markdown blockquote {
    border-left-color: #4b5563;
    color: #9ca3af;
  }

  .cgo-markdown :not(pre) > code {
    background: rgba(255, 255, 255, 0.08);
  }

  .cgo-markdown a {
    color: #60a5fa;
  }

  .cgo-markdown hr {
    border-top-color: #374151;
  }
  .cgo-image-missing-box {
    border-color: #4b5563;
    background: rgba(255, 255, 255, 0.04);
    color: #9ca3af;
  }
}
    `
  }

  function getCodeEnhancementScript() {
    return `
<script>
(function () {
  document.addEventListener("click", async function (event) {
    const copyBtn = event.target.closest(".cgo-code-copy-btn");
    if (copyBtn) {
      const block = copyBtn.closest(".cgo-code-block");
      const codeEl = block?.querySelector("code");
      if (!codeEl) return;

      const text = codeEl.textContent || "";
      const oldText = copyBtn.textContent;

      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = "Copied";
      } catch (_) {
        copyBtn.textContent = "Failed";
      }

      setTimeout(() => {
        copyBtn.textContent = oldText;
      }, 1200);

      return;
    }

    const toggleBtn = event.target.closest(".cgo-code-toggle-btn");
    if (toggleBtn) {
      const block = toggleBtn.closest(".cgo-code-block");
      if (!block) return;

      const collapsed = block.classList.toggle("is-collapsed");
      toggleBtn.textContent = collapsed ? "${t('expand_code_button')}" : "${t('collapse_code_button')}";
    }
  });

  // ===== lazy highlight =====
  function initLazyHighlight() {
    if (!window.hljs) return;

    const blocks = document.querySelectorAll("pre code");

    // IntersectionObserver 非対応なら即実行
    if (!("IntersectionObserver" in window)) {
      blocks.forEach(el => {
        try { window.hljs.highlightElement(el); } catch(_) {}
      });
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;

        const el = entry.target;

        if (el.dataset.hl === "1") {
          observer.unobserve(el);
          continue;
        }

        try {
          window.hljs.highlightElement(el);
          el.dataset.hl = "1";
        } catch (_) {}

        observer.unobserve(el);
      }
    }, {
      rootMargin: "200px 0px", // 先読み
      threshold: 0.01,
    });

    blocks.forEach(el => observer.observe(el));
  }

  // ===== hljsロード待ち =====
  function waitForHljs() {
    if (window.hljs) {
      initLazyHighlight();
      return;
    }
    setTimeout(waitForHljs, 50);
  }

  waitForHljs();
})();
</script>`;
  }

  function buildConversationExportHtml(title, conversationId, messages, options = {}) {
    const imageRenderer = options.imageRenderer || renderImages;
    const attachmentRenderer = options.attachmentRenderer || renderAttachments;
    const interactiveCode = options.interactiveCode !== false;
    const highlightAssets = options.highlightAssets || null;
    const highlightAttach = options.highlightAttach || false;

    const messageHtml = messages.map((message) => {
      const roleLabel = message.role === "user" ? t("role_user") : t("role_assistant");
      const dateText = formatExportDate(message.createTime);
      const bodyHtml = CGO.renderMessageTextToHtml(message.text, { interactiveCode });

      return `
<section class="message ${escapeHtml(message.role)}" id="mes-${escapeHtml(message.id)}">
  <div class="message-header">
    <span class="message-role">${escapeHtml(roleLabel)}</span>
    <span class="message-date">${escapeHtml(dateText)}</span>
  </div>
  <div class="message-body">
    ${bodyHtml}
    ${imageRenderer(message.images || [])}
    ${renderImagePrompts(message.imagePrompts || [])}
    ${attachmentRenderer(message.attachments || [])}
  </div>
</section>`;
    }).join("\n");

    return `<!doctype html>
<html lang="${escapeHtml(DETECTION_LANG)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    ${buildExportCss()}
    ${highlightAssets?.css || ""}
  </style>
  <link rel="icon" type="image/vnd.microsoft.icon" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAdklEQVR4nGPkFxT9z0ABYKJEMwMDAwMLjKFrYEaSxssXThHngsMTf+OVp9gLeA0gZDvRLjg88TdOw3AagK7BNp+VNANs81nhmnBpxmsANleQbAAh2/EacHjib4KaGRgYGBhx5QVdAzN4aiPLBcQCnC4gFlDsAgAEZB4LCldHoQAAAABJRU5ErkJggg==">
</head>
<body>
  <header class="page-header">
    <h1 class="page-title">${escapeHtml(title || t("untitled_conversation"))}</h1>
    <div class="page-meta">
      <span>${escapeHtml(t("conversation_id"))}: ${escapeHtml(conversationId || "")}</span>
      <span>${escapeHtml(t("exported_at"))}: ${escapeHtml(new Date().toLocaleString())}</span>
    </div>
    ${highlightAttach ? `
    <link rel="stylesheet" href="assets/github-dark.min.css">
    <script src="assets/highlight.min.js"></script>` : ""}
  </header>
  ${messageHtml}
  ${interactiveCode ? getCodeEnhancementScript() : ""}
  ${interactiveCode && highlightAssets?.js
        ? `<script>${highlightAssets.js}</script>`
        : ""}
</body>
</html>`;
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

  function getCurrentVisibleMessageId() {
    const turns = Array.from(document.querySelectorAll("section"));
    if (turns.length === 0) return "";

    const viewportCenter = window.innerHeight / 2;
    let bestEl = null;
    let bestDistance = Infinity;

    for (const el of turns) {
      const rect = el.getBoundingClientRect();
      const center = rect.top + rect.height / 2;
      const distance = Math.abs(center - viewportCenter);

      if (distance < bestDistance) {
        bestDistance = distance;
        bestEl = el;
      }
    }

    return bestEl ? bestEl.dataset.turnId || "" : "";
  }

  async function exportCurrentConversationAsHtml(button, action = "download") {
    try {
      const conversationId = getConversationIdFromLocation();
      if (!conversationId) {
        throw new Error("conversationId not found");
      }
      const conversationData = await getConversationFromCache();
      if (!conversationData) {
        throw new Error("conversation cache not found");
      }
      const mapping = conversationData?.mapping || {};
      const currentNode = conversationData?.current_node || null;

      if (!currentNode || !mapping[currentNode]) {
        throw new Error("Current conversation node not found.");
      }
      const isLightweight = action !== "download";

      const chain = buildExportChain(mapping, currentNode);
      const baseMessages = normalizeMessagesForExport(chain, mapping);
      const domAssets = buildDomAssetMap();
      const messages = mergeMessagesWithDomAssets(baseMessages, domAssets);
      const authorization = await getLastAuthorizationFromPage();

      if (!isLightweight) {
        // まず cache 優先 + 無い分だけ API
        await resolveImageUrlsWithDownloadApi(
          messages,
          conversationId,
          authorization,
          ({ done, total }) => {
            if (total > 0) {
              setToolbarButtonText(button, t("export_resolving_progress", [done, total]));
            }
          },
          3
        );


        // 画像埋め込み
        await embedImagesInMessages(
          messages,
          ({ done, total }) => {
            if (total > 0) {
              setToolbarButtonText(button, t("export_progress", [done, total]));
            }
          },
          3
        );
      }

      log("[export] counts", {
        chain: chain.length,
        baseMessages: baseMessages.length,
        domAssets: domAssets.length,
        merged: messages.length,
      });

      const title =
        conversationData?.title ||
        document.title.replace(/\s*-\s*ChatGPT\s*$/i, "") ||
        "ChatGPT Conversation";

      const highlightAssets = !isLightweight
        ? await getHighlightAssets()
        : null;

      const html = buildConversationExportHtml(
        title,
        conversationId,
        messages,
        {
          lightweight: isLightweight,
          interactiveCode: !isLightweight,
          highlightAssets,
        }
      );

      if (action == "download") {
        downloadTextFile(buildSafeFilename(title, "html"), html, "text/html;charset=utf-8");
      } else {
        openHtmlInNewTab(html, action)
      }

      log("[export] HTML exported", {
        title,
        messages: messages.length,
      });
    } catch (error) {
      log("[export:error] failed", error);
      alert(`${t("export_failed")}: ${error.message}`);
    }
  }

  /*  function createHeaderButton(html, text, callback) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cgo-btn";
      button.title = text
      button.ariaLabel = text
      button.innerHTML = html;
   
      button.addEventListener("click", callback);
   
      return button;
    }*/
  function createSvgIcon(pathD, viewBox = "0 0 24 24") {
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", viewBox);
    svg.setAttribute("aria-hidden", "true");

    const path = document.createElementNS(svgNS, "path");
    path.setAttribute("d", pathD);
    path.setAttribute("fill", "currentColor");

    svg.appendChild(path);
    return svg;
  }

  function getButtonIconSvg(kind) {
    switch (kind) {
      case "light":
        return createSvgIcon("M13 2L6 14h5l-1 8 8-12h-5l1-8z");
      case "html":
        return createSvgIcon("M6 2h9l5 5v15a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm8 1.5V8h4.5", "0 0 24 24");
      case "zip":
        return createSvgIcon("M12 3v10.17l3.59-3.58L17 11l-5 5-5-5 1.41-1.41L11 13.17V3h1zM5 19h14v2H5z");
      default:
        return createSvgIcon("M12 3v18M3 12h18");
    }
  }

  function buildToolbarButton({ title, iconKind }) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cgo-btn";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.dataset.iconKind = iconKind;

    const iconWrap = document.createElement("span");
    iconWrap.className = "cgo-btn-icon";
    iconWrap.appendChild(getButtonIconSvg(iconKind));

    const labelWrap = document.createElement("span");
    labelWrap.className = "cgo-btn-label";
    labelWrap.hidden = true;

    button.appendChild(iconWrap);
    button.appendChild(labelWrap);

    return button;
  }

  function setToolbarButtonText(button, text = "") {
    const icon = button.querySelector(".cgo-btn-icon");
    const label = button.querySelector(".cgo-btn-label");
    if (!icon || !label) return;

    if (text) {
      //icon.hidden = true;
      label.hidden = false;
      label.textContent = text;
    } else {
      label.textContent = "";
      label.hidden = true;
      //icon.hidden = false;
    }
  }

  function createOpenNewTabButton() {
    const button = buildToolbarButton({
      title: t("open_new_tab_button"),
      iconKind: "light",
    });

    button.addEventListener("click", async () => {
      try {
        setExportButtonState(button, "loading");
        await exportCurrentConversationAsHtml(button, getCurrentVisibleMessageId());
        setExportButtonState(button, "idle");
        setToolbarButtonText(button, "");
      } catch (error) {
        log("[error]", error);
        setExportButtonState(button, "export_retry");
      }
    });

    return button;
  }

  function createExportButton() {
    const button = buildToolbarButton({
      title: t("download_button"),
      iconKind: "html",
    });

    button.addEventListener("click", async () => {
      try {
        setExportButtonState(button, "loading");
        await exportCurrentConversationAsHtml(button);
        setExportButtonState(button, "idle");
        setToolbarButtonText(button, "");
      } catch (error) {
        log("[error]", error);
        setExportButtonState(button, "export_retry");
      }
    });

    return button;
  }

  function createZipExportButton() {
    const button = buildToolbarButton({
      title: t("zip_download_button"),
      iconKind: "zip",
    });

    button.addEventListener("click", async () => {
      try {
        setExportButtonState(button, "loading");
        await exportCurrentConversationAsZip(button);
        setExportButtonState(button, "idle");
        setToolbarButtonText(button, "");
      } catch (error) {
        log("[error]", error);
        setExportButtonState(button, "error");
      }
    });

    return button;
  }

  function injectExportButtonIntoHeader() {
    if (!location.pathname.startsWith("/c/")) return;

    if (document.querySelector("div.cgo-toolbar")) return;

    const headerActions = document.getElementById("conversation-header-actions");
    if (!headerActions) return;

    toolbarBase = document.createElement("div");
    toolbarBase.className = "cgo-toolbar";
    toolbarBase.hidden = true;

    const open_new_tab_button = createOpenNewTabButton();
    //headerActions.prepend(open_new_tab_button);
    const download_button = createExportButton();
    //headerActions.prepend(download_button);
    const zip_download_button = createZipExportButton()
    //headerActions.prepend(zip_download_button);
    toolbarBase.append(zip_download_button, download_button, open_new_tab_button)
    headerActions.prepend(toolbarBase)
  }

  function injectExportButtonStyle() {
    if (document.getElementById("cgo-export-style")) return;

    const style = document.createElement("style");
    style.id = "cgo-export-style";

    style.textContent = `
.cgo-toolbar {
  display: flex;
  gap: 6px;
  align-items: center;
}

.cgo-btn {
  position: relative;
  background: transparent;
  border: none;
  color: #d8d8d8;
  cursor: pointer;
  padding: 6px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.cgo-btn svg {
  width: 18px;
  height: 18px;
  display: block;
  flex: 0 0 auto;
}

.cgo-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: #ffffff;
}

.cgo-btn:active {
  transform: scale(0.95);
}
  `;

    document.head.appendChild(style);
  }

  function setExportButtonState(button, state) {
    if (!button) return;

    if (state === "idle") {
      button.disabled = false;
      setToolbarButtonText(button, t("download"))
    }

    if (state === "loading") {
      button.disabled = true;
      setToolbarButtonText(button, t("exporting"));
    }

    if (state === "error") {
      button.disabled = false;
      setToolbarButtonText(button, t("retry"));
    }
  }

  function startHeaderButtonObserver() {

    const observer = new MutationObserver(() => {
      injectExportButtonIntoHeader();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    injectExportButtonIntoHeader();
  }

  function updateExportButtonVisibility(state) {
    if (toolbarBase) {
      toolbarBase.hidden = !state;
    }
  }

  function onDomReady(callback) {
    if (
      document.readyState === "interactive" ||
      document.readyState === "complete"
    ) {
      callback();
      return;
    }

    window.addEventListener("DOMContentLoaded", callback, { once: true });
  }

  /*  window.addEventListener("keydown", (event) => {
      if (!location.pathname.startsWith("/c/")) return;
   
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "e") {
        event.preventDefault();
        event.stopPropagation();
        exportCurrentConversationAsHtml();
      }
    });*/
  // exporter end

  async function main() {
    observeWindowMessages();
    const ok = await ensurePageHooksInjected();
    if (!ok) {
      log("[warn] page-hook is unavailable");
    }
    onDomReady(() => {
      injectExportButtonStyle();
      startHeaderButtonObserver();
      observeRouteChanges();
      observeStreamCompletion();
      log("content initialized");
    });
  }

  injectPageBootstrapScript();
  main();
})();