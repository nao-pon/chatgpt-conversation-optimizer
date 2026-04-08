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
    turnCount: 40,
    enablePrune: true,
    debug: true,
    rootNodeId: "client-created-root",
    targetPathFragment: "/backend-api/conversation/",
  };

  const EXPORT_CACHE = new Map(); // full
  const STREAM_CACHE = new Map(); // draft
  const STREAM_STATE = new Map();
  const FILE_DOWNLOAD_CACHE = new Map();
  const PROJECT_NAME_BY_GIZMO_ID = new Map();
  const PROJECT_NAME_BY_CONVERSATION_ID = new Map();
  const STREAM_TOPIC_TO_CONVERSATION = new Map();
  const STREAM_TURN_EXCHANGE_TO_CONVERSATION = new Map();
  const WS_STREAM_PARSER_STATE = new Map();

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

  function postStreamNotify(message) {
    window.postMessage(
      {
        source: "cgo-prune-runtime",
        type: "streamNotify",
        message
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
      return;
    }

    if (data.type === "CGO_INIT_SETTINGS") {
      const settings = data.settings || {};
      const keepDomMessages = Number(settings.keepDomMessages);

      if (Number.isFinite(keepDomMessages)) {
        CONFIG.turnCount = Math.max(1, Math.round(keepDomMessages));
      }

      CONFIG.autoAdjustEnabled = !!settings.autoAdjustEnabled;

      window.postMessage(
        {
          source: "CGO_PAGE",
          type: "CGO_INIT_SETTINGS_ACK",
          version: PAGE_HOOK_VERSION,
          mainHook: true,
          applied: {
            turnCount: CONFIG.turnCount,
            autoAdjustEnabled: CONFIG.autoAdjustEnabled,
          },
        },
        "*"
      );
      return;
    }

    if (data.type === "CGO_UPDATE_SETTINGS") {
      const settings = data.settings || {};
      const keepDomMessages = Number(settings.keepDomMessages);

      if (Number.isFinite(keepDomMessages)) {
        CONFIG.turnCount = Math.max(1, Math.round(keepDomMessages));
      }

      if (typeof settings.autoAdjustEnabled === "boolean") {
        CONFIG.autoAdjustEnabled = settings.autoAdjustEnabled;
      }

      log("page-hook settings updated", {
        turnCount: CONFIG.turnCount,
        autoAdjustEnabled: CONFIG.autoAdjustEnabled,
      });
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

  function getResponseContentType(response) {
    return String(response?.headers?.get("content-type") || "");
  }

  function isEventStreamResponse(response) {
    return /\btext\/event-stream\b/i.test(getResponseContentType(response));
  }

  function isMeaningfulConversationNode(node) {
    if (!hasMessage(node)) return false;

    const role = getRole(node);
    if (role === "user") return true;
    if (role === "assistant" && getTextLength(node) > 0) return true;

    return false;
  }

  function isTargetConversationRequest(url) {
    try {
      const u = new URL(url, location.origin);
      return (
        /^\/backend-api\/conversation\/[a-z0-9:_-]+$/i.test(u.pathname) ||
        u.pathname === "/backend-api/conversation/new_branch"
      );
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

  function isSnorlaxSidebarRequest(url) {
    try {
      const u = new URL(url, location.origin);
      return u.pathname === "/backend-api/gizmos/snorlax/sidebar";
    } catch {
      return false;
    }
  }

  /*  function isFullConversationPayload(data) {
      return !!normalizeConversationPayload(data);
    }*/

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
      return /^\/backend-api\/(files\/download\/file_[A-Za-z0-9]+|conversation\/[A-Za-z0-9-]+\/interpreter\/download)$/i.test(u.pathname);
    } catch {
      return false;
    }
  }

  function extractFileIdAndConversationIdFromDownloadUrl(url) {
    try {
      const u = new URL(url, location.origin);
      const matchFiles = u.pathname.match(/\/backend-api\/files\/download\/(file_[A-Za-z0-9]+)/i);
      if (matchFiles) {
        return {
          fileId: matchFiles[1],
          conversationId: u.searchParams.get("conversation_id") || "",
        };
      } else {
        const matchInterpreter = u.pathname.match(/\/backend-api\/conversation\/([A-Za-z0-9-]+)\/interpreter\/download/i);
        const messageId = u.searchParams.get("message_id") || "";
        const rawSandboxPath = u.searchParams.get("sandbox_path") || "";
        const sandboxPath = rawSandboxPath.startsWith("sandbox:")
          ? rawSandboxPath
          : "sandbox:" + rawSandboxPath;

        return {
          fileId: buildSandboxFileId(messageId, sandboxPath),
          conversationId: matchInterpreter ? matchInterpreter[1] : "",
        };
      }
    } catch {
      return {
        fileId: "",
        conversationId: "",
      };
    }
  }

  // content/data.js に同名関数あり、変更時は合わせて変更
  function buildSandboxFileId(messageId, sandboxPath) {
    if (!messageId || !sandboxPath) return "";
    return "sandbox:" + hash(`${messageId}:${sandboxPath}`);
  }

  // content/config.js に同名関数あり、変更時は合わせて変更
  function hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (h << 5) - h + str.charCodeAt(i);
      h |= 0;
    }
    return (h >>> 0).toString(36);
  }


  function normalizeConversationPayload(data) {
    if (!data || typeof data !== "object") return null;

    // 通常会話レスポンス
    if (
      data.conversation_id &&
      data.current_node &&
      data.mapping &&
      typeof data.mapping === "object"
    ) {
      return data;
    }

    // branch 初期レスポンス
    const conv = data.conversation;
    if (
      conv &&
      typeof conv === "object" &&
      conv.current_node &&
      conv.mapping &&
      typeof conv.mapping === "object"
    ) {
      return conv;
    }

    return null;
  }

  // =========================================================
  // ANALYZE / PRUNE HELPERS
  // =========================================================
  function buildConversationStats(data) {
    const mapping = getMapping(data);

    let turnCount = 0;
    let textLength = 0;
    let imageCount = 0;
    let attachmentCount = 0;

    for (const node of Object.values(mapping)) {
      if (!hasMessage(node)) continue;

      const role = getRole(node);
      if (role !== "user" && role !== "assistant") continue;

      turnCount += 1;
      textLength += getTextLength(node);

      const parts = node?.message?.content?.parts;
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (part && typeof part === "object") {
            if (part.content_type === "image_asset_pointer") {
              imageCount += 1;
            } else if (
              part.content_type === "file_asset_pointer" ||
              part.content_type === "attachment_asset_pointer"
            ) {
              attachmentCount += 1;
            }
          }
        }
      }

      const metadataAttachments = node?.message?.metadata?.attachments;
      if (Array.isArray(metadataAttachments)) {
        attachmentCount += metadataAttachments.length;
      }
    }

    return {
      turnCount,
      textLength,
      imageCount,
      attachmentCount,
    };
  }

  function getRecommendedKeepDomMessages(baseKeepDomMessages, stats) {
    const base = Math.max(1, Number(baseKeepDomMessages || CONFIG.turnCount || 15));

    const score =
      Number(stats?.turnCount || 0) * 3 +
      Number(stats?.textLength || 0) / 2000 +
      Number(stats?.imageCount || 0) * 8 +
      Number(stats?.attachmentCount || 0) * 4;

    if (score >= 220) return Math.max(8, Math.min(base, 10));
    if (score >= 140) return Math.max(10, Math.min(base, 15));
    if (score >= 80) return Math.max(12, Math.min(base, 25));

    return base;
  }

  function postAutoAdjustResult(conversationId, projectName, baseKeepDomMessages, effectiveKeepDomMessages, stats) {
    window.postMessage(
      {
        source: "cgo-prune-runtime",
        type: "autoAdjustResult",
        conversationId,
        projectName,
        baseKeepDomMessages,
        effectiveKeepDomMessages,
        stats,
      },
      "*"
    );
  }

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

    const keepConversationIndexes = conversationalIndexes.slice(-turnCount);

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

  function isNodeConnectedToTarget(mapping, startId, targetId) {
    if (!startId || !targetId) return false;

    const seen = new Set();
    let cursor = startId;

    while (cursor && mapping[cursor] && !seen.has(cursor)) {
      if (cursor === targetId) return true;
      seen.add(cursor);
      cursor = mapping[cursor]?.parent || null;
    }

    return false;
  }

  function anchorStreamRootsToFullTail(full, stream, merged) {
    const fullTail = full?.current_node || null;
    if (!fullTail || !merged.mapping[fullTail]) return false;

    const streamCurrent = stream?.current_node || null;
    if (!streamCurrent || !merged.mapping[streamCurrent]) return false;

    if (isNodeConnectedToTarget(merged.mapping, streamCurrent, fullTail)) {
      return true;
    }

    const streamMapping = stream.mapping || {};
    const streamIds = new Set(Object.keys(streamMapping));

    let rootId = streamCurrent;
    const seen = new Set();

    while (rootId && streamIds.has(rootId) && !seen.has(rootId)) {
      seen.add(rootId);

      const parentId = merged.mapping[rootId]?.parent || null;

      // 親がない、または親が stream 外なら、ここが stream 側の先頭
      if (!parentId || !streamIds.has(parentId)) {
        break;
      }

      rootId = parentId;
    }

    if (!rootId || !merged.mapping[rootId]) return false;

    merged.mapping[rootId].parent = fullTail;

    const fullTailChildren = Array.isArray(merged.mapping[fullTail].children)
      ? merged.mapping[fullTail].children
      : [];

    if (!fullTailChildren.includes(rootId)) {
      fullTailChildren.push(rootId);
    }
    merged.mapping[fullTail].children = fullTailChildren;

    return isNodeConnectedToTarget(merged.mapping, streamCurrent, fullTail);
  }

  function mergeCaches(full, stream) {
    const merged = structuredClone(full);

    for (const [id, node] of Object.entries(stream.mapping || {})) {
      if (!merged.mapping[id]) {
        merged.mapping[id] = structuredClone(node);
      } else {
        const existing = merged.mapping[id];
        const incoming = node;

        const nextContent =
          incoming.message?.content &&
            Array.isArray(incoming.message.content.parts) &&
            incoming.message.content.parts.some((p) => p)
            ? incoming.message.content
            : existing.message?.content;

        merged.mapping[id] = {
          ...existing,
          ...incoming,
          message: {
            ...(existing.message || {}),
            ...(incoming.message || {}),
            content: nextContent,
          },
        };
      }
    }

    rebuildChildren(merged.mapping);

    anchorStreamRootsToFullTail(full, stream, merged);
    rebuildChildren(merged.mapping);

    const streamCurrent = stream.current_node || null;
    const fullCurrent = full.current_node || null;

    if (
      streamCurrent &&
      merged.mapping[streamCurrent] &&
      isNodeConnectedToTarget(merged.mapping, streamCurrent, fullCurrent)
    ) {
      merged.current_node = streamCurrent;
    } else {
      merged.current_node = fullCurrent || streamCurrent || null;
    }

    return merged;
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
    const recentConversationIds = conversationalIds.slice(-turnCount);
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
    if (keepRatio > 0.9) return true;

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

    // 1) keep する node だけコピーし、children は keepSet 内に限定
    for (const id of keepSet) {
      const node = mapping[id];
      if (!node) continue;

      const light = lightenNode(node);

      prunedMapping[id] = {
        ...light,
        children: Array.isArray(light.children)
          ? light.children.filter((childId) => keepSet.has(childId))
          : [],
      };
    }

    // 2) root は必ず残す
    const rootId = CONFIG.rootNodeId;
    const rootNode = mapping[rootId];

    if (rootNode) {
      prunedMapping[rootId] = {
        ...lightenNode(rootNode),
        children: [],
      };
    }

    // 3) 先頭 keep node を root 直下につなぎ直す
    const keptChain = chain.filter((id) => keepSet.has(id));
    const firstKeptId = keptChain[0];

    if (firstKeptId && prunedMapping[firstKeptId] && prunedMapping[rootId]) {
      prunedMapping[firstKeptId] = {
        ...prunedMapping[firstKeptId],
        parent: rootId,
      };

      prunedMapping[rootId].children = [firstKeptId];
    }

    // 4) parent が消えてしまった node は root か kept 親へ補正
    for (const [id, node] of Object.entries(prunedMapping)) {
      if (id === rootId) continue;

      const parentId = node?.parent;
      if (!parentId || !prunedMapping[parentId]) {
        prunedMapping[id] = {
          ...node,
          parent: id === firstKeptId ? (rootNode ? rootId : null) : node.parent,
        };
      }
    }

    log("prune mapping integrity", {
      originalCount: Object.keys(mapping).length,
      prunedCount: Object.keys(prunedMapping).length,
      rootChildren: prunedMapping[rootId]?.children || [],
      firstKeptId,
      currentNode,
    });

    return {
      ...data,
      mapping: prunedMapping,
      current_node: currentNode,
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

  function getTopicIdFromPayload(payload) {
    if (!payload || typeof payload !== "object") return "";
    return (
      payload.topic_id ||
      payload?.v?.topic_id ||
      payload?.data?.topic_id ||
      payload?.payload?.topic_id ||
      payload?.body?.topic_id ||
      ""
    );
  }

  function getTurnExchangeIdFromPayload(payload) {
    if (!payload || typeof payload !== "object") return "";
    return (
      payload.turn_exchange_id ||
      payload?.v?.turn_exchange_id ||
      payload?.data?.turn_exchange_id ||
      payload?.payload?.turn_exchange_id ||
      payload?.body?.turn_exchange_id ||
      ""
    );
  }

  function registerConversationTopicContext(payload, conversationId) {
    if (!conversationId || !payload || typeof payload !== "object") return;

    const topicId = getTopicIdFromPayload(payload);
    if (topicId) {
      STREAM_TOPIC_TO_CONVERSATION.set(topicId, conversationId);
    }

    const turnExchangeId = getTurnExchangeIdFromPayload(payload);
    if (turnExchangeId) {
      STREAM_TURN_EXCHANGE_TO_CONVERSATION.set(turnExchangeId, conversationId);
    }
  }

  function getConversationIdFromTopicContext(payload) {
    const topicId = getTopicIdFromPayload(payload);
    if (topicId && STREAM_TOPIC_TO_CONVERSATION.has(topicId)) {
      return STREAM_TOPIC_TO_CONVERSATION.get(topicId) || "";
    }

    const turnExchangeId = getTurnExchangeIdFromPayload(payload);
    if (turnExchangeId && STREAM_TURN_EXCHANGE_TO_CONVERSATION.has(turnExchangeId)) {
      return STREAM_TURN_EXCHANGE_TO_CONVERSATION.get(turnExchangeId) || "";
    }

    return "";
  }

  function parseJsonStringSafe(value) {
    if (typeof value !== "string") return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function visitPossibleStreamPayloads(value, visitor) {
    const queue = [value];
    const seen = new Set();

    while (queue.length) {
      const current = queue.shift();
      if (!current || typeof current !== "object" || seen.has(current)) continue;
      seen.add(current);

      if (Array.isArray(current)) {
        for (const item of current) {
          if (!item) continue;

          if (typeof item === "string") {
            const parsed = parseJsonStringSafe(item);
            if (parsed) queue.push(parsed);
            continue;
          }

          if (typeof item === "object") {
            queue.push(item);
          }
        }
        continue;
      }

      visitor(current);

      const nestedCandidates = [
        current.data,
        current.payload,
        current.body,
        current.event,
        current.message,
        current.v,
        current.ops,
        current.delta,
        current.items,
        current.messages,
      ];

      for (const candidate of nestedCandidates) {
        if (!candidate) continue;

        if (typeof candidate === "string") {
          const parsed = parseJsonStringSafe(candidate);
          if (parsed) queue.push(parsed);
          continue;
        }

        if (typeof candidate === "object") {
          queue.push(candidate);
        }
      }

      for (const value of Object.values(current)) {
        if (!value) continue;

        if (typeof value === "string") {
          const parsed = parseJsonStringSafe(value);
          if (parsed) queue.push(parsed);
          continue;
        }

        if (typeof value === "object") {
          queue.push(value);
        }
      }
    }
  }

  function getWsDataTypeName(data) {
    return Object.prototype.toString.call(data);
  }

  async function decodeWebSocketData(data) {
    if (typeof data === "string") return data;

    if (data instanceof Blob) {
      return await data.text();
    }

    if (data instanceof ArrayBuffer) {
      return new TextDecoder().decode(new Uint8Array(data));
    }

    if (ArrayBuffer.isView(data)) {
      return new TextDecoder().decode(data);
    }

    return "";
  }

  async function handleWebSocketFrame(rawData, source = "ws") {
    const text = await decodeWebSocketData(rawData);
    if (!text) {
      log("ws frame skipped: empty/unsupported", {
        source,
        dataType: getWsDataTypeName(rawData),
      });
      return;
    }

    const root = parseJsonStringSafe(text);
    if (!root) {
      log("ws frame non-json", {
        source,
        preview: text.slice(0, 300),
      });
      return;
    }

    visitPossibleStreamPayloads(root, (payload) => {
      if (
        payload?.type === "conversation-turn-stream" &&
        payload?.payload?.type === "stream-item" &&
        typeof payload?.payload?.encoded_item === "string"
      ) {
        const topicId =
          payload?.turn_id ||
          payload?.payload?.turn_id ||
          payload?.topic_id ||
          "encoded_item";

        const conversationId = payload?.payload?.conversation_id || "";
        if (conversationId) {
          LAST_STREAM_CONVERSATION_ID = conversationId;
          registerConversationTopicContext(payload, conversationId);
          registerConversationTopicContext(payload.payload, conversationId);
        }

        processSseBlock(
          payload.payload.encoded_item,
          handleSseEvent,
          getWsStreamParserState(topicId),
          { url: `ws:${topicId}`, topicId }
        );
        return;
      }

      handleSseEvent("message", payload);
    });
  }

  function patchWebSocket() {
    const NativeWebSocket = window.WebSocket;
    if (!NativeWebSocket || window.__CGO_WEBSOCKET_PATCHED__) return;

    window.__CGO_ORIGINAL_WEBSOCKET__ =
      window.__CGO_ORIGINAL_WEBSOCKET__ || NativeWebSocket;

    function CGOWebSocket(url, protocols) {
      const ws =
        protocols === undefined
          ? new NativeWebSocket(url)
          : new NativeWebSocket(url, protocols);

      try {
        const originalSend = ws.send;
        ws.send = function send(data) {
          handleWebSocketFrame(data, "ws-send").catch((error) => {
            log("ws send parse failed", String(error));
          });
          return originalSend.call(this, data);
        };

        ws.addEventListener("message", (event) => {
          handleWebSocketFrame(event.data, "ws-message").catch((error) => {
            log("ws message parse failed", String(error));
          });
        });
      } catch (error) {
        log("websocket patch failed", String(error));
      }

      return ws;
    }

    CGOWebSocket.prototype = NativeWebSocket.prototype;
    Object.setPrototypeOf(CGOWebSocket, NativeWebSocket);

    window.WebSocket = CGOWebSocket;
    window.__CGO_WEBSOCKET_PATCHED__ = true;
  }

  function getWsStreamParserState(topicId) {
    let state = WS_STREAM_PARSER_STATE.get(topicId);
    if (!state) {
      state = { currentEventName: "message" };
      WS_STREAM_PARSER_STATE.set(topicId, state);
    }
    return state;
  }

  // =========================================================
  // CACHE HELPERS
  // =========================================================
  function normalizeProjectName(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function cacheProjectSidebarPayload(data) {
    const items = Array.isArray(data?.items) ? data.items : [];
    for (const item of items) {
      const gizmo = item?.gizmo?.gizmo;
      const gizmoId = gizmo?.id || "";
      const projectName = normalizeProjectName(gizmo?.display?.name);

      if (gizmoId && projectName) {
        PROJECT_NAME_BY_GIZMO_ID.set(gizmoId, projectName);
      }

      const conversations = Array.isArray(item?.conversations?.items)
        ? item.conversations.items
        : [];

      for (const conv of conversations) {
        const conversationId = conv?.id || "";
        const convGizmoId =
          conv?.gizmo_id ||
          conv?.conversation_template_id ||
          gizmoId ||
          "";

        const effectiveProjectName =
          projectName ||
          PROJECT_NAME_BY_GIZMO_ID.get(convGizmoId) ||
          "";

        if (convGizmoId && effectiveProjectName) {
          PROJECT_NAME_BY_GIZMO_ID.set(convGizmoId, effectiveProjectName);
        }

        if (conversationId && effectiveProjectName) {
          PROJECT_NAME_BY_CONVERSATION_ID.set(conversationId, effectiveProjectName);
        }
      }
    }
  }

  function applyProjectNameToConversation(data) {
    if (!data || typeof data !== "object") return data;

    const conversationId = data.conversation_id || "";
    const gizmoId =
      data.gizmo_id ||
      data.conversation_template_id ||
      "";

    const projectName =
      PROJECT_NAME_BY_CONVERSATION_ID.get(conversationId) ||
      PROJECT_NAME_BY_GIZMO_ID.get(gizmoId) ||
      "";

    if (projectName) {
      data.project_name = projectName;
    }

    return data;
  }

  function saveFullConversationToCache(data) {
    const conversationId = data?.conversation_id;
    if (!conversationId) return;

    applyProjectNameToConversation(data);

    EXPORT_CACHE.set(conversationId, structuredClone(data));
    window.__CGO_EXPORT_CACHE = true;
  }

  function ensureConversationCache(conversationId) {
    let data = STREAM_CACHE.get(conversationId);
    if (data) return data;

    const full = EXPORT_CACHE.get(conversationId);

    data = full
      ? structuredClone(full)
      : {
        conversation_id: conversationId,
        title: "",
        current_node: null,
        mapping: {},
        project_name: PROJECT_NAME_BY_CONVERSATION_ID.get(conversationId) || "",
      };

    STREAM_CACHE.set(conversationId, data);
    return data;
  }

  function shouldUseAsPatchedTarget(message) {
    if (!message || typeof message !== "object") return false;
    return message?.author?.role === "assistant";
  }

  function flushPendingOps(cache, streamState) {
    if (!streamState?.currentPatchedMessageId) return;
    if (!Array.isArray(streamState.pendingOps) || !streamState.pendingOps.length) return;

    const ops = streamState.pendingOps.splice(0, streamState.pendingOps.length);
    applyDeltaOpsToMessage(cache, streamState.currentPatchedMessageId, ops);
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

  function getStreamStateKey(conversationId, topicId = "") {
    return topicId ? `${conversationId}::${topicId}` : conversationId;
  }

  function ensureStreamState(conversationId, topicId = "") {
    const key = getStreamStateKey(conversationId, topicId);
    let streamState = STREAM_STATE.get(key);
    if (!streamState) {
      streamState = {
        currentPatchedMessageId: null,
        pendingOps: [],
      };
      STREAM_STATE.set(key, streamState);
    } else if (!Array.isArray(streamState.pendingOps)) {
      streamState.pendingOps = [];
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

    ops = normalizeOps(ops);

    for (const op of ops) {
      if (op.p === "/message/content/parts/0" && op.o === "append") {
        msg.content.parts[0] = (msg.content.parts[0] || "") + String(op.v || "");
      } else if (
        op.p === "/message/content/parts/0" &&
        (op.o === "replace" || op.o === "add")
      ) {
        msg.content.parts[0] = String(op.v || "");
      } else if (op.p === "/message/status" && op.o === "replace") {
        msg.status = op.v;
      } else if (op.p === "/message/end_turn" && op.o === "replace") {
        msg.end_turn = op.v;
      } else if (op.p === "/message/metadata/token_count" && op.o === "replace") {
        msg.metadata = msg.metadata || {};
        msg.metadata.token_count = op.v;
      }
    }

    if (msg.end_turn) {
      postStreamNotify(msg);
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
  function normalizeOps(ops) {
    const out = [];

    for (const op of ops || []) {
      if (!op || typeof op !== "object") continue;

      if (
        op.o === "patch" &&
        Array.isArray(op.v)
      ) {
        out.push(...normalizeOps(op.v));
        continue;
      }

      out.push(op);
    }

    return out;
  }

  function processSseBlock(block, onEvent, streamParserState, meta = {}) {
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
        onEvent(eventName, JSON.parse(raw), meta);
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
      payload?.payload?.conversation_id ||
      payload?.payload?.payload?.conversation_id ||
      getConversationIdFromTopicContext(payload) ||
      null
    );
  }

  function handleSseEvent(eventName, payload, meta = {}) {

    function applyOrQueueDeltaOps(cache, streamState, ops) {
      const normalized = normalizeOps(ops);
      if (!normalized.length) return;

      if (streamState.currentPatchedMessageId) {
        applyDeltaOpsToMessage(cache, streamState.currentPatchedMessageId, normalized);
      } else {
        streamState.pendingOps.push(...normalized);
      }
    }

    const detectedConversationId = getConversationIdFromSsePayload(payload);
    if (detectedConversationId) {
      LAST_STREAM_CONVERSATION_ID = detectedConversationId;
      registerConversationTopicContext(payload, detectedConversationId);
      registerConversationTopicContext(payload?.payload, detectedConversationId);
      registerConversationTopicContext(payload?.v, detectedConversationId);
    }

    const conversationId = detectedConversationId || LAST_STREAM_CONVERSATION_ID;
    if (!conversationId) return;

    const topicId =
      meta.topicId ||
      getTopicIdFromPayload(payload) ||
      "";

    const cache = ensureConversationCache(conversationId);
    const streamState = ensureStreamState(conversationId, topicId);

    if (payload?.type === "resume_conversation_token") {
      const topicIdFromPayload = getTopicIdFromPayload(payload);
      if (topicIdFromPayload) {
        STREAM_TOPIC_TO_CONVERSATION.set(topicIdFromPayload, conversationId);
      }
      return;
    }

    if (payload?.type === "stream_handoff") {
      const turnExchangeId = getTurnExchangeIdFromPayload(payload);
      if (turnExchangeId) {
        STREAM_TURN_EXCHANGE_TO_CONVERSATION.set(turnExchangeId, conversationId);
      }

      const options = Array.isArray(payload?.options) ? payload.options : [];
      for (const option of options) {
        const optionTopicId = option?.topic_id || "";
        if (optionTopicId) {
          STREAM_TOPIC_TO_CONVERSATION.set(optionTopicId, conversationId);
        }
      }
      return;
    }

    if (payload?.type === "input_message" && payload?.input_message) {
      const msg = payload.input_message;
      const parentId = msg?.metadata?.parent_id || null;
      upsertMessageNode(cache, msg, parentId);

      if (msg?.author?.role === "assistant") {
        streamState.currentPatchedMessageId = msg.id;
        flushPendingOps(cache, streamState);
      }
      return;
    }

    if (eventName === "delta" && payload?.o === "add" && payload?.v?.message) {
      const msg = payload.v.message;
      const parentId = msg?.metadata?.parent_id || null;
      upsertMessageNode(cache, msg, parentId);

      if (msg?.author?.role === "assistant") {
        streamState.currentPatchedMessageId = msg.id;
        flushPendingOps(cache, streamState);
      }
      return;
    }

    if (eventName === "delta" && payload?.v?.message) {
      const msg = payload.v.message;
      const parentId = msg?.metadata?.parent_id || null;
      upsertMessageNode(cache, msg, parentId);

      if (msg?.author?.role === "assistant") {
        streamState.currentPatchedMessageId = msg.id;
        flushPendingOps(cache, streamState);
      }
      return;
    }

    if (payload?.message?.id) {
      const msg = payload.message;
      const parentId = msg?.metadata?.parent_id || null;
      upsertMessageNode(cache, msg, parentId);

      if (shouldUseAsPatchedTarget(msg)) {
        streamState.currentPatchedMessageId = msg.id;
        flushPendingOps(cache, streamState);
      }
    }

    if (
      eventName === "delta" &&
      payload &&
      typeof payload === "object" &&
      typeof payload.p === "string" &&
      typeof payload.o === "string"
    ) {
      applyOrQueueDeltaOps(cache, streamState, [payload]);
      return;
    }

    if (eventName === "delta" && Array.isArray(payload?.v)) {
      applyOrQueueDeltaOps(cache, streamState, payload.v);
      return;
    }

    if (eventName === "delta" && Array.isArray(payload)) {
      applyOrQueueDeltaOps(cache, streamState, payload);
      return;
    }

    if (Array.isArray(payload?.ops)) {
      applyOrQueueDeltaOps(cache, streamState, payload.ops);
      return;
    }

    if (Array.isArray(payload?.delta)) {
      applyOrQueueDeltaOps(cache, streamState, payload.delta);
      return;
    }
  }

  async function consumeConversationStream(response, meta = {}) {
    if (!response.body) {
      try {
        const text = await response.text();
        const streamParserState = { currentEventName: "message" };
        const blocks = text.split(/\n\n+/);

        for (const block of blocks) {
          processSseBlock(block, handleSseEvent, streamParserState, meta);
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
          processSseBlock(block, handleSseEvent, streamParserState, meta);
        }
      }

      buffer += decoder.decode();
    } catch (error) {
      if (String(error?.name || "") !== "AbortError") {
        log("stream parse failed", String(error));
        return;
      }

      log("stream aborted after partial read", { url: meta.url || "" });
    }

    if (buffer.trim()) {
      processSseBlock(buffer, handleSseEvent, streamParserState, meta);
    }
  }

  // =========================================================
  // FETCH HOOK
  // =========================================================
  async function handleFetchResponse({ args, response, url }) {
    const orgResponse = response;
    const shouldObserveEventStream =
      isStreamingConversationRequest(url) || isEventStreamResponse(orgResponse);

    if (
      !isFileDownloadRequest(url) &&
      !shouldObserveEventStream &&
      !isTargetConversationRequest(url) &&
      !isSnorlaxSidebarRequest(url)
    ) {
      return orgResponse;
    }

    let clonedResponse = null;
    try {
      clonedResponse = orgResponse.clone();
    } catch {
      return orgResponse;
    }

    if (shouldObserveEventStream) {
      consumeConversationStream(clonedResponse, { url }).catch((error) => {
        log("stream parse failed", String(error));
      });

      return orgResponse;
    }

    const auth = getAuthorizationFromFetchArgs(args);
    if (auth) {
      window.__CGO_LAST_AUTHORIZATION__ = auth;
    }

    let rawData;
    try {
      rawData = await clonedResponse.json();
    } catch {
      return orgResponse;
    }

    if (isSnorlaxSidebarRequest(url)) {
      try {
        cacheProjectSidebarPayload(rawData);
      } catch (error) {
        log("failed to cache snorlax sidebar response", String(error));
      }

      return orgResponse;
    }

    // download API cache
    if (isFileDownloadRequest(url)) {
      try {
        const { fileId, conversationId } =
          extractFileIdAndConversationIdFromDownloadUrl(url);

        if (fileId && conversationId && rawData?.download_url) {
          saveFileDownloadResultToCache(fileId, conversationId, rawData);
          log("cached file download url", { fileId, conversationId });
        }
      } catch (error) {
        log("failed to cache file download response", String(error));
      }

      return orgResponse;
    }

    // full conversation / new_branch
    const data = normalizeConversationPayload(rawData);
    if (!data) {
      return orgResponse;
    }

    saveFullConversationToCache(data);

    const stats = buildConversationStats(data);
    const baseKeepDomMessages = CONFIG.turnCount;

    const effectiveKeepDomMessages =
      CONFIG.autoAdjustEnabled && baseKeepDomMessages > 10
        ? getRecommendedKeepDomMessages(baseKeepDomMessages, stats)
        : baseKeepDomMessages;

    const summary = analyzeConversation(data, effectiveKeepDomMessages);
    const projectName = PROJECT_NAME_BY_CONVERSATION_ID.get(data?.conversation_id || "") ||
      PROJECT_NAME_BY_GIZMO_ID.get(
        data?.gizmo_id || data?.conversation_template_id || ""
      ) || "";

    postAnalysis(url, summary);

    Object.assign(stats, summary.original);
    postAutoAdjustResult(
      data.conversation_id || "",
      projectName,
      baseKeepDomMessages,
      effectiveKeepDomMessages,
      stats
    );

    if (!CONFIG.enablePrune) {
      return orgResponse;
    }

    if (summary?.error) {
      log("skip prune: summary error", summary.error);
      return orgResponse;
    }

    if (shouldSkipPrune(summary)) {
      log("skip prune: low benefit", {
        chainLength: summary.original?.chainLength,
        keepNodeCount: summary.prunePlan?.keepNodeCount,
      });
      return orgResponse;
    }

    const pruned = pruneConversationData(data, effectiveKeepDomMessages);

    log("pruned conversation response", {
      url,
      originalMappingCount: Object.keys(data.mapping || {}).length,
      prunedMappingCount: Object.keys(pruned.mapping || {}).length,
      currentNode: pruned.current_node,
      title: pruned.title,
    });

    // new_branch など conversation ラッパー付きレスポンス
    const isWrapped = rawData && typeof rawData === "object" && "conversation" in rawData;
    if (isWrapped) {
      return buildResponseFromJson(clonedResponse, {
        ...rawData,
        conversation: pruned,
      });
    }
    // 通常会話レスポンス
    return buildResponseFromJson(clonedResponse, pruned);
  }

  window.__CGO_MAIN_HOOK_API__ = {
    handleFetchResponse,
  };

  patchWebSocket();
  patchEventSource();

  window.__CGO_MAIN_HOOK_READY__ = true;
  window.postMessage(
    {
      source: "CGO_PAGE",
      type: "CGO_MAIN_HOOK_READY",
      version: PAGE_HOOK_VERSION,
      mainHook: true,
    },
    "*"
  );

  function patchEventSource() {
    const NativeEventSource = window.EventSource;
    if (!NativeEventSource || window.__CGO_EVENTSOURCE_PATCHED__) return;

    window.__CGO_ORIGINAL_EVENTSOURCE__ =
      window.__CGO_ORIGINAL_EVENTSOURCE__ || NativeEventSource;

    function CGOEventSource(url, config) {
      const es =
        config === undefined
          ? new NativeEventSource(url)
          : new NativeEventSource(url, config);

      try {
        es.addEventListener("message", (event) => {
          const raw = typeof event.data === "string" ? event.data : "";
          const parsed = parseJsonStringSafe(raw);
          if (parsed) {
            handleSseEvent(event.type || "message", parsed);
          }
        });

        const originalAddEventListener = es.addEventListener;
        es.addEventListener = function (type, listener, options) {
          if (type !== "message") {
            const wrapped = function (event) {
              const raw = typeof event.data === "string" ? event.data : "";
              const parsed = parseJsonStringSafe(raw);
              if (parsed) {
                handleSseEvent(type, parsed);
              }

              return listener.call(this, event);
            };
            return originalAddEventListener.call(this, type, wrapped, options);
          }
          return originalAddEventListener.call(this, type, listener, options);
        };
      } catch (error) {
        log("eventsource patch failed", String(error));
      }

      return es;
    }

    CGOEventSource.prototype = NativeEventSource.prototype;
    Object.setPrototypeOf(CGOEventSource, NativeEventSource);

    window.EventSource = CGOEventSource;
    window.__CGO_EVENTSOURCE_PATCHED__ = true;
  }

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

      const full = EXPORT_CACHE.get(conversationId) || null;
      const stream = STREAM_CACHE.get(conversationId) || null;

      let cached = null;
      if (full && stream) {
        cached = mergeCaches(full, stream);
      } else {
        cached = stream || full || null;
      }

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