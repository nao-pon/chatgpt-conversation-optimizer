(() => {
  "use strict";

  // =========================================================
  // INSTALL GUARD / CONSTANTS / CONFIG / STATE
  // =========================================================
  const PAGE_HOOK_VERSION = "2";

  if (window.__CGO_MAIN_HOOK_INSTALLED__) {
    return;
  }
  window.__CGO_MAIN_HOOK_INSTALLED__ = true;

  const CONFIG = {
    turnCount: 20,
    enablePrune: true,
    debug: true,
    rootNodeId: "client-created-root",
    targetPathFragment: "/backend-api/conversation/",
  };

  const EXPORT_CACHE = new Map();
  const STREAM_STATE = new Map();
  const FILE_DOWNLOAD_CACHE = new Map();
  let LAST_STREAM_CONVERSATION_ID = null;

  // =========================================================
  // LOGGING / POST HELPERS
  // =========================================================
  function log(...args) {
    if (!CONFIG.debug) return;
    window.postMessage(
      {
        source: "cgo-prune-runtime",
        type: "log",
        args,
      },
      "*"
    );
  }

  function postAnalysis(url, summary) {
    window.postMessage(
      {
        source: "cgo-prune-runtime",
        type: "analysis",
        url,
        summary,
      },
      "*"
    );
  }

  function postError(error) {
    window.postMessage(
      {
        source: "cgo-prune-runtime",
        type: "error",
        error: String(error),
      },
      "*"
    );
  }

  // =========================================================
  // HANDSHAKE
  // =========================================================
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;

    const data = event.data;
    if (!data || data.source !== "CGO_CONTENT") return;

    if (data.type === "CGO_PING") {
      window.postMessage(
        {
          source: "CGO_PAGE",
          type: "CGO_PONG",
          version: PAGE_HOOK_VERSION,
          mainHook: true
        },
        "*"
      );
    }
  });

  // =========================================================
  // SMALL HELPERS
  // =========================================================
  function getMapping(data) {
    return data?.mapping && typeof data.mapping === "object" ? data.mapping : {};
  }

  function getCurrentNode(data) {
    return data?.current_node || null;
  }

  function hasMessage(node) {
    return !!node?.message;
  }

  function getRole(node) {
    return node?.message?.author?.role || null;
  }

  function getTextLength(node) {
    const parts = node?.message?.content?.parts;
    if (!Array.isArray(parts)) return 0;
    return parts.filter((v) => typeof v === "string").join("\n").length;
  }

  function isMeaningfulConversationNode(node) {
    if (!hasMessage(node)) return false;

    const role = getRole(node);
    if (role === "user") return true;
    if (role === "assistant" && getTextLength(node) > 0) return true;

    return false;
  }

  function getRequestUrl(input) {
    if (typeof input === "string") return input;
    if (input instanceof Request) return input.url;
    return String(input || "");
  }

  function isTargetConversationRequest(url) {
    try {
      const u = new URL(url, location.origin);
      return /^\/backend-api\/conversation\/[a-z0-9-]+$/i.test(u.pathname);
    } catch {
      return false;
    }
  }

  function isStreamingConversationRequest(url) {
    try {
      const u = new URL(url, location.origin);
      return u.pathname === "/backend-api/f/conversation";
    } catch {
      return false;
    }
  }

  function isFullConversationPayload(data) {
    return !!(
      data &&
      typeof data === "object" &&
      data.conversation_id &&
      data.current_node &&
      data.mapping &&
      typeof data.mapping === "object"
    );
  }

  function buildResponseFromJson(originalResponse, jsonData) {
    const headers = new Headers(originalResponse.headers);
    headers.set("content-type", "application/json; charset=utf-8");
    headers.delete("content-length");

    return new Response(JSON.stringify(jsonData), {
      status: originalResponse.status,
      statusText: originalResponse.statusText,
      headers,
    });
  }

  function getFileDownloadCacheKey(fileId, conversationId) {
    if (!fileId || !conversationId) return "";
    return `${conversationId}:${fileId}`;
  }

  function isFileDownloadRequest(url) {
    try {
      const u = new URL(url, location.origin);
      return /^\/backend-api\/files\/download\/file_[A-Za-z0-9]+$/i.test(u.pathname);
    } catch {
      return false;
    }
  }

  function extractFileIdAndConversationIdFromDownloadUrl(url) {
    try {
      const u = new URL(url, location.origin);
      const match = u.pathname.match(/\/backend-api\/files\/download\/(file_[A-Za-z0-9]+)/i);
      return {
        fileId: match ? match[1] : "",
        conversationId: u.searchParams.get("conversation_id") || "",
      };
    } catch {
      return {
        fileId: "",
        conversationId: "",
      };
    }
  }

  // =========================================================
  // ANALYZE / PRUNE HELPERS
  // =========================================================
  function buildLinearChain(mapping, currentNode) {
    const chain = [];
    const seen = new Set();
    let cursor = currentNode;

    while (cursor && mapping[cursor] && !seen.has(cursor)) {
      seen.add(cursor);
      chain.push(cursor);
      cursor = mapping[cursor]?.parent || null;
    }

    return chain.reverse();
  }

  function getConversationalIds(mapping, chain) {
    return chain.filter((id) => isMeaningfulConversationNode(mapping[id]));
  }

  function findSafeStartIndex(mapping, chain, desiredStartIndex) {
    let startIndex = desiredStartIndex;

    while (startIndex > 0) {
      const previousId = chain[startIndex - 1];
      const previousNode = mapping[previousId];

      if (isMeaningfulConversationNode(previousNode)) {
        break;
      }

      startIndex -= 1;
    }

    return startIndex;
  }

  function pickRecentSuffixKeepSet(mapping, chain, turnCount) {
    const conversationalIndexes = [];

    for (let i = 0; i < chain.length; i++) {
      if (isMeaningfulConversationNode(mapping[chain[i]])) {
        conversationalIndexes.push(i);
      }
    }

    const keepConversationIndexes = conversationalIndexes.slice(-turnCount * 2);

    if (keepConversationIndexes.length === 0) {
      return new Set(chain.slice(-1));
    }

    const desiredStartIndex = keepConversationIndexes[0];
    const startIndex = findSafeStartIndex(mapping, chain, desiredStartIndex);

    return new Set(chain.slice(startIndex));
  }

  function expandKeepSetWithChildren(mapping, keepSet) {
    let changed = true;

    while (changed) {
      changed = false;

      for (const [id, node] of Object.entries(mapping)) {
        const parent = node?.parent;

        if (parent && keepSet.has(parent) && !keepSet.has(id)) {
          keepSet.add(id);
          changed = true;
        }
      }
    }

    return keepSet;
  }

  function summarizeKeepSet(mapping, keepSet) {
    let nodesWithMessage = 0;
    let userCount = 0;
    let assistantCount = 0;
    let systemCount = 0;

    for (const id of keepSet) {
      const node = mapping[id];
      if (!node) continue;

      if (hasMessage(node)) nodesWithMessage += 1;

      const role = getRole(node);
      if (role === "user") userCount += 1;
      else if (role === "assistant") assistantCount += 1;
      else if (role === "system" || role === "tool") systemCount += 1;
    }

    return {
      mappingCount: keepSet.size,
      nodesWithMessage,
      userCount,
      assistantCount,
      systemCount,
    };
  }

  function analyzeConversation(data, turnCount = CONFIG.turnCount) {
    const mapping = getMapping(data);
    const currentNode = getCurrentNode(data);
    const mappingKeys = Object.keys(mapping);

    if (!currentNode || !mapping[currentNode]) {
      return {
        conversationId: data?.conversation_id || null,
        title: data?.title || "",
        currentNode,
        mappingCount: mappingKeys.length,
        error: "current_node missing or not found in mapping",
      };
    }

    const chain = buildLinearChain(mapping, currentNode);
    const conversationalIds = getConversationalIds(mapping, chain);
    const recentConversationIds = conversationalIds.slice(-turnCount * 2);
    const keepSet = expandKeepSetWithChildren(mapping, pickRecentSuffixKeepSet(mapping, chain, turnCount));
    const keepSummary = summarizeKeepSet(mapping, keepSet);

    const recentConversation = recentConversationIds.map((id) => {
      const node = mapping[id];
      return {
        id,
        role: getRole(node),
        textLength: getTextLength(node),
        parent: node?.parent || null,
      };
    });

    return {
      conversationId: data?.conversation_id || null,
      title: data?.title || "",
      currentNode,
      original: {
        mappingCount: mappingKeys.length,
        chainLength: chain.length,
        conversationalLength: conversationalIds.length,
      },
      prunePlan: {
        turnCount,
        recentConversationCount: recentConversationIds.length,
        keepNodeCount: keepSet.size,
        ...keepSummary,
      },
      recentConversation,
      keepNodeIdsPreview: Array.from(keepSet).slice(0, 30),
    };
  }

  function shouldSkipPrune(summary) {
    const chainLength = summary?.original?.chainLength || 0;
    const keepNodeCount = summary?.prunePlan?.keepNodeCount || 0;

    if (!chainLength) return true;

    const keepRatio = keepNodeCount / chainLength;
    if (keepRatio > 0.8) return true;

    return false;
  }

  function lightenNode(node) {
    if (!node || typeof node !== "object") return node;

    return structuredClone(node);
  }

  function pruneConversationData(data, turnCount = CONFIG.turnCount) {
    const mapping = getMapping(data);
    const currentNode = getCurrentNode(data);

    if (!currentNode || !mapping[currentNode]) {
      return data;
    }

    const chain = buildLinearChain(mapping, currentNode);
    const keepSet = expandKeepSetWithChildren(
      mapping,
      pickRecentSuffixKeepSet(mapping, chain, turnCount)
    );

    const prunedMapping = {};
    for (const id of keepSet) {
      if (mapping[id]) {
        prunedMapping[id] = lightenNode(mapping[id]);
      }
    }

    const keptChain = chain.filter((id) => keepSet.has(id));
    const firstKeptId = keptChain[0];

    if (firstKeptId && firstKeptId !== CONFIG.rootNodeId) {
      if (mapping[CONFIG.rootNodeId]) {
        prunedMapping[CONFIG.rootNodeId] = structuredClone(mapping[CONFIG.rootNodeId]);
        prunedMapping[firstKeptId] = {
          ...prunedMapping[firstKeptId],
          parent: CONFIG.rootNodeId,
        };
      } else {
        prunedMapping[firstKeptId] = {
          ...prunedMapping[firstKeptId],
          parent: null,
        };
      }
    }

    rebuildChildren(prunedMapping);

    return {
      ...data,
      mapping: prunedMapping,
    };
  }

  function getAuthorizationFromFetchArgs(args) {
    const input = args[0];
    const init = args[1];

    if (init?.headers) {
      const headers = new Headers(init.headers);
      const auth = headers.get("authorization");
      if (auth) return auth;
    }

    if (input instanceof Request) {
      const auth = input.headers.get("authorization");
      if (auth) return auth;
    }

    return "";
  }

  function rebuildChildren(mapping) {
    for (const node of Object.values(mapping)) {
      node.children = [];
    }

    for (const [id, node] of Object.entries(mapping)) {
      const parentId = node?.parent;
      if (parentId && mapping[parentId]) {
        mapping[parentId].children.push(id);
      }
    }
  }

  // =========================================================
  // CACHE HELPERS
  // =========================================================
  function saveFullConversationToCache(data) {
    const conversationId = data?.conversation_id;
    if (!conversationId) return;

    EXPORT_CACHE.set(conversationId, structuredClone(data));
    window.__CGO_EXPORT_CACHE = true;
  }

  function ensureConversationCache(conversationId) {
    let data = EXPORT_CACHE.get(conversationId);

    if (!data) {
      data = {
        conversation_id: conversationId,
        title: "",
        current_node: null,
        mapping: {},
      };
      EXPORT_CACHE.set(conversationId, data);
    }

    return data;
  }

  function upsertMessageNode(cache, message, parentId) {
    if (!message?.id) return;

    if (!cache.mapping[message.id]) {
      cache.mapping[message.id] = {
        id: message.id,
        parent: parentId || null,
        children: [],
        message: structuredClone(message),
      };
    } else {
      cache.mapping[message.id].message = structuredClone(message);
      if (parentId !== undefined) {
        cache.mapping[message.id].parent = parentId || null;
      }
    }

    if (parentId) {
      if (!cache.mapping[parentId]) {
        cache.mapping[parentId] = {
          id: parentId,
          parent: null,
          children: [],
          message: null,
        };
      }

      const children = cache.mapping[parentId].children || [];
      if (!children.includes(message.id)) {
        children.push(message.id);
      }
      cache.mapping[parentId].children = children;
    }

    cache.current_node = message.id;
  }

  function ensureStreamState(conversationId) {
    let streamState = STREAM_STATE.get(conversationId);
    if (!streamState) {
      streamState = { currentPatchedMessageId: null };
      STREAM_STATE.set(conversationId, streamState);
    }
    return streamState;
  }

  function applyDeltaOpsToMessage(cache, messageId, ops) {
    if (!messageId) return;

    const node = cache.mapping[messageId];
    const msg = node?.message;
    if (!msg) return;

    if (!msg.content) {
      msg.content = { content_type: "text", parts: [""] };
    }

    if (!Array.isArray(msg.content.parts)) {
      msg.content.parts = [""];
    }

    for (const op of ops) {
      if (op.p === "/message/content/parts/0" && op.o === "append") {
        msg.content.parts[0] = (msg.content.parts[0] || "") + String(op.v || "");
      } else if (op.p === "/message/status" && op.o === "replace") {
        msg.status = op.v;
      } else if (op.p === "/message/end_turn" && op.o === "replace") {
        msg.end_turn = op.v;
      } else if (op.p === "/message/metadata/token_count" && op.o === "replace") {
        msg.metadata = msg.metadata || {};
        msg.metadata.token_count = op.v;
      }
    }
  }

  function saveFileDownloadResultToCache(fileId, conversationId, data) {
    const key = getFileDownloadCacheKey(fileId, conversationId);
    if (!key || !data) return;

    FILE_DOWNLOAD_CACHE.set(key, {
      downloadUrl: typeof data.download_url === "string" ? data.download_url : "",
      fileName: typeof data.file_name === "string" ? data.file_name : "",
      fileSizeBytes: Number(data.file_size_bytes || 0),
      timestamp: Date.now(),
    });
  }

  // =========================================================
  // STREAM HELPERS
  // =========================================================
  function processSseBlock(block, onEvent, streamParserState) {
    const lines = block.split("\n").filter(Boolean);
    if (!lines.length) return;

    let eventName = streamParserState.currentEventName || "message";
    const dataLines = [];

    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }

    streamParserState.currentEventName = eventName;

    for (const raw of dataLines) {
      if (!raw || raw === "[DONE]") continue;

      try {
        onEvent(eventName, JSON.parse(raw));
      } catch {
        // JSON 以外は無視
      }
    }
  }

  function getConversationIdFromSsePayload(payload) {
    return (
      payload?.conversation_id ||
      payload?.v?.conversation_id ||
      payload?.input_message?.conversation_id ||
      null
    );
  }

  function handleSseEvent(eventName, payload) {
    const detectedConversationId = getConversationIdFromSsePayload(payload);
    if (detectedConversationId) {
      LAST_STREAM_CONVERSATION_ID = detectedConversationId;
    }

    const conversationId = detectedConversationId || LAST_STREAM_CONVERSATION_ID;
    if (!conversationId) return;

    const cache = ensureConversationCache(conversationId);
    const streamState = ensureStreamState(conversationId);

    if (payload.type === "input_message" && payload.input_message) {
      const msg = payload.input_message;
      const parentId = msg?.metadata?.parent_id || null;
      upsertMessageNode(cache, msg, parentId);
      return;
    }

    if (eventName === "delta" && payload?.o === "add" && payload?.v?.message) {
      const msg = payload.v.message;
      const parentId = msg?.metadata?.parent_id || null;
      upsertMessageNode(cache, msg, parentId);

      if (msg?.author?.role === "assistant") {
        streamState.currentPatchedMessageId = msg.id;
      }
      return;
    }

    if (eventName === "delta" && payload?.v?.message) {
      const msg = payload.v.message;
      const parentId = msg?.metadata?.parent_id || null;
      upsertMessageNode(cache, msg, parentId);

      if (msg?.author?.role === "assistant") {
        streamState.currentPatchedMessageId = msg.id;
      }
      return;
    }

    if (eventName === "delta" && Array.isArray(payload?.v)) {
      applyDeltaOpsToMessage(cache, streamState.currentPatchedMessageId, payload.v);
      return;
    }

    if (eventName === "delta" && Array.isArray(payload)) {
      applyDeltaOpsToMessage(cache, streamState.currentPatchedMessageId, payload);
    }
  }

  async function consumeConversationStream(response) {
    if (!response.body) {
      try {
        const text = await response.text();
        const streamParserState = { currentEventName: "message" };
        const blocks = text.split(/\n\n+/);

        for (const block of blocks) {
          processSseBlock(block, handleSseEvent, streamParserState);
        }
      } catch (error) {
        log("stream parse failed (no body)", String(error));
      }
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const streamParserState = { currentEventName: "message" };

    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const blocks = buffer.split(/\n\n+/);
        buffer = blocks.pop() ?? "";

        for (const block of blocks) {
          processSseBlock(block, handleSseEvent, streamParserState);
        }
      }

      buffer += decoder.decode();
    } catch (error) {
      if (error?.name !== "AbortError") {
        log("stream parse failed", String(error));
        return;
      }

      log("stream aborted after partial read");
    }

    if (buffer.trim()) {
      processSseBlock(buffer, handleSseEvent, streamParserState);
    }
  }

  // =========================================================
  // FETCH HOOK
  // =========================================================
  const originalFetch =
    window.__CGO_ORIGINAL_FETCH__ ||
    window.fetch;

  if (!window.__CGO_ORIGINAL_FETCH__) {
    window.__CGO_ORIGINAL_FETCH__ = originalFetch;
  }

  log("window.fetch patched");
  window.fetch = async (...args) => {
    const orgResponse = await originalFetch.apply(window, args);

    let response;
    try {
      response = orgResponse.clone();
    } catch {
      return orgResponse;
    }

    try {
      const url = getRequestUrl(args[0]);

      const auth = getAuthorizationFromFetchArgs(args);
      if (auth) {
        window.__CGO_LAST_AUTHORIZATION__ = auth;
      }

      if (isFileDownloadRequest(url)) {
        const cloned = response.clone();
        cloned.json().then((data) => {
          const { fileId, conversationId } = extractFileIdAndConversationIdFromDownloadUrl(url);
          if (fileId && conversationId && data?.download_url) {
            saveFileDownloadResultToCache(fileId, conversationId, data);
            log("cached file download url", { fileId, conversationId });
          }
        }).catch((error) => {
          log("failed to cache file download response", String(error));
        });

        return response;
      }

      if (isStreamingConversationRequest(url)) {
        const clonedStream = response.clone();

        consumeConversationStream(clonedStream).catch((error) => {
          log("stream parse failed", String(error));
        });

        return response;
      }

      if (!isTargetConversationRequest(url)) {
        return response;
      }

      const cloned = response.clone();
      const contentType = cloned.headers.get("content-type") || "";

      if (!contentType.includes("application/json")) {
        return response;
      }

      const data = await cloned.json();

      if (!isFullConversationPayload(data)) {
        return response;
      }

      saveFullConversationToCache(data);

      const summary = analyzeConversation(data, CONFIG.turnCount);
      postAnalysis(url, summary);

      if (!CONFIG.enablePrune) {
        return response;
      }

      if (summary?.error) {
        log("skip prune: summary error", summary.error);
        return response;
      }

      if (shouldSkipPrune(summary)) {
        log("skip prune: low benefit", {
          chainLength: summary.original?.chainLength,
          keepNodeCount: summary.prunePlan?.keepNodeCount,
        });
        return response;
      }

      const pruned = pruneConversationData(data, CONFIG.turnCount);

      log("pruned conversation response", {
        url,
        originalMappingCount: summary.original?.mappingCount,
        prunedMappingCount: Object.keys(pruned.mapping || {}).length,
        currentNode: pruned.current_node,
        title: pruned.title,
      });

      return buildResponseFromJson(response, pruned);
    } catch (error) {
      postError(error);
      return response;
    }
  };

  // =========================================================
  // EXPORT CACHE BRIDGE
  // =========================================================
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;

    if (!data) return;
    if (data.type === "CGO_EXPORT_CACHE_REQUEST") {
      const conversationId = data.conversationId;
      const requestId = data.requestId;
      const cached = EXPORT_CACHE.get(conversationId);

      window.postMessage(
        {
          type: "CGO_EXPORT_CACHE_RESPONSE",
          requestId,
          data: cached ? structuredClone(cached) : null,
          error: cached ? null : "Conversation cache not found",
        },
        "*"
      );
    } else if (data.type === "CGO_LAST_AUTHORIZATION_REQUEST") {
      const { requestId } = data;
      window.postMessage(
        {
          type: "CGO_LAST_AUTHORIZATION_RESPONSE",
          requestId,
          authorization: window.__CGO_LAST_AUTHORIZATION__ || "",
        },
        "*"
      );
    } else if (data.type === "CGO_FILE_DOWNLOAD_CACHE_REQUEST") {
      const { fileId, conversationId, requestId } = data;
      const key = getFileDownloadCacheKey(fileId, conversationId);
      const cached = key ? FILE_DOWNLOAD_CACHE.get(key) : null;

      window.postMessage(
        {
          type: "CGO_FILE_DOWNLOAD_CACHE_RESPONSE",
          requestId,
          fileId,
          conversationId,
          data: cached ? structuredClone(cached) : null,
        },
        "*"
      );
    }
  });

  log("main hook initialized");
})();