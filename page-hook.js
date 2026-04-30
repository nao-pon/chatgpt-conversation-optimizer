(() => {
  "use strict";

  // =========================================================
  // INSTALL GUARD / CONSTANTS / CONFIG / STATE
  // =========================================================
  const PAGE_HOOK_VERSION = "2";
  const PAGE_BRIDGE_SECRET = "CGO_BRIDGE_" + Math.random().toString(36).slice(2, 15);

  if (window.__CGO_MAIN_HOOK_INSTALLED__) {
    return;
  }
  window.__CGO_MAIN_HOOK_INSTALLED__ = true;
  window.__CGO_BRIDGE_SECRET__ = PAGE_BRIDGE_SECRET;

  const CONFIG = {
    turnCount: 40,
    enablePrune: true,
    debug: false,
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
  const VOICE_SESSION_STATE = {
    state: "idle",
    conversationId: "",
    lastChangedAt: 0,
  };

  // =========================================================
  // LOGGING / POST HELPERS
  /**
   * Send debug log messages to the host via window.postMessage when debugging is enabled.
   * @param {...any} args - Values to include in the log payload forwarded to the host.
   */
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

  /**
   * Send analysis results about a conversation to the page via window.postMessage.
   * @param {string} url - The URL associated with the analysis (typically the conversation API request URL).
   * @param {Object} summary - An object containing analysis data (statistics, prune plan, and related metadata).
   */
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

  /**
   * Notify the page host about a streaming update by posting a standardized message.
   * @param {any} message - Payload describing the stream update; included verbatim in the posted message.
   */
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

  /**
   * Notify the content layer about the current voice-session lock state.
   * @param {string} conversationId - Best-effort conversation identifier, or an empty string when unknown.
   * @param {"active"|"syncing"|"idle"} state - Voice-session state used by the content layer to lock export actions.
   * @param {object} [extra={}] - Optional metadata forwarded alongside the state update.
   */
  function postVoiceSessionState(conversationId, state, extra = {}) {
    window.postMessage(
      {
        ...extra,
        source: "cgo-prune-runtime",
        type: "voiceSessionState",
        conversationId,
        state,
      },
      "*"
    );
  }

  /**
   * Extract a conversation identifier from a realtime voice request URL when one is present.
   * @param {string} url - Request URL associated with the voice session.
   * @returns {string} Conversation identifier, or an empty string when not present.
   */
  function getConversationIdFromVoiceUrl(url) {
    try {
      const parsed = new URL(url, location.origin);
      return (
        parsed.searchParams.get("conversation_id") ||
        parsed.searchParams.get("conversationId") ||
        ""
      );
    } catch {
      return "";
    }
  }

  /**
   * Resolve the best available conversation id for voice-session state updates.
   * @param {string} [url=""] - Optional URL that may contain a conversation id query parameter.
   * @returns {string} Resolved conversation identifier, or an empty string when still unknown.
   */
  function resolveVoiceSessionConversationId(url = "") {
    return (
      getConversationIdFromVoiceUrl(url) ||
      VOICE_SESSION_STATE.conversationId ||
      getConversationIdFromLocation() ||
      LAST_STREAM_CONVERSATION_ID ||
      ""
    );
  }

  /**
   * Update the deduplicated voice-session state and notify the content layer only when it changes.
   * @param {"active"|"syncing"|"idle"} nextState - Next voice-session state.
   * @param {string} [conversationId=""] - Best-effort conversation identifier.
   * @param {object} [extra={}] - Optional metadata forwarded with the notification.
   */
  function updateVoiceSessionState(nextState, conversationId = "", extra = {}) {
    const resolvedConversationId =
      conversationId ||
      resolveVoiceSessionConversationId(extra?.url || "");

    if (
      VOICE_SESSION_STATE.state === nextState &&
      VOICE_SESSION_STATE.conversationId === resolvedConversationId
    ) {
      return;
    }

    VOICE_SESSION_STATE.state = nextState;
    VOICE_SESSION_STATE.conversationId = resolvedConversationId;
    VOICE_SESSION_STATE.lastChangedAt = Date.now();

    postVoiceSessionState(resolvedConversationId, nextState, extra);
  }

  /**
   * Determine whether a fetch URL is the lightweight voice-session bootstrap request.
   * @param {string} url - Fetch request URL.
   * @returns {boolean} `true` when the URL matches the realtime voice bootstrap endpoint.
   */
  function isRealtimeVoiceBootstrapRequest(url) {
    try {
      return new URL(url, location.origin).pathname === "/realtime/vp";
    } catch {
      return /\/realtime\/vp(?:[/?#]|$)/.test(String(url || ""));
    }
  }

  /**
   * Attach minimal lifecycle listeners to a RTC data channel without inspecting message payloads.
   * @param {RTCDataChannel|object} channel - Data channel instance to observe.
   * @param {RTCPeerConnection|object} peerConnection - Peer connection associated with the channel.
   * @returns {*} The same channel instance.
   */
  function attachVoiceSessionChannelStateHandlers(channel, peerConnection) {
    if (!channel || channel.__CGO_VOICE_SESSION_STATE_ATTACHED__) return channel;

    channel.__CGO_VOICE_SESSION_STATE_ATTACHED__ = true;
    channel.addEventListener("open", () => {
      if (VOICE_SESSION_STATE.state !== "active" && !peerConnection.__CGO_VOICE_SESSION_LIVE__) {
        return;
      }

      peerConnection.__CGO_VOICE_SESSION_LIVE__ = true;
      updateVoiceSessionState(
        "active",
        resolveVoiceSessionConversationId(),
        {
          source: "rtc-datachannel-open",
          label: channel.label || "",
        }
      );
    });

    channel.addEventListener("close", () => {
      if (!peerConnection.__CGO_VOICE_SESSION_LIVE__ && VOICE_SESSION_STATE.state !== "active") {
        return;
      }

      updateVoiceSessionState(
        "syncing",
        resolveVoiceSessionConversationId(),
        {
          source: "rtc-datachannel-close",
          label: channel.label || "",
        }
      );
    });

    return channel;
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
          mainHook: true,
          secret: PAGE_BRIDGE_SECRET
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
      CONFIG.debug = !!settings.debugEnabled;

      window.postMessage(
        {
          source: "CGO_PAGE",
          type: "CGO_INIT_SETTINGS_ACK",
          version: PAGE_HOOK_VERSION,
          mainHook: true,
          secret: PAGE_BRIDGE_SECRET,
          applied: {
            turnCount: CONFIG.turnCount,
            autoAdjustEnabled: CONFIG.autoAdjustEnabled,
            debugEnabled: CONFIG.debug,
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

      if (typeof settings.debugEnabled === "boolean") {
        CONFIG.debug = settings.debugEnabled;
      }

      log("page-hook settings updated", {
        turnCount: CONFIG.turnCount,
        autoAdjustEnabled: CONFIG.autoAdjustEnabled,
        debugEnabled: CONFIG.debug,
      });
    }
  });

  // =========================================================
  // SMALL HELPERS
  /**
   * Retrieve the `mapping` object from a conversation payload.
   * @param {object|undefined|null} data - Conversation-like object that may contain a `mapping` property.
   * @returns {object} The `mapping` object if present and an object, otherwise an empty object.
   */
  function getMapping(data) {
    return data?.mapping && typeof data.mapping === "object" ? data.mapping : {};
  }

  /**
   * Get the current node identifier from a conversation payload.
   * @param {Object} data - Conversation payload that may include a `current_node` property.
   * @returns {string|null} The `current_node` value if present, otherwise `null`.
   */
  function getCurrentNode(data) {
    return data?.current_node || null;
  }

  /**
   * Determine whether a conversation node contains a message.
   * @param {Object|null|undefined} node - Node object that may have a `message` property.
   * @returns {boolean} `true` if `node` has a `message` property, `false` otherwise.
   */
  function hasMessage(node) {
    return !!node?.message;
  }

  /**
   * Extracts the author role from a conversation node.
   * @param {Object} node - A conversation node object that may contain `message.author.role`.
   * @returns {string|null} The role (for example, `"user"` or `"assistant"`) if present, `null` otherwise.
   */
  function getRole(node) {
    return node?.message?.author?.role || null;
  }

  /**
   * Build a best-effort text fallback for a message from cached CGO metadata or raw string parts.
   *
   * @param {object} message - Conversation message object.
   * @returns {string} Derived text fallback.
   */
  function getMessageTextFallback(message) {
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
   * Extract lightweight CGO-specific derived message metadata from raw content parts.
   *
   * @param {object} message - Conversation message object.
   * @returns {{text_fallback: string, is_voice_transcription: boolean, voice_direction: string, has_voice_audio: boolean}} Derived metadata payload.
   */
  function extractCgoMessageMeta(message) {
    const parts = Array.isArray(message?.content?.parts)
      ? message.content.parts
      : [];

    const textParts = [];
    let isVoiceTranscription = false;
    let voiceDirection = "";
    let hasVoiceAudio = false;

    for (const part of parts) {
      if (typeof part === "string") {
        if (part.trim()) {
          textParts.push(part);
        }
        continue;
      }

      if (!part || typeof part !== "object") continue;

      const contentType = String(part.content_type || "");

      if (contentType === "audio_transcription") {
        isVoiceTranscription = true;

        if (typeof part.text === "string" && part.text.trim()) {
          textParts.push(part.text);
        }

        const direction = String(part.direction || "").toLowerCase();
        if (!voiceDirection && (direction === "in" || direction === "out")) {
          voiceDirection = direction;
        }
        continue;
      }

      if (contentType === "audio_asset_pointer") {
        hasVoiceAudio = true;
        continue;
      }

      if (
        contentType === "real_time_user_audio_video_asset_pointer" &&
        part.audio_asset_pointer
      ) {
        hasVoiceAudio = true;
      }
    }

    return {
      text_fallback: textParts.join("\n"),
      is_voice_transcription: isVoiceTranscription,
      voice_direction: voiceDirection,
      has_voice_audio: hasVoiceAudio,
    };
  }

  /**
   * Annotate a raw message with lightweight CGO-derived metadata under `message.metadata.cgo`.
   *
   * @param {object} message - Conversation message object.
   * @returns {object} The same message instance.
   */
  function annotateMessageForCgo(message) {
    if (!message || typeof message !== "object") return message;

    const nextMeta = extractCgoMessageMeta(message);
    const prevMeta =
      message?.metadata?.cgo && typeof message.metadata.cgo === "object"
        ? message.metadata.cgo
        : null;

    if (
      !prevMeta &&
      !nextMeta.text_fallback &&
      !nextMeta.is_voice_transcription &&
      !nextMeta.voice_direction &&
      !nextMeta.has_voice_audio
    ) {
      return message;
    }

    const metadata =
      message.metadata && typeof message.metadata === "object"
        ? message.metadata
        : {};

    message.metadata = metadata;
    message.metadata.cgo = {
      ...(prevMeta || {}),
      text_fallback: nextMeta.text_fallback || prevMeta?.text_fallback || "",
      is_voice_transcription:
        !!nextMeta.is_voice_transcription || !!prevMeta?.is_voice_transcription,
      voice_direction: nextMeta.voice_direction || prevMeta?.voice_direction || "",
      has_voice_audio:
        !!nextMeta.has_voice_audio || !!prevMeta?.has_voice_audio,
    };

    return message;
  }

  /**
   * Annotate every cached message in a conversation payload with lightweight CGO metadata.
   *
   * @param {object} data - Conversation payload containing a `mapping`.
   * @returns {object} The same conversation payload instance.
   */
  function annotateConversationForCgo(data) {
    const mapping = getMapping(data);

    for (const node of Object.values(mapping)) {
      if (node?.message) {
        annotateMessageForCgo(node.message);
      }
    }

    return data;
  }

  /**
   * Compute the combined character length of a conversation node's best-effort text content.
   *
   * @param {object} node - Conversation node object; expected shape may include `node.message.content.parts` as an array of parts.
   * @returns {number} The number of characters in the derived text fallback; returns `0` when no text is available.
   */
  function getTextLength(node) {
    return getMessageTextFallback(node?.message).length;
  }

  /**
   * Retrieve the Content-Type header value from a Response-like object.
   * @param {Response|Object} response - A Response or response-like object that exposes `headers.get`.
   * @returns {string} The `content-type` header value, or an empty string if the header is missing.
   */
  function getResponseContentType(response) {
    return String(response?.headers?.get("content-type") || "");
  }

  /**
   * Determine whether a response's Content-Type indicates a Server-Sent Events (event-stream).
   *
   * @returns {boolean} `true` if the response's Content-Type is `text/event-stream`, `false` otherwise.
   */
  function isEventStreamResponse(response) {
    return /\btext\/event-stream\b/i.test(getResponseContentType(response));
  }

  /**
   * Determine whether a conversation node represents a meaningful message for analysis or pruning.
   * @param {object} node - Conversation node object to evaluate (expected to contain message and role fields).
   * @returns {boolean} `true` if the node is a user message or an assistant message with non-empty text, `false` otherwise.
   */
  function isMeaningfulConversationNode(node) {
    if (!hasMessage(node)) return false;

    const role = getRole(node);
    if (role === "user") return true;
    if (role === "assistant" && getTextLength(node) > 0) return true;

    return false;
  }

  /**
   * Determines whether a URL targets the backend conversation creation or retrieval endpoints.
   * @param {string} url - Absolute or relative URL to test.
   * @returns {boolean} `true` if the URL pathname matches `/backend-api/conversation/<id>` or `/backend-api/conversation/new_branch`, `false` otherwise.
   */
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

  /**
   * Detects whether a URL targets the streaming conversation endpoint.
   * @param {string} url - The request URL or path; may be absolute or relative.
   * @returns {boolean} `true` if the URL's pathname is `/backend-api/f/conversation`, `false` otherwise.
   */
  function isStreamingConversationRequest(url) {
    try {
      const u = new URL(url, location.origin);
      return u.pathname === "/backend-api/f/conversation";
    } catch {
      return false;
    }
  }

  /**
   * Checks whether a given URL targets the Snorlax sidebar backend endpoint.
   * @param {string} url - An absolute or relative URL to test against the current origin.
   * @returns {boolean} `true` if the URL's path is "/backend-api/gizmos/snorlax/sidebar", `false` otherwise.
   */
  function isSnorlaxSidebarRequest(url) {
    try {
      const u = new URL(url, location.origin);
      return u.pathname === "/backend-api/gizmos/snorlax/sidebar";
    } catch {
      return false;
    }
  }

  /**
   * Create a new Response whose body is the JSON serialization of `jsonData`,
   * preserving the original response's status and statusText.
   *
   * Copies headers from `originalResponse`, sets `Content-Type` to
   * `application/json; charset=utf-8`, and removes any `Content-Length` header
   * before returning the new Response.
   *
   * @param {Response} originalResponse - The response to copy status, statusText, and headers from.
   * @param {*} jsonData - The value to serialize into the JSON response body.
   * @returns {Response} A Response containing `jsonData` serialized as JSON with adjusted headers.
   */

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

  /**
   * Builds a cache key for a file download using the conversation and file identifiers.
   * @param {string} fileId - The file identifier.
   * @param {string} conversationId - The conversation identifier.
   * @returns {string} The cache key formatted as `conversationId:fileId`, or an empty string if either identifier is falsy.
   */
  function getFileDownloadCacheKey(fileId, conversationId) {
    if (!fileId || !conversationId) return "";
    return `${conversationId}:${fileId}`;
  }

  /**
   * Checks whether a request URL targets the file-download endpoints used by the backend.
   *
   * @param {string} url - Absolute or relative URL string; relative URLs are resolved against the current page origin.
   * @returns {boolean} `true` if the URL's pathname matches the backend file download patterns, `false` otherwise.
   */
  function isFileDownloadRequest(url) {
    try {
      const u = new URL(url, location.origin);
      return /^\/backend-api\/(files\/download\/file_[A-Za-z0-9]+|conversation\/[A-Za-z0-9-]+\/interpreter\/download)$/i.test(u.pathname);
    } catch {
      return false;
    }
  }

  /**
   * Extracts a file identifier and its associated conversation id from a download URL.
   *
   * Attempts to parse known download URL patterns:
   * - Standard file downloads (/backend-api/files/download/:fileId) — returns the captured `fileId` and the `conversation_id` query param if present.
   * - Interpreter sandbox downloads (/backend-api/conversation/:conversationId/interpreter/download) — returns a sandbox-style `fileId` derived from `message_id` and `sandbox_path`, and the captured `conversationId`.
   * If parsing fails or the URL does not match expected shapes, returns empty strings for both fields.
   * @param {string} url - The download URL to inspect.
   * @returns {{fileId: string, conversationId: string}} `fileId` is the resolved file identifier (or empty string), `conversationId` is the associated conversation id (or empty string).
   */
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

  /**
   * Create a stable sandbox file identifier from a message ID and sandbox path.
   * @param {string} messageId - The message identifier to include in the id.
   * @param {string} sandboxPath - The sandbox-relative path to include in the id.
   * @returns {string} A string of the form `"sandbox:<hash>"` computed from `messageId: sandboxPath`, or an empty string if either input is falsy.
   */
  function buildSandboxFileId(messageId, sandboxPath) {
    if (!messageId || !sandboxPath) return "";
    return "sandbox:" + hash(`${messageId}:${sandboxPath}`);
  }

  /**
   * Compute a compact 32-bit hash of a string and return it as a base-36 unsigned string.
   * @param {string} str - Input string to hash.
   * @returns {string} Base-36 representation of the unsigned 32-bit hash.
   */
  function hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (h << 5) - h + str.charCodeAt(i);
      h |= 0;
    }
    return (h >>> 0).toString(36);
  }


  /**
   * Normalize a raw fetch response into a conversation object when present.
   *
   * Accepts either a top-level conversation payload (has `conversation_id`, `current_node`, and `mapping`) or a wrapper object with a `conversation` field containing those properties, and returns that conversation object; returns `null` if neither shape is recognized.
   *
   * @param {any} data - The parsed JSON response to inspect.
   * @returns {Object|null} The normalized conversation object, or `null` if `data` does not contain a valid conversation payload.
   */
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

  /**
   * Extract the current conversation id from the active ChatGPT URL.
   *
   * @returns {?string} Conversation id or "" when the page is not a conversation route.
   */
  function getConversationIdFromLocation() {
    const path = location.pathname;

    // 通常会話 /c/<id> だが、WEB:... のような ":" 含みも許可
    let m = path.match(/\/c\/([^/?#]+)/i);
    if (m) return m[1];

    // プロジェクト内チャット
    m = path.match(/\/g\/[^/]+\/c\/([a-z0-9-]+)/i);
    return m ? m[1] : "";
  }


  // =========================================================
  // ANALYZE / PRUNE HELPERS
  /**
   * Compute basic conversation statistics (turns, total text length, image count, and attachment count) from conversation data.
   * @param {object} data - Conversation payload or object containing a `mapping` of nodes.
   * @returns {{turnCount:number,textLength:number,imageCount:number,attachmentCount:number}} Object with counts: `turnCount` number of user/assistant turns, `textLength` total characters across text parts, `imageCount` number of image asset parts, and `attachmentCount` number of file/attachment assets.
   */
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

  /**
   * Adjusts the recommended number of recent conversation messages to retain based on conversation statistics.
   *
   * `@param` {number} baseKeepDomMessages - Preferred base keep count; when falsy the function falls back to CONFIG.turnCount or 15.
   * `@param` {{turnCount?: number, textLength?: number, imageCount?: number, attachmentCount?: number}} stats - Conversation statistics used to compute a heuristic score: `turnCount`, cumulative `textLength`, number of `imageCount`, and `attachmentCount`.
   * `@returns` {number} The adjusted keep count (an integer) computed from the heuristic score, bounded to sensible minima and maxima.
   */
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

  /**
   * Sends an "autoAdjustResult" message to the page host containing pruning decision details for a conversation.
   * @param {string} conversationId - The conversation identifier this result pertains to.
   * @param {string|null} projectName - The project or sidebar name associated with the conversation, or null if unknown.
   * @param {number} baseKeepDomMessages - The original configured number of DOM messages to keep.
   * @param {number} effectiveKeepDomMessages - The adjusted number of DOM messages recommended after analysis.
   * @param {Object} stats - Aggregate conversation statistics used to compute the adjustment (e.g., turnCount, textLength, imageCount, attachmentCount).
   */
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

  /**
   * Notify the content layer about initial-response pruning metadata so it can restore a DOM omission notice.
   *
   * @param {string} conversationId - Conversation identifier.
   * @param {{omittedCount?: number, firstMessageId?: string, firstKeptId?: string, firstMessage?: Object|null}} meta - Initial prune display metadata.
   */
  function postInitialPruneMeta(conversationId, meta) {
    window.postMessage(
      {
        source: "cgo-prune-runtime",
        type: "initialPruneMeta",
        conversationId,
        meta: meta || {},
      },
      "*"
    );
  }

  /**
   * Post metadata about the preserved conversation head to the content layer.
   *
   * @param {string} conversationId - Conversation identifier.
   * @param {Object} meta - First-message metadata payload.
   */
  function postConversationHeadMeta(conversationId, meta) {
    window.postMessage(
      {
        source: "cgo-prune-runtime",
        type: "conversationHeadMeta",
        conversationId,
        meta: meta || {},
      },
      "*"
    );
  }

  /**
   * Build the metadata needed to recreate the original first conversation message after pruning.
   *
   * @param {Object} data - Conversation payload.
   * @returns {?Object} Head metadata or `null` when unavailable.
   */
  function buildConversationHeadMeta(data) {
    const mapping = getMapping(data);
    const currentNode = getCurrentNode(data);

    if (!currentNode || !mapping[currentNode]) return null;

    const chain = buildLinearChain(mapping, currentNode);
    const firstConversationId = getFirstConversationNodeId(mapping, chain);

    if (!firstConversationId) return null;

    return {
      firstMessageId: firstConversationId,
      firstMessage: buildInitialMessagePayload(mapping, firstConversationId),
    };
  }

  /**
   * Builds a linear chain of node ids from the root to the specified current node by following parent links.
   *
   * @param {Object} mapping - Map of node id to node object; nodes may include a `parent` property referencing another node id.
   * @param {string|null} currentNode - The starting node id; if falsy or not present in mapping, returns an empty array.
   * @returns {string[]} Array of node ids ordered from the root (earliest ancestor) to the specified current node.
   */
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

  /**
   * Selects node IDs from a chain that correspond to meaningful conversation nodes.
   * @param {Object} mapping - Map-like object keyed by node ID containing node records.
   * @param {string[]} chain - Ordered array of node IDs representing a linear chain from root to current.
   * @returns {string[]} Array of node IDs from `chain` whose corresponding nodes are meaningful conversation nodes, in the same order as `chain`.
   */
  function getConversationalIds(mapping, chain) {
    return chain.filter((id) => isMeaningfulConversationNode(mapping[id]));
  }

  /**
   * Moves the proposed start index earlier in the chain until the node immediately before it is a meaningful conversation node.
   * @param {Object.<string, Object>} mapping - Map of node IDs to node objects.
   * @param {string[]} chain - Ordered array of node IDs representing the linear chain (root → current).
   * @param {number} desiredStartIndex - Initial index in `chain` representing the proposed start position.
   * @returns {number} An adjusted index within `chain` less than or equal to `desiredStartIndex` such that either it is `0` or the node at `chain[index - 1]` is meaningful.
   */
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

  /**
   * Selects a suffix of the conversation chain to keep based on the most recent conversational turns.
   *
   * Iterates the chain to find indexes of meaningful conversation nodes (user/assistant), takes the last
   * `turnCount` of those, then expands the start index to a "safe" boundary using `findSafeStartIndex`.
   * If no meaningful conversational nodes exist, returns a set containing only the last node in the chain.
   *
   * @param {Object.<string, Object>} mapping - Map of nodeId to node objects used to evaluate meaningfulness.
   * @param {string[]} chain - Linear chain of node IDs in forward (root-to-current) order.
   * @param {number} turnCount - Number of recent conversational turns to preserve.
   * @returns {Set<string>} A set of node IDs representing the suffix of the chain to keep.
   */
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

  /**
   * Expand a set of node ids to also contain any nodes whose parent links connect them to the set.
   *
   * Repeatedly adds nodes from `mapping` whose `parent` is already in `keepSet` until no further nodes can be added.
   *
   * @param {Object.<string, {parent?: string}>} mapping - Map of node id to node object; nodes may have a `parent` id.
   * @param {Set<string>} keepSet - Set of node ids to expand; this set is mutated in place.
   * @returns {Set<string>} The same `keepSet` instance with descendant node ids added.
   */
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

  /**
   * Summarizes counts for a set of kept conversation node IDs.
   * @param {Object<string, any>} mapping - Object mapping node ids to node objects.
   * @param {Set<string>} keepSet - Set of node ids to include in the summary.
   * @returns {{mappingCount: number, nodesWithMessage: number, userCount: number, assistantCount: number, systemCount: number}} An object with counts: total ids considered (`mappingCount`), how many nodes have a message (`nodesWithMessage`), and counts by role (`userCount`, `assistantCount`, `systemCount`).
   */
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

  /**
   * Determines whether a node reachable from `startId` (by following `parent` links) equals `targetId`.
   *
   * @param {Object.<string, {parent?: string}>} mapping - Map of node id to node object; each node may have a `parent` id.
   * @param {string|null|undefined} startId - Id of the starting node to walk upward from.
   * @param {string|null|undefined} targetId - Id of the target node to test for reachability.
   * @returns {boolean} `true` if walking parent links from `startId` encounters `targetId`, `false` otherwise.
   */
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

  /**
   * Build a compact diagnostic summary for a mapping node.
   * @param {Object} mapping - Conversation node map.
   * @param {string} id - Node id to summarize.
   * @returns {Object} Debug-friendly node summary.
   */
  function summarizeMessageNode(mapping, id) {
    const node = id ? mapping?.[id] : null;
    const msg = node?.message || null;

    return {
      id: id || "",
      exists: !!node,
      parent: node?.parent || "",
      role: msg?.author?.role || "",
      contentType: msg?.content?.content_type || "",
      textLength: getMessageTextFallback(msg).length,
      childCount: Array.isArray(node?.children) ? node.children.length : 0,
      hidden: !!msg?.metadata?.is_visually_hidden_from_conversation,
      command: msg?.metadata?.command || "",
    };
  }

  /**
   * Build head/tail diagnostics for the parent chain ending at `currentNode`.
   * @param {Object} mapping - Conversation node map.
   * @param {string} currentNode - Current chain tail id.
   * @param {number} [limit=12] - Maximum node summaries to include for head/tail.
   * @returns {Object} Chain diagnostic payload.
   */
  function buildChainDiagnostics(mapping, currentNode, limit = 12) {
    const seen = new Set();
    const chain = [];
    let cursor = currentNode || "";

    while (cursor && mapping?.[cursor] && !seen.has(cursor)) {
      seen.add(cursor);
      chain.push(cursor);
      cursor = mapping[cursor]?.parent || "";
    }

    const forward = chain.slice().reverse();

    return {
      currentNode: currentNode || "",
      chainLength: chain.length,
      reachedRoot: forward[0] === CONFIG.rootNodeId,
      head: forward.slice(0, limit).map((nodeId) => summarizeMessageNode(mapping, nodeId)),
      tail: forward.slice(-limit).map((nodeId) => summarizeMessageNode(mapping, nodeId)),
    };
  }

  /**
   * Check whether a message contains generated image asset pointer parts.
   * @param {Object} message - Conversation message payload.
   * @returns {boolean} `true` when image asset pointers are present.
   */
  function hasGeneratedImageAssetPointer(message) {
    const parts = Array.isArray(message?.content?.parts)
      ? message.content.parts
      : [];

    return parts.some((part) =>
      part &&
      typeof part === "object" &&
      part.content_type === "image_asset_pointer" &&
      typeof part.asset_pointer === "string" &&
      part.asset_pointer
    );
  }

  /**
   * Collect generated-image tool nodes with parent summaries for merge diagnostics.
   * @param {Object} mapping - Conversation node map.
   * @returns {Object[]} Generated-image tool diagnostics.
   */
  function collectGeneratedImageToolDiagnostics(mapping) {
    const out = [];

    for (const [id, node] of Object.entries(mapping || {})) {
      const msg = node?.message;
      if (msg?.author?.role !== "tool") continue;
      if (!hasGeneratedImageAssetPointer(msg)) continue;

      out.push({
        id,
        parent: node?.parent || "",
        role: msg?.author?.role || "",
        contentType: msg?.content?.content_type || "",
        assetCount: Array.isArray(msg?.content?.parts)
          ? msg.content.parts.filter((part) => part?.content_type === "image_asset_pointer").length
          : 0,
        parentSummary: summarizeMessageNode(mapping, node?.parent || ""),
      });
    }

    return out;
  }

  /**
   * Ensure the stream conversation's root is attached to the tail of the full conversation so the stream becomes reachable from the full tail.
   * Modifies `merged.mapping` by reparenting the stream's root node to the full tail when appropriate.
   * @param {Object} full - Full conversation object; expected to contain `current_node` and a `mapping` of nodes.
   * @param {Object} stream - Stream conversation object; expected to contain `current_node` and a `mapping` of nodes.
   * @param {Object} merged - The merged conversation object whose `mapping` will be adjusted.
   * @returns {boolean} `true` if the stream's current node is connected to the full conversation tail after attempting to anchor, `false` otherwise.
   */
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

  /**
   * Merge a full conversation export with a streaming draft, preferring streamed message content when present.
   *
   * Merges mapping entries from `stream` into a structured clone of `full`, preserving existing fields but choosing
   * `message.content` from the stream node if it contains non-empty `content.parts`. Rebuilds child relationships,
   * attempts to anchor stream roots into the full conversation tail, and selects an appropriate `current_node`
   * (preferring a stream current node when it is connected to the full current node).
   *
   * @param {object} full - Full conversation object (expected to contain `mapping` — a map of node id -> node — and `current_node`).
   * @param {object} stream - Streaming/draft conversation object (same shape as `full`) whose mapping entries should be merged into `full`.
   * @returns {object} A new conversation object representing the merged result with reconciled mapping, rebuilt `children`, and chosen `current_node`.
   */
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

    log("[mergeCaches:summary]", {
      fullCurrent: full?.current_node || "",
      streamCurrent: stream?.current_node || "",
      mergedCurrent: merged?.current_node || "",
      streamConnectedToFull:
        !!streamCurrent &&
        !!fullCurrent &&
        isNodeConnectedToTarget(merged.mapping, streamCurrent, fullCurrent),
      fullChainLength: buildChainDiagnostics(full.mapping || {}, full.current_node).chainLength,
      streamChainLength: buildChainDiagnostics(stream.mapping || {}, stream.current_node).chainLength,
      mergedChainLength: buildChainDiagnostics(merged.mapping || {}, merged.current_node).chainLength,
      generatedImageToolCount: collectGeneratedImageToolDiagnostics(merged.mapping).length,
    });

    return merged;
  }

  /**
   * Produce a pruning analysis and keep-plan for a conversation payload.
   *
   * Builds a linear chain from the conversation's current node, identifies conversational nodes,
   * selects a recent suffix of turns to keep (bounded by `turnCount`), expands that set to include
   * child nodes, and summarizes counts usable for pruning decisions and previews.
   *
   * @param {object} data - Conversation payload containing `mapping`, `current_node`, and metadata.
   * @param {number} [turnCount=CONFIG.turnCount] - Number of recent conversational turns to consider for the keep set.
   * @returns {object} An analysis object containing:
   *  - `conversationId` (string|null) — the conversation id if present.
   *  - `title` (string) — conversation title if present.
   *  - `currentNode` (string|null) — the id of the current node.
   *  - `original` (object) — original counts: `mappingCount`, `chainLength`, and `conversationalLength`.
   *  - `prunePlan` (object) — plan details including `turnCount`, `recentConversationCount`, `keepNodeCount`, and role-based summaries.
   *  - `recentConversation` (Array) — array of recent conversational node previews with `id`, `role`, `textLength`, and `parent`.
   *  - `keepNodeIdsPreview` (Array) — a truncated preview (up to 30) of node ids that would be kept.
   *  - If the `current_node` is missing or not found, the object includes an `error` string instead of analysis fields.
   */
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

  /**
   * Decides whether pruning should be skipped for a conversation summary.
   * @param {Object} summary - Conversation analysis result; expected to include `original.chainLength` and `prunePlan.keepNodeCount`.
   * @returns {boolean} `true` if pruning should be skipped (when `chainLength` is zero or when `keepNodeCount` is greater than 90% of `chainLength`), `false` otherwise.
   */
  function shouldSkipPrune(summary) {
    const chainLength = summary?.original?.chainLength || 0;
    const keepNodeCount = summary?.prunePlan?.keepNodeCount || 0;

    if (!chainLength) return true;

    const keepRatio = keepNodeCount / chainLength;
    if (keepRatio > 0.9) return true;

    return false;
  }

  /**
   * Produce a structured clone of the given node to preserve the original object.
   * @param {any} node - The value (typically a conversation mapping node) to clone. If not an object, it is returned unchanged.
   * @returns {any} A structured clone of `node` when `node` is an object, otherwise the original `node`.
   */
  function lightenNode(node) {
    if (!node || typeof node !== "object") return node;

    return structuredClone(node);
  }

  /**
   * Return the first meaningful kept conversation node id in the kept chain.
   *
   * @param {Object<string, any>} mapping - Conversation node mapping.
   * @param {string[]} keptChain - Ordered kept root-to-current chain.
   * @returns {string} First meaningful kept node id, or an empty string.
   */
  function getFirstKeptConversationNodeId(mapping, keptChain) {
    for (const id of keptChain) {
      if (isMeaningfulConversationNode(mapping[id])) {
        return id;
      }
    }
    return "";
  }

  /**
   * Return the first meaningful conversation node id in the current linear chain.
   *
   * @param {Object<string, any>} mapping - Conversation node mapping.
   * @param {string[]} chain - Ordered root-to-current chain.
   * @returns {string} First meaningful node id, or an empty string.
   */
  function getFirstConversationNodeId(mapping, chain) {
    for (const id of chain) {
      if (isMeaningfulConversationNode(mapping[id])) {
        return id;
      }
    }
    return "";
  }

  /**
   * Extract a compact, serializable message payload for DOM-side restoration.
   *
   * @param {Object<string, any>} mapping - Conversation node mapping.
   * @param {string} messageId - Message node id.
   * @returns {{id: string, role: string, createTime: number|null, text: string, renderText: string, isVoiceTranscription: boolean, voiceDirection: string, hasVoiceAudio: boolean}|null} Minimal message payload.
   */
  function buildInitialMessagePayload(mapping, messageId) {
    const message = mapping?.[messageId]?.message;
    if (!message || typeof message !== "object") return null;

    annotateMessageForCgo(message);

    const text = getMessageTextFallback(message);
    const cgoMeta = message?.metadata?.cgo || {};

    return {
      id: messageId,
      role: String(message?.author?.role || "user"),
      createTime: message?.create_time ?? null,
      text,
      renderText: text,
      isVoiceTranscription: !!cgoMeta.is_voice_transcription,
      voiceDirection: cgoMeta.voice_direction || "",
      hasVoiceAudio: !!cgoMeta.has_voice_audio,
    };
  }

  /**
   * Produce a pruned copy of a conversation payload that retains a recent suffix of turns and their descendant nodes while preserving structural integrity.
   *
   * The function selects a suffix of conversational nodes (limited by `turnCount`), expands that set to include all descendant nodes, and constructs a new `mapping` containing only those nodes. It always preserves the configured root node, reconnects the first kept chain node as a direct child of the root, and adjusts parent pointers for any kept node whose parent was removed so the mapping remains consistent. If `data.current_node` is missing or invalid, the original `data` is returned unchanged.
   *
   * @param {Object} data - The conversation payload containing a `mapping` and `current_node`.
   * @param {number} [turnCount=CONFIG.turnCount] - Number of recent conversational turns to keep before expanding with children.
   * @returns {Object} The conversation payload with `mapping` replaced by the pruned mapping and `current_node` preserved.
   */
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
    const firstConversationId = getFirstConversationNodeId(mapping, chain);
    const keptChain = chain.filter((id) => keepSet.has(id));
    const firstKeptId = keptChain[0] || "";
    const firstKeptConversationId = getFirstKeptConversationNodeId(mapping, keptChain);

    const conversationalIds = getConversationalIds(mapping, chain);
    const firstConversationIndex = conversationalIds.indexOf(firstConversationId);
    const firstKeptConversationIndex = conversationalIds.indexOf(firstKeptConversationId);

    const omittedCount =
      firstConversationId &&
        firstKeptConversationId &&
        firstConversationIndex >= 0 &&
        firstKeptConversationIndex > firstConversationIndex
        ? Math.max(0, firstKeptConversationIndex - firstConversationIndex - 1)
        : 0;

    data.__cgoInitialPruneMeta = {
      omittedCount,
      firstKeptId: firstKeptConversationId,
    };

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
    const reconnectHeadId = keptChain[0];

    if (reconnectHeadId && prunedMapping[reconnectHeadId] && prunedMapping[rootId]) {
      prunedMapping[reconnectHeadId] = {
        ...prunedMapping[reconnectHeadId],
        parent: rootId,
      };

      prunedMapping[rootId].children = [reconnectHeadId];
    }

    // 4) parent が消えてしまった node は root か kept 親へ補正
    for (const [id, node] of Object.entries(prunedMapping)) {
      if (id === rootId) continue;

      const parentId = node?.parent;
      if (!parentId || !prunedMapping[parentId]) {
        prunedMapping[id] = {
          ...node,
          parent: id === reconnectHeadId ? (rootNode ? rootId : null) : node.parent,
        };
      }
    }

    log("prune mapping integrity", {
      originalCount: Object.keys(mapping).length,
      prunedCount: Object.keys(prunedMapping).length,
      rootChildren: prunedMapping[rootId]?.children || [],
      firstConversationId,
      firstKeptId,
      firstKeptConversationId,
      omittedCount,
      currentNode,
    });

    return {
      ...data,
      mapping: prunedMapping,
      current_node: currentNode,
    };
  }

  /**
   * Extracts the `Authorization` header value from fetch-style call arguments.
   *
   * @param {Array} args - The original arguments passed to `fetch`: `args[0]` is the input (URL string or `Request`), `args[1]` is the optional init object with `headers`.
   * @returns {string} The `Authorization` header value if present, otherwise an empty string.
   */
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

  /**
   * Recomputes each node's `children` arrays from the nodes' `parent` pointers, modifying `mapping` in place.
   * @param {Object<string, {parent?: string, children?: string[]}>} mapping - Map from node id to node object; each node may have a `parent` id. After calling, every node's `children` will be an array of its direct child ids.
   */
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

  /**
   * Extracts a topic identifier from several possible payload shapes.
   * @param {object} payload - Object that may contain `topic_id` directly or nested under `v`, `data`, `payload`, or `body`.
   * @returns {string} The topic id if present, otherwise an empty string.
   */
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

  /**
   * Extracts the `turn_exchange_id` from a payload that may use several nested shapes.
   *
   * @param {object} payload - Incoming payload which may contain `turn_exchange_id` at top level or under `v`, `data`, `payload`, or `body`.
   * @returns {string} The `turn_exchange_id` if found, otherwise an empty string.
   */
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

  /**
   * Cache topic and turn-exchange identifiers found in a stream payload to a conversation id.
   *
   * If `payload` contains a topic id or a turn-exchange id, store mappings from those ids
   * to `conversationId` in the module-level caches so incoming stream events can be resolved
   * to the correct conversation.
   *
   * @param {Object} payload - A stream-related payload (SSE/WebSocket) that may contain topic or turn-exchange identifiers.
   * @param {string} conversationId - The conversation id to associate with any discovered identifiers.
   */
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

  /**
   * Resolve a conversation id from a streaming payload using cached topic or turn-exchange mappings.
   *
   * @param {object} payload - A stream-related payload object (SSE/WS) that may contain topic or turn-exchange identifiers in several possible shapes.
   * @returns {string} The associated conversation id if found in the cache, or an empty string otherwise.
   */
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

  /**
   * Parse a JSON string and return the parsed value or `null` on failure.
   * @param {string} value - The JSON string to parse.
   * @returns {*} The parsed value, or `null` if `value` is not a string or is not valid JSON.
   */
  function parseJsonStringSafe(value) {
    if (typeof value !== "string") return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  /**
   * Extract parsed JSON payloads from an SSE text block.
   * @param {string} value - SSE-like text containing `data:` lines.
   * @returns {Object[]} Parsed JSON data payloads.
   */
  function parseJsonPayloadsFromSseText(value) {
    if (typeof value !== "string" || !value.includes("data:")) return [];

    const out = [];
    const lines = value.split(/\r?\n/);

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;

      const raw = line.slice(5).trim();
      if (!raw || raw === "[DONE]") continue;

      const parsed = parseJsonStringSafe(raw);
      if (parsed && typeof parsed === "object") {
        out.push(parsed);
      }
    }

    return out;
  }

  /**
   * Traverse a value breadth-first and invoke `visitor` for each discovered object payload.
   *
   * This function performs a guarded, breadth-first walk of the provided value, parsing JSON strings when encountered and enqueuing their parsed results. It protects against cycles and common stream wrapper shapes by inspecting known nested fields (e.g., `data`, `payload`, `message`, `v`, `ops`, `delta`, `items`, `messages`, etc.) as well as all object property values.
   *
   * @param {*} value - Root value to inspect; may be any type. String values that parse as JSON are parsed and enqueued for further traversal.
   * @param {(obj: Object) => void} visitor - Callback invoked once for each object node discovered (cycle-protected). Arrays are traversed but array containers themselves are not passed to `visitor`.
   */
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

  /**
   * Get the internal Object.prototype.toString tag for a value.
   * @param {*} data - The value to inspect.
   * @returns {string} A string in the form `[object Type]` (for example, `[object Array]`, `[object ArrayBuffer]`, `[object String]`).
   */
  function getWsDataTypeName(data) {
    return Object.prototype.toString.call(data);
  }

  /**
   * Decode various WebSocket data payloads into a UTF-8 string.
   * @param {string|Blob|ArrayBuffer|ArrayBufferView|any} data - The incoming WebSocket frame payload.
   * @returns {string} The decoded text for string, Blob, ArrayBuffer, or ArrayBufferView inputs; an empty string for unsupported types.
   */
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

  /**
   * Decode and process a single WebSocket frame: parse JSON payloads, route SSE-style
   * conversation stream items into the SSE block processor, and forward other payloads
   * as generic messages.
   *
   * When a payload of type `"conversation-turn-stream"` with a nested `"stream-item"` and
   * an `encoded_item` string is encountered, extracts a topic id and conversation id,
   * updates `LAST_STREAM_CONVERSATION_ID` and topic->conversation caches, then passes the
   * `encoded_item` to `processSseBlock` with a per-topic parser state. All other visited
   * payload objects are delivered to `handleSseEvent` with event name `"message"`.
   *
   * @param {*} rawData - The raw WebSocket frame data (string, Blob, ArrayBuffer, etc.).
   * @param {string} [source] - Short label for the frame origin (used in logs), e.g. `"ws"`, `"ws-send"`, or `"ws-message"`.
   */
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

  /**
   * Installs a WebSocket wrapper that intercepts outgoing and incoming frames for parsing.
   *
   * Replaces window.WebSocket with a wrapper constructor that preserves the original WebSocket constructor,
   * forwards all normal behavior, and calls `handleWebSocketFrame` for data passed to `send` and for
   * incoming `message` events. The original constructor is stored on `window.__CGO_ORIGINAL_WEBSOCKET__`
   * and the installation is guarded to run only once (marks `window.__CGO_WEBSOCKET_PATCHED__`).
   */
  function patchWebSocket() {
    const NativeWebSocket = window.WebSocket;
    if (!NativeWebSocket || window.__CGO_WEBSOCKET_PATCHED__) return;

    window.__CGO_ORIGINAL_WEBSOCKET__ =
      window.__CGO_ORIGINAL_WEBSOCKET__ || NativeWebSocket;

    /**
     * Wrapped `WebSocket` constructor that mirrors frames into the stream parser.
     *
     * @param {string|URL} url - WebSocket endpoint.
     * @param {string|string[]} [protocols] - Optional negotiated subprotocols.
     * @returns {WebSocket} Wrapped native WebSocket instance.
     */
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

  /**
   * Retrieve or create the SSE/WebSocket stream parser state associated with a topic.
   * @param {string} topicId - Stream topic identifier.
   * @returns {{currentEventName: string}} The parser state object for the topic; contains `currentEventName` (defaults to "message").
   */
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
  /**
   * Normalize a project name by trimming surrounding whitespace; returns an empty string for non-string inputs.
   * @param {*} value - The input to normalize; expected to be a project name string.
   * @returns {string} The trimmed project name, or an empty string if the input is not a string.
   */
  function normalizeProjectName(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  /**
   * Populate project-name caches from a sidebar payload.
   *
   * Extracts normalized project names from sidebar `items` and stores them in
   * PROJECT_NAME_BY_GIZMO_ID (keyed by gizmo id) and PROJECT_NAME_BY_CONVERSATION_ID
   * (keyed by conversation id) for later lookup.
   *
   * @param {object} data - Sidebar payload that may contain an `items` array with gizmo and conversation entries.
   */
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

  /**
   * Attach a cached project name to a conversation payload when one can be resolved.
   *
   * If `data` is an object and contains a matching conversation or template/gizmo identifier,
   * sets `data.project_name` to the resolved project name and returns the same object.
   *
   * @param {object} data - Conversation payload object that may contain identifiers like `conversation_id`, `gizmo_id`, or `conversation_template_id`; this object may be mutated.
   * @returns {object|any} The original `data` object with `project_name` set when available; returns the original value unchanged for non-object inputs.
   */
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

  /**
   * Stores a conversation payload in the export cache keyed by its `conversation_id`.
   *
   * If `data.conversation_id` is missing the function returns without storing.
   * Ensures the conversation has project name applied, stores a structured clone in EXPORT_CACHE,
   * and sets `window.__CGO_EXPORT_CACHE = true`.
   *
   * @param {object} data - The conversation payload object that must include `conversation_id`.
   */
  function saveFullConversationToCache(data) {
    const conversationId = data?.conversation_id;
    if (!conversationId) return;

    annotateConversationForCgo(data);
    applyProjectNameToConversation(data);

    EXPORT_CACHE.set(conversationId, structuredClone(data));
    window.__CGO_EXPORT_CACHE = true;
  }

  /**
   * Retrieve or create the stream-stage cache object for a conversation ID.
   * @param {string} conversationId - Conversation identifier used as the cache key.
   * @returns {object} The stream cache entry for the conversation: an existing draft if present, a copy of the exported conversation if available, or a new empty draft stored in STREAM_CACHE.
   */
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

  /**
   * Extract a nested payload object from a wrapped `"message"` event payload.
   *
   * @param {Object} payload - Wrapper payload emitted by transport hooks.
   * @returns {Object|null} Nested payload object or `null`.
   */
  function getNestedPayloadFromMessageWrapper(payload) {
    if (!payload || typeof payload !== "object") return null;
    if (payload.type !== "message") return null;

    const candidates = [
      payload.payload,
      payload.data,
      payload.body,
      payload.message,
    ];

    for (const candidate of candidates) {
      if (!candidate) continue;

      if (typeof candidate === "string") {
        const parsed = parseJsonStringSafe(candidate);
        if (parsed && typeof parsed === "object") return parsed;
      }

      if (typeof candidate === "object") {
        return candidate;
      }
    }

    return null;
  }

  /**
   * Add object payload candidates to `out`, parsing JSON/SSE strings and arrays.
   * @param {*} candidate - Candidate nested stream payload.
   * @param {Object[]} out - Mutable output list.
   */
  function collectNestedStreamPayloadCandidate(candidate, out) {
    if (!candidate) return;

    if (typeof candidate === "string") {
      const parsed = parseJsonStringSafe(candidate);
      if (parsed && typeof parsed === "object") {
        collectNestedStreamPayloadCandidate(parsed, out);
        return;
      }

      const ssePayloads = parseJsonPayloadsFromSseText(candidate);
      if (ssePayloads.length) {
        collectNestedStreamPayloadCandidate(ssePayloads, out);
      }
      return;
    }

    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        collectNestedStreamPayloadCandidate(item, out);
      }
      return;
    }

    if (typeof candidate === "object") {
      out.push(candidate);

      if (typeof candidate.encoded_item === "string") {
        collectNestedStreamPayloadCandidate(candidate.encoded_item, out);
      }
    }
  }

  /**
   * Extract nested payloads from a conversation-turn-stream wrapper.
   * @param {*} payload - Parsed stream payload.
   * @returns {Object[]} Nested payload objects in discovery order.
   */
  function getNestedPayloadsFromConversationTurnStream(payload) {
    if (!payload || typeof payload !== "object") return [];
    if (payload.type !== "conversation-turn-stream") return [];

    const out = [];
    const candidates = [
      payload.payload,
      payload.data,
      payload.body,
      payload.message,
      payload.item,
      payload.event,
      payload.value,
      payload.update,
      payload.update_content,
    ];

    for (const candidate of candidates) {
      collectNestedStreamPayloadCandidate(candidate, out);
    }

    if (Array.isArray(payload.messages)) {
      collectNestedStreamPayloadCandidate({ messages: payload.messages }, out);
    }

    if (Array.isArray(payload.events)) {
      for (const event of payload.events) {
        collectNestedStreamPayloadCandidate(event, out);
      }
    }

    if (Array.isArray(payload.items)) {
      for (const item of payload.items) {
        collectNestedStreamPayloadCandidate(item, out);
      }
    }

    return out;
  }

  /**
   * Collect message arrays from known stream payload wrapper shapes.
   * @param {*} payload - Parsed stream payload.
   * @returns {Object[]} Message objects with ids.
   */
  function getMessagesFromPayload(payload) {
    const out = [];
    const seen = new Set();
    const candidates = [
      payload?.messages,
      payload?.update_content?.messages,
      payload?.payload?.messages,
      payload?.payload?.update_content?.messages,
      payload?.data?.messages,
      payload?.data?.update_content?.messages,
      payload?.body?.messages,
      payload?.body?.update_content?.messages,
      payload?.item?.messages,
      payload?.item?.update_content?.messages,
    ];

    for (const candidate of candidates) {
      if (!Array.isArray(candidate)) continue;
      for (const msg of candidate) {
        if (!msg?.id || seen.has(msg.id)) continue;
        seen.add(msg.id);
        out.push(msg);
      }
    }

    return out;
  }

  /**
   * Parse a JSON request body from intercepted `fetch` arguments when available.
   *
   * @param {Array} args - Original `fetch` argument list.
   * @returns {Object|null} Parsed request body or `null`.
   */
  function parseJsonRequestBodyFromFetchArgs(args) {
    const init = args?.[1] || {};
    const body = init?.body;

    if (typeof body === "string" && body.trim()) {
      try {
        return JSON.parse(body);
      } catch {
        return null;
      }
    }

    if (body instanceof URLSearchParams) {
      const text = body.toString();
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    }

    return null;
  }

  /**
   * Create a stable synthetic id for request-side user messages that lack one.
   *
   * @returns {string} Synthetic message id.
   */
  function createSyntheticUserRequestMessageId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }

    return `cgo-user-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  /**
   * Normalize a user message candidate from request payload data into conversation shape.
   *
   * @param {Object} value - Raw request payload value.
   * @returns {Object|null} Normalized user message or `null`.
   */
  function normalizeUserRequestMessage(value) {
    const msg = value?.message && typeof value.message === "object"
      ? value.message
      : value;

    if (!msg || typeof msg !== "object") return null;

    const id =
      msg.id ||
      value?.id ||
      createSyntheticUserRequestMessageId();

    let content = msg.content || value?.content || null;

    if (!content) {
      const text = value?.text || msg.text || "";
      content = {
        content_type: "text",
        parts: text ? [String(text)] : [],
      };
    }

    if (typeof content?.text === "string" && !Array.isArray(content.parts)) {
      content = {
        content_type: "text",
        parts: [content.text],
      };
    }

    return {
      ...msg,
      id,
      author: {
        ...(msg.author || {}),
        role: "user",
      },
      content,
      metadata: {
        ...(msg.metadata || {}),
      },
      create_time: msg.create_time ?? Date.now() / 1000,
      status: msg.status || "finished_successfully",
      recipient: msg.recipient || "all",
    };
  }

  /**
   * Collect normalized user messages from an intercepted request body.
   *
   * @param {Object} body - Parsed request body.
   * @returns {Object[]} Normalized user messages.
   */
  function collectUserMessagesFromRequestBody(body) {
    const out = [];
    const seen = new Set();

    /**
     * Add a normalized user message when it has a unique id.
     *
     * @param {Object} value - Raw user-message candidate.
     * @returns {void}
     */
    function pushMessage(value) {
      const msg = normalizeUserRequestMessage(value);
      if (!msg?.id || seen.has(msg.id)) return;
      seen.add(msg.id);
      out.push(msg);
    }

    /**
     * Traverse a request payload recursively and collect embedded user messages.
     *
     * @param {*} value - Current payload node.
     * @returns {void}
     */
    function visit(value) {
      if (!value) return;

      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }

      if (typeof value !== "object") return;

      const role =
        value?.author?.role ||
        value?.message?.author?.role ||
        value?.role ||
        "";

      const id = value?.id || value?.message?.id || "";
      const content = value?.content || value?.message?.content || null;
      const hasText =
        Array.isArray(content?.parts) ||
        typeof content?.text === "string" ||
        typeof value?.text === "string" ||
        typeof value?.message?.text === "string";

      if (role === "user" && (id || hasText)) {
        pushMessage(value);
        return;
      }

      for (const key of [
        "messages",
        "message",
        "input_message",
        "input_messages",
        "payload",
        "conversation",
        "action",
      ]) {
        if (value[key]) visit(value[key]);
      }
    }

    visit(body);

    return out;
  }

  /**
   * Cache request-side user messages before the streaming response arrives.
   *
   * @param {Array} args - Original `fetch` argument list.
   * @param {string} url - Request URL used for logging context.
   * @returns {void}
   */
  function rememberUserMessagesFromStreamingRequest(args, url) {
    const body = parseJsonRequestBodyFromFetchArgs(args);
    if (!body) return;

    const conversationId =
      body.conversation_id ||
      body.conversationId ||
      getConversationIdFromLocation() ||
      LAST_STREAM_CONVERSATION_ID ||
      "";

    if (!conversationId) return;

    const topicId =
      body.topic_id ||
      body.topicId ||
      body.stream_topic_id ||
      "";

    const cache = ensureConversationCache(conversationId);
    ensureStreamState(conversationId, topicId);

    const userMessages = collectUserMessagesFromRequestBody(body);

    for (const msg of userMessages) {
      const parentId =
        msg?.metadata?.parent_id ||
        msg?.parent_id ||
        cache.current_node ||
        null;

      upsertMessageNode(cache, msg, parentId);
      rememberLatestInputMessageId(conversationId, topicId, msg);
    }

    if (userMessages.length) {
      log("[sse:request-user-input]", {
        conversationId,
        topicId,
        count: userMessages.length,
      });
    }
  }

  /**
   * Resolve the most specific event name for a nested stream payload.
   *
   * @param {string} fallbackEventName - Event name from the outer transport layer.
   * @param {Object} nested - Nested payload object.
   * @returns {string} Effective event name.
   */
  function getNestedEventNameFromPayload(fallbackEventName, nested) {
    if (nested?.event && typeof nested.event === "string") {
      return nested.event;
    }

    if (nested?.eventName && typeof nested.eventName === "string") {
      return nested.eventName;
    }

    if (
      nested &&
      typeof nested === "object" &&
      typeof nested.p === "string" &&
      typeof nested.o === "string"
    ) {
      return "delta";
    }

    return fallbackEventName;
  }

  /**
   * Detect messages that should be kept in the mapping but not treated as visible conversation turns.
   *
   * Internal/hidden/thought/context messages may be useful as structural or export metadata,
   * but must not become the stream patch target or export chain tail.
   *
   * @param {Object} message - Conversation message payload.
   * @returns {boolean} `true` for hidden/internal messages.
   */
  function isInternalConversationMessage(message) {
    const role = message?.author?.role || "";
    const metadata = message?.metadata || {};
    const contentType = message?.content?.content_type || "";

    if (metadata.is_visually_hidden_from_conversation) {
      return true;
    }

    if (contentType === "thoughts") {
      return true;
    }

    if (metadata.command === "context_stuff") {
      return true;
    }

    if (metadata.is_temporal_turn === true) {
      return true;
    }

    if (role === "assistant" && metadata.can_save === false) {
      return true;
    }

    return false;
  }

  /**
   * Decide whether a message should advance the conversation cache current node.
   *
   * Only visible user/assistant messages should become the export chain tail.
   *
   * @param {Object} message - Conversation message payload.
   * @returns {boolean} `true` when the message should update `cache.current_node`.
   */
  function shouldAdvanceConversationCurrent(message) {
    const role = message?.author?.role || "";

    if (role !== "user" && role !== "assistant") {
      return false;
    }

    if (isInternalConversationMessage(message)) {
      return false;
    }

    return true;
  }

  /**
   * Identify visible assistant messages that should receive streamed patch ops.
   * @param {Object} message - Message node object; expected to contain `author.role`.
   * @returns {boolean} `true` for visible assistant messages, `false` otherwise.
   */
  function shouldUseAsPatchedTarget(message) {
    if (!message || typeof message !== "object") return false;
    if (message?.author?.role !== "assistant") {
      return false;
    }

    if (isInternalConversationMessage(message)) {
      return false;
    }

    return true;
  }

  /**
   * Applies and clears any queued delta operations for the stream state's currently patched message.
   *
   * If `streamState.currentPatchedMessageId` is set and `streamState.pendingOps` contains ops,
   * this consumes all pending ops and applies them to the identified message in `cache`.
   *
   * @param {Object} cache - Conversation/stream cache containing `mapping` and message nodes.
   * @param {Object} streamState - Per-stream state object with `currentPatchedMessageId` (string) and `pendingOps` (array).
   */
  function flushPendingOps(cache, streamState) {
    if (!streamState?.currentPatchedMessageId) return;
    if (!Array.isArray(streamState.pendingOps) || !streamState.pendingOps.length) return;

    const ops = streamState.pendingOps.splice(0, streamState.pendingOps.length);
    applyDeltaOpsToMessage(cache, streamState.currentPatchedMessageId, ops);
  }

  /**
   * Insert or update a message node in a conversation cache mapping.
   *
   * Creates a new node for `message.id` if missing or replaces the stored
   * message with a structured clone. When `parentId` is provided, ensures
   * the parent node exists, adds the message id to the parent's `children`
   * if needed, and sets the node's `parent`.
   *
   * Updates `cache.current_node` only for visible user/assistant messages,
   * so hidden tool/internal messages can remain in the mapping without
   * becoming the export chain tail.
   *
   * @param {Object} cache - Conversation cache object containing at least a `mapping` object and `current_node` property.
   * @param {Object} message - Message object; must have an `id` property. If missing, the function is a no-op.
   * @param {string|undefined|null} [parentId] - Optional parent node id; when provided, attaches the message under this parent.
   */
  function upsertMessageNode(cache, message, parentId) {
    if (!message?.id) return;

    annotateMessageForCgo(message);

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

    if (shouldAdvanceConversationCurrent(message)) {
      cache.current_node = message.id;
    }
  }

  /**
   * Builds the lookup key for per-conversation (and optional topic-scoped) stream state.
   * @param {string} conversationId - The conversation identifier.
   * @param {string} [topicId=""] - Optional topic identifier; when present the key is namespaced to the topic.
   * @returns {string} The stream state key: `<conversationId>::<topicId>` if `topicId` is provided, otherwise `conversationId`.
   */
  function getStreamStateKey(conversationId, topicId = "") {
    return topicId ? `${conversationId}::${topicId}` : conversationId;
  }

  /**
   * Ensure the stream state exists for the specified conversation and topic.
   * @param {string} conversationId - Conversation identifier used to build the stream-state key.
   * @param {string} [topicId=""] - Optional topic identifier appended to the stream-state key.
   * @returns {{
   *   currentPatchedMessageId: (string|null),
   *   pendingOps: Array,
   *   lastTextAppendOp: ({p: string, o: string}|null),
   *   pendingGeneratedImageContent: (Object|null),
   *   lastInputMessageId: string
   * }}
   * `currentPatchedMessageId` is the message id currently being patched or `null`; `pendingOps` is an array that will hold pending delta operations.
   */
  function ensureStreamState(conversationId, topicId = "") {
    const key = getStreamStateKey(conversationId, topicId);
    let streamState = STREAM_STATE.get(key);

    if (!streamState) {
      streamState = {
        currentPatchedMessageId: null,
        pendingOps: [],
        lastTextAppendOp: null,
        pendingGeneratedImageContent: null,
        lastInputMessageId: "",
      };
      STREAM_STATE.set(key, streamState);
    }

    if (!Array.isArray(streamState.pendingOps)) {
      streamState.pendingOps = [];
    }

    if (!streamState.lastTextAppendOp) {
      streamState.lastTextAppendOp = null;
    }

    if (!("pendingGeneratedImageContent" in streamState)) {
      streamState.pendingGeneratedImageContent = null;
    }

    if (!("lastInputMessageId" in streamState)) {
      streamState.lastInputMessageId = "";
    }

    return streamState;
  }

  /**
   * Remember the most recent user input message id for a conversation/topic pair.
   *
   * @param {string} conversationId - Conversation identifier.
   * @param {string} topicId - Topic or stream identifier.
   * @param {Object} message - Candidate user message.
   * @returns {void}
   */
  function rememberLatestInputMessageId(conversationId, topicId, message) {
    if (!conversationId || !message?.id) return;
    if (message?.author?.role !== "user") return;

    const topicState = ensureStreamState(conversationId, topicId);
    topicState.lastInputMessageId = message.id;

    if (topicId) {
      const conversationState = ensureStreamState(conversationId, "");
      conversationState.lastInputMessageId = message.id;
    }
  }

  /**
   * Retrieve the latest remembered user input id for a conversation/topic pair.
   *
   * @param {string} conversationId - Conversation identifier.
   * @param {string} [topicId=""] - Topic or stream identifier.
   * @returns {string} Latest input message id or an empty string.
   */
  function getLatestInputMessageId(conversationId, topicId = "") {
    const topicState = topicId
      ? STREAM_STATE.get(getStreamStateKey(conversationId, topicId))
      : null;
    const conversationState = STREAM_STATE.get(getStreamStateKey(conversationId, ""));

    return (
      topicState?.lastInputMessageId ||
      conversationState?.lastInputMessageId ||
      ""
    );
  }

  /**
   * Walk a message's parent chain to find the oldest reachable node in its branch.
   *
   * @param {Object} mapping - Conversation node map.
   * @param {string} messageId - Starting message id.
   * @returns {string} Root node id or an empty string.
   */
  function findBranchRootForMessage(mapping, messageId) {
    if (!messageId || !mapping?.[messageId]) return "";

    const seen = new Set();
    let rootId = messageId;
    let cursor = messageId;

    while (cursor && mapping?.[cursor] && !seen.has(cursor)) {
      seen.add(cursor);
      rootId = cursor;

      const parentId = mapping[cursor]?.parent || "";
      if (!parentId || !mapping[parentId]) {
        break;
      }

      cursor = parentId;
    }

    return rootId || "";
  }

  /**
   * Find the highest branch node that is still safe to reattach under a different parent.
   *
   * @param {Object} mapping - Conversation node map.
   * @param {string} messageId - Starting message id.
   * @returns {string} Attachable branch root id or an empty string.
   */
  function findAttachableBranchRootForMessage(mapping, messageId) {
    if (!messageId || !mapping?.[messageId]) return "";

    const seen = new Set();
    let cursor = messageId;
    let lastNonRootId = messageId;

    while (cursor && mapping?.[cursor] && !seen.has(cursor)) {
      seen.add(cursor);

      const parentId = mapping[cursor]?.parent || "";

      if (!parentId || !mapping[parentId]) {
        return cursor === CONFIG.rootNodeId ? lastNonRootId : cursor;
      }

      if (parentId === CONFIG.rootNodeId) {
        return cursor;
      }

      lastNonRootId = parentId;
      cursor = parentId;
    }

    return lastNonRootId || "";
  }

  /**
   * Re-anchor a detached assistant branch under the latest remembered user input.
   *
   * @param {Object} cache - Conversation cache entry.
   * @param {string} conversationId - Conversation identifier.
   * @param {string} topicId - Topic or stream identifier.
   * @param {string} messageId - Assistant message to anchor.
   * @param {string} anchorReason - Log-friendly reason for the re-anchor.
   * @returns {boolean} `true` when the branch was re-anchored.
   */
  function anchorBranchToLatestInput(cache, conversationId, topicId, messageId, anchorReason) {
    const latestInputMessageId = getLatestInputMessageId(conversationId, topicId);
    const mapping = cache?.mapping || {};

    if (!latestInputMessageId) {
      return false;
    }

    if (!messageId) {
      return false;
    }

    if (!mapping[latestInputMessageId]) {
      return false;
    }

    if (!mapping[messageId]) {
      return false;
    }

    if (messageId === latestInputMessageId) {
      return false;
    }

    if (mapping[messageId]?.message?.author?.role === "user") {
      return false;
    }

    if (isNodeConnectedToTarget(mapping, messageId, latestInputMessageId)) {
      return false;
    }

    const branchRootId = findAttachableBranchRootForMessage(mapping, messageId);
    if (!branchRootId) {
      return false;
    }

    if (branchRootId === latestInputMessageId) {
      return false;
    }

    if (!mapping[branchRootId]) {
      return false;
    }

    mapping[branchRootId].parent = latestInputMessageId;

    const latestInputChildren = Array.isArray(mapping[latestInputMessageId].children)
      ? mapping[latestInputMessageId].children
      : [];
    if (!latestInputChildren.includes(branchRootId)) {
      latestInputChildren.push(branchRootId);
    }
    mapping[latestInputMessageId].children = latestInputChildren;

    log("[sse:branch-anchor-to-input]", {
      conversationId,
      topicId,
      anchorReason: anchorReason || "",
      anchored: true,
    });

    return true;
  }

  /**
   * Apply normalized delta operations to a cached message node, mutating its content, status, end_turn flag, and token count.
   *
   * The function locates the message by `messageId` inside `cache.mapping` and ensures `message.content.parts` exists before applying operations.
   * Supported operation targets:
   * - `/message/content/parts/0` with `append`, `replace`, or `add` to update the first content part,
   * - `/message/status` with `replace` to set `message.status`,
   * - `/message/end_turn` with `replace` to set `message.end_turn`,
   * - `/message/metadata/token_count` with `replace` to set `message.metadata.token_count`.
   *
   * When `message.end_turn` becomes truthy the function calls `postStreamNotify(msg)`.
   *
   * @param {Object} cache - Conversation cache object containing a `mapping` of node ids to nodes.
   * @param {string} messageId - Identifier of the message node to update.
   * @param {Array|Object} ops - Delta operation or array of operations (will be normalized before application).
   */
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

    annotateMessageForCgo(msg);

    if (msg.end_turn) {
      postStreamNotify(msg);
    }
  }

  /**
   * Store file download metadata in the in-page file-download cache keyed by file and conversation.
   * @param {string} fileId - The file identifier.
   * @param {string} conversationId - The conversation identifier associated with the file.
   * @param {Object} data - Raw response payload containing download information.
   * @param {string} [data.download_url] - URL where the file can be downloaded.
   * @param {string} [data.file_name] - Suggested filename for the download.
   * @param {number|string} [data.file_size_bytes] - Size of the file in bytes.
   *
   * Does nothing if a cache key cannot be constructed or `data` is falsy. Stored entry contains
   * `downloadUrl`, `fileName`, `fileSizeBytes` (numeric, defaults to 0), and a `timestamp` (milliseconds).
   */
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
  /**
   * Flatten and normalize a list of delta operation objects by recursively expanding any `patch` operations whose `v` field is an array.
   * @param {Array<object>} ops - Array of operation objects; elements may be falsy, non-objects, or a `patch` op with `v` as an array of ops.
   * @returns {Array<object>} A flat array of operation objects with nested `patch` arrays recursively expanded and falsy/non-object entries removed.
   */
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

  /**
   * Parse a single Server-Sent Events (SSE) block, extract `event` and `data` lines, and invoke a handler for each JSON `data` payload.
   *
   * Updates `streamParserState.currentEventName` to the last seen `event:` value (defaulting to `"message"`), skips `data:` lines equal to `"[DONE]"`, ignores non-JSON data, and calls `onEvent(eventName, parsedJson, meta)` for each successfully parsed `data` entry.
   *
   * @param {string} block - Raw SSE block text (one or more lines separated by `\n`).
   * @param {(eventName: string, payload: any, meta: Object) => void} onEvent - Callback invoked with the resolved event name, parsed JSON payload, and `meta` for each `data:` entry.
   * @param {Object} streamParserState - Mutable parser state object; this function sets/overwrites `streamParserState.currentEventName`.
   * @param {Object} [meta={}] - Optional metadata passed through to `onEvent`.
   */
  function processSseBlock(block, onEvent, streamParserState, meta = {}) {
    const lines = block.split(/\r?\n/).filter(Boolean);
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

  /**
   * Build a compact summary of a stream payload shape for diagnostics.
   * @param {any} payload - Parsed stream payload.
   * @returns {object} Shape summary suitable for debug logs.
   */
  function summarizeStreamPayload(payload) {
    if (!payload || typeof payload !== "object") {
      return { kind: typeof payload };
    }

    return {
      type: payload.type || "",
      event: payload.event || "",
      o: payload.o || "",
      p: payload.p || "",
      hasMessage: !!payload.message,
      hasInputMessage: !!payload.input_message,
      hasVMessage: !!payload.v?.message,
      vIsArray: Array.isArray(payload.v),
      opsIsArray: Array.isArray(payload.ops),
      deltaIsArray: Array.isArray(payload.delta),
      keys: Object.keys(payload).slice(0, 30),
    };
  }

  /**
   * Extracts the conversation id from an SSE payload by checking known fields and fallbacks.
   * @param {Object} payload - Parsed SSE payload or related stream object that may contain a conversation id.
   * @returns {string|null} The conversation id when found, `null` otherwise.
   */
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

  /**
   * Detect a raw top-level conversation message payload.
   *
   * Some stream items deliver the message object directly instead of wrapping it
   * under `payload.message` or `payload.v.message`.
   *
   * @param {*} payload - Parsed stream payload.
   * @returns {boolean} `true` when the payload looks like a conversation message.
   */
  function isRawStreamMessagePayload(payload) {
    return (
      payload &&
      typeof payload === "object" &&
      typeof payload.id === "string" &&
      payload.id &&
      payload.author &&
      typeof payload.author === "object" &&
      typeof payload.author.role === "string" &&
      !!(
        payload.content ||
        payload.metadata ||
        payload.status ||
        payload.recipient ||
        payload.channel
      )
    );
  }

  /**
   * Check whether a content payload contains generated image asset pointers.
   *
   * @param {*} content - Message content-like payload.
   * @returns {boolean} `true` when `parts` includes an image asset pointer.
   */
  function hasImageAssetPointerPart(content) {
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    return parts.some((part) =>
      part &&
      typeof part === "object" &&
      part.content_type === "image_asset_pointer" &&
      typeof part.asset_pointer === "string" &&
      part.asset_pointer
    );
  }

  /**
   * Detect a content-only generated-image payload.
   *
   * This shape has no message id or author. It cannot become a mapping node by
   * itself, so it should be kept temporarily until a raw tool message arrives.
   *
   * @param {*} payload - Parsed stream payload.
   * @returns {boolean} `true` for content-only multimodal image content.
   */
  function isContentOnlyGeneratedImagePayload(payload) {
    return (
      payload &&
      typeof payload === "object" &&
      !payload.id &&
      !payload.author &&
      typeof payload.content_type === "string" &&
      Array.isArray(payload.parts) &&
      hasImageAssetPointerPart(payload)
    );
  }

  /**
   * Process a parsed SSE/WebSocket stream event for conversation streams, updating conversation/topic context, caching message nodes, and applying or queuing delta operations.
   *
   * This routine detects or restores the conversation/topic context, ensures per-conversation caches and stream state exist, handles control events (e.g., resume tokens and stream handoffs), upserts incoming messages into the stream cache, and either applies delta ops to the current patched assistant message or queues them for later application.
   *
   * @param {string} eventName - The SSE event name (e.g., "message", "delta").
   * @param {object} payload - The parsed event payload; may contain control fields (e.g., `type`, `options`), message objects (`message`, `input_message`, `v.message`), or delta op formats (`{p,o,v}`, arrays under `v`, `ops`, or `delta`).
   * @param {object} [meta={}] - Optional metadata for the event.
   * @param {string} [meta.topicId] - An explicit topic identifier to associate the event with a specific stream context.
   */
  function handleSseEvent(eventName, payload, meta = {}) {
    /**
     * Remember the latest text append-style op so follow-up value ops can be normalized.
     *
     * @param {Object} streamState - Per-stream state bucket.
     * @param {Object[]} ops - Normalized delta ops.
     * @returns {void}
     */
    function rememberLastTextAppendOp(streamState, ops) {
      for (const op of ops || []) {
        if (!op || typeof op !== "object") continue;

        if (op.p === "/message/content/parts/0") {
          if (op.o === "append") {
            streamState.lastTextAppendOp = {
              p: op.p,
              o: "append",
            };
          } else if (op.o === "replace" || op.o === "add") {
            // その後に {"v":"..."} が来た場合は続きとして append 扱い
            streamState.lastTextAppendOp = {
              p: op.p,
              o: "append",
            };
          }
        }
      }
    }

    /**
     * Apply delta ops immediately when a target assistant exists, or queue them otherwise.
     *
     * @param {Object} cache - Conversation cache entry.
     * @param {Object} streamState - Per-stream state bucket.
     * @param {Object[]} ops - Raw or normalized delta ops.
     * @returns {void}
     */
    function applyOrQueueDeltaOps(cache, streamState, ops) {
      const normalized = normalizeOps(ops);
      if (!normalized.length) return;

      rememberLastTextAppendOp(streamState, normalized);

      if (streamState.currentPatchedMessageId) {
        applyDeltaOpsToMessage(cache, streamState.currentPatchedMessageId, normalized);
      } else {
        streamState.pendingOps.push(...normalized);
      }
    }

    if (!meta.__cgoUnwrappedMessageWrapper && payload?.type === "message") {
      const nested = getNestedPayloadFromMessageWrapper(payload);

      if (nested) {
        const wrapperTopicId =
          payload.topic_id ||
          payload.topicId ||
          meta.topicId ||
          "";

        handleSseEvent(
          getNestedEventNameFromPayload(eventName, nested),
          nested,
          {
            ...meta,
            topicId: wrapperTopicId,
            __cgoUnwrappedMessageWrapper: true,
          }
        );
        return;
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

    const payloadSummary = summarizeStreamPayload(payload);
    const topicId =
      meta.topicId ||
      getTopicIdFromPayload(payload) ||
      "";

    const ignorableTypes = new Set([
      "subscribe",
      "unsubscribe",
      "presence",
      "stream-item",
      "message_marker",
      "server_ste_metadata",
      "message_stream_complete",
      "conversation-turn-complete",
    ]);

    const cache = ensureConversationCache(conversationId);
    const streamState = ensureStreamState(conversationId, topicId);
    let handledPayload = false;

    if (
      !meta.__cgoUnwrappedConversationTurnStream &&
      payload?.type === "conversation-turn-stream"
    ) {
      const nestedPayloads = getNestedPayloadsFromConversationTurnStream(payload);

      log("[sse:conversation-turn-stream]", {
        eventName,
        conversationId,
        topicId,
        nestedCount: nestedPayloads.length,
      });

      if (nestedPayloads.length) {
        for (const nested of nestedPayloads) {
          const nextEventName = getNestedEventNameFromPayload(eventName, nested);

          handleSseEvent(nextEventName, nested, {
            ...meta,
            topicId:
              payload.topic_id ||
              payload.topicId ||
              meta.topicId ||
              topicId ||
              "",
            __cgoUnwrappedConversationTurnStream: true,
          });
        }

        return;
      }
    }

    const payloadMessages = getMessagesFromPayload(payload);

    if (payloadMessages.length) {
      for (const msg of payloadMessages) {
        const parentId =
          msg?.metadata?.parent_id ||
          msg?.parent_id ||
          cache.current_node ||
          null;

        upsertMessageNode(cache, msg, parentId);

        if (msg?.author?.role === "user") {
          rememberLatestInputMessageId(conversationId, topicId, msg);
        } else {
          anchorBranchToLatestInput(cache, conversationId, topicId, msg.id, "messages-array");
        }

        if (shouldUseAsPatchedTarget(msg)) {
          streamState.currentPatchedMessageId = msg.id;
          flushPendingOps(cache, streamState);
        }
      }

      return;
    }

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
      const parentId = msg?.metadata?.parent_id || cache.current_node || null;
      upsertMessageNode(cache, msg, parentId);
      rememberLatestInputMessageId(conversationId, topicId, msg);

      if (shouldUseAsPatchedTarget(msg)) {
        streamState.currentPatchedMessageId = msg.id;
        flushPendingOps(cache, streamState);
      }
      return;
    }

    if (payload?.v?.message?.id) {
      const msg = payload.v.message;
      const parentId =
        msg?.metadata?.parent_id ||
        payload?.v?.parent_id ||
        payload?.parent_id ||
        null;

      upsertMessageNode(cache, msg, parentId);
      handledPayload = true;
      anchorBranchToLatestInput(cache, conversationId, topicId, msg.id, "v-message");

      if (shouldUseAsPatchedTarget(msg)) {
        streamState.currentPatchedMessageId = msg.id;
        flushPendingOps(cache, streamState);
      }

      return;
    }

    if (
      eventName === "delta" &&
      payload &&
      typeof payload === "object" &&
      typeof payload.v === "string" &&
      typeof payload.p !== "string" &&
      typeof payload.o !== "string"
    ) {
      const last = streamState.lastTextAppendOp;

      if (last?.p === "/message/content/parts/0") {
        applyOrQueueDeltaOps(cache, streamState, [{
          p: last.p,
          o: last.o || "append",
          v: payload.v,
        }]);

        return;
      }
      return;
    }

    if (payload?.message?.id) {
      const msg = payload.message;
      const parentId = msg?.metadata?.parent_id || null;
      upsertMessageNode(cache, msg, parentId);
      handledPayload = true;
      anchorBranchToLatestInput(cache, conversationId, topicId, msg.id, "payload-message");

      if (shouldUseAsPatchedTarget(msg)) {
        streamState.currentPatchedMessageId = msg.id;
        flushPendingOps(cache, streamState);
      }
    }

    if (isRawStreamMessagePayload(payload)) {
      const msg = payload;
      const parentId =
        msg?.metadata?.parent_id ||
        msg?.parent_id ||
        cache.current_node ||
        null;

      if (
        msg?.author?.role === "tool" &&
        streamState.pendingGeneratedImageContent &&
        (
          !msg.content ||
          !Array.isArray(msg.content.parts) ||
          msg.content.parts.length === 0
        )
      ) {
        msg.content = structuredClone(streamState.pendingGeneratedImageContent);
        streamState.pendingGeneratedImageContent = null;
      } else if (hasImageAssetPointerPart(msg?.content)) {
        streamState.pendingGeneratedImageContent = null;
      }

      upsertMessageNode(cache, msg, parentId);
      handledPayload = true;
      anchorBranchToLatestInput(cache, conversationId, topicId, msg.id, "raw-message");

      if (shouldUseAsPatchedTarget(msg)) {
        streamState.currentPatchedMessageId = msg.id;
        flushPendingOps(cache, streamState);
      }

      const turnExchangeId = msg?.metadata?.turn_exchange_id || "";
      if (turnExchangeId) {
        STREAM_TURN_EXCHANGE_TO_CONVERSATION.set(turnExchangeId, conversationId);
      }

      return;
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

    if (isContentOnlyGeneratedImagePayload(payload)) {
      streamState.pendingGeneratedImageContent = structuredClone(payload);

      const imageParts = payload.parts.filter(
        (part) => part?.content_type === "image_asset_pointer"
      );

      log("[sse:generated-image-content:pending]", {
        conversationId,
        topicId,
        imageCount: imageParts.length,
      });

      return;
    }

    if (payload?.type === "done") {
      log("[sse:done]", {
        conversationId,
        topicId,
        hasPendingGeneratedImageContent: !!streamState.pendingGeneratedImageContent,
        pendingImageCount: streamState.pendingGeneratedImageContent
          ? streamState.pendingGeneratedImageContent.parts.filter(
            (part) => part?.content_type === "image_asset_pointer"
          ).length
          : 0,
      });

      return;
    }

    // NOTE: conversation-update/add-messages is intentionally left for a later
    // stream-normalization pass. Raw generated-image payloads are handled above.

    if (
      eventName === "delta_encoding" ||
      ignorableTypes.has(payload?.type) ||
      ignorableTypes.has(payload?.command?.type) ||
      ignorableTypes.has(payload?.reply?.type)
    ) {
      return;
    }

    if (
      payload &&
      typeof payload === "object" &&
      Object.keys(payload).length === 1 &&
      typeof payload.conversation_id === "string"
    ) {
      return;
    }

    if (!handledPayload) {
      log("[sse:unhandled]", {
        eventName,
        conversationId,
        topicId,
        summary: payloadSummary,
      });
    }
  }

  /**
   * Consume a Fetch Response containing SSE-style conversation data, parse its SSE blocks, and forward parsed events to the stream handler.
   * Processes either a full-text response (when body is absent) or a streaming ReadableStream, buffering partial chunks and dispatching complete blocks to `handleSseEvent`.
   * On non-abort errors parsing the stream, processing stops; an AbortError stops after any partial reads.
   * @param {Response} response - The Fetch API Response to consume.
   * @param {Object} [meta={}] - Optional metadata forwarded to the event handler (commonly contains `url`, `topicId`, etc.).
   */
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
  /**
   * Intercepts fetch responses for conversation, streaming, file download, and sidebar endpoints and optionally processes or rewrites them.
   *
   * This function may: consume and parse event-stream bodies, cache full conversation exports or file-download metadata, compute conversation statistics and pruning plans, post analysis/auto-adjust messages, and produce a rewritten Response containing a pruned conversation JSON when pruning is applied. It also records the last authorization header when present.
   *
   * @param {{args: any[], response: Response, url: string}} options - Fetch call arguments: the original fetch arguments array, the original Response, and the request URL.
   * @returns {Response} The original Response when no processing or modification is performed, or a Response whose body contains the (possibly pruned) conversation JSON or preserved original body.
   */
  async function handleFetchResponse({ args, response, url }) {
    const orgResponse = response;
    const shouldObserveEventStream =
      isStreamingConversationRequest(url) || isEventStreamResponse(orgResponse);
    const isVoiceBootstrapRequest = isRealtimeVoiceBootstrapRequest(url);

    if (isVoiceBootstrapRequest && orgResponse.ok) {
      updateVoiceSessionState("active", resolveVoiceSessionConversationId(url), {
        source: "fetch",
        url,
      });
    }

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
      if (isStreamingConversationRequest(url)) {
        try {
          rememberUserMessagesFromStreamingRequest(args, url);
        } catch (error) {
          log("failed to remember streaming request user input", String(error));
        }
      }

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

    const headMeta = buildConversationHeadMeta(data);
    if (headMeta) {
      postConversationHeadMeta(data.conversation_id || "", headMeta);
    }

    if (shouldSkipPrune(summary)) {
      log("skip prune: low benefit", {
        chainLength: summary.original?.chainLength,
        keepNodeCount: summary.prunePlan?.keepNodeCount,
      });
      return orgResponse;
    }

    const pruned = pruneConversationData(data, effectiveKeepDomMessages);
    const pruneMeta = data.__cgoInitialPruneMeta || null;
    try {
      delete data.__cgoInitialPruneMeta;
    } catch (_) {}

    if (pruneMeta && Number(pruneMeta.omittedCount || 0) > 0) {
      postInitialPruneMeta(data.conversation_id || "", pruneMeta);
    }

    log("pruned conversation response", {
      url,
      originalMappingCount: Object.keys(data.mapping || {}).length,
      prunedMappingCount: Object.keys(pruned.mapping || {}).length,
      currentNode: pruned.current_node,
      title: pruned.title,
      omittedCount: Number(pruneMeta?.omittedCount || 0),
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

  /**
   * Patch `RTCPeerConnection` with minimal lifecycle observers used only for voice-session lock state.
   *
   * The patch does not inspect RTC payloads. It only watches connection/datachannel open-close
   * transitions so the content layer can keep export actions disabled while voice chat is active
   * and leave them disabled in a `syncing` state until the normal conversation fetch completes.
   */
  function patchRTCPeerConnection() {
    const NativeRTCPeerConnection = window.RTCPeerConnection;
    if (!NativeRTCPeerConnection || window.__CGO_RTCPEERCONNECTION_PATCHED__) return;

    window.__CGO_ORIGINAL_RTCPEERCONNECTION__ =
      window.__CGO_ORIGINAL_RTCPEERCONNECTION__ || NativeRTCPeerConnection;

    /**
     * Wrapped `RTCPeerConnection` constructor that observes voice-session activity.
     *
     * @param {...*} args - Native `RTCPeerConnection` constructor arguments.
     * @returns {RTCPeerConnection} Wrapped peer connection instance.
     */
    function CGORTCPeerConnection(...args) {
      const pc = new NativeRTCPeerConnection(...args);

      const markActive = (source, extra = {}) => {
        if (VOICE_SESSION_STATE.state !== "active" && !pc.__CGO_VOICE_SESSION_LIVE__) {
          return;
        }

        pc.__CGO_VOICE_SESSION_LIVE__ = true;
        updateVoiceSessionState("active", resolveVoiceSessionConversationId(), {
          source,
          ...extra,
        });
      };

      const markSyncing = (source, reason = "", extra = {}) => {
        if (!pc.__CGO_VOICE_SESSION_LIVE__ && VOICE_SESSION_STATE.state !== "active") {
          return;
        }

        updateVoiceSessionState("syncing", resolveVoiceSessionConversationId(), {
          source,
          reason,
          ...extra,
        });
      };

      try {
        const originalCreateDataChannel = pc.createDataChannel;
        if (typeof originalCreateDataChannel === "function") {
          pc.createDataChannel = function (...channelArgs) {
            const channel = originalCreateDataChannel.apply(this, channelArgs);
            return attachVoiceSessionChannelStateHandlers(channel, pc);
          };
        }

        pc.addEventListener("datachannel", (event) => {
          attachVoiceSessionChannelStateHandlers(event?.channel, pc);
        });

        pc.addEventListener("connectionstatechange", () => {
          const state = pc.connectionState || "";
          if (state === "connecting" || state === "connected") {
            markActive("rtc-connection-state", { rtcConnectionState: state });
            return;
          }

          if (state === "closed" || state === "disconnected" || state === "failed") {
            markSyncing("rtc-connection-state", state, { rtcConnectionState: state });
          }
        });

        pc.addEventListener("iceconnectionstatechange", () => {
          const state = pc.iceConnectionState || "";
          if (state === "checking" || state === "connected" || state === "completed") {
            markActive("rtc-ice-connection-state", { rtcIceConnectionState: state });
            return;
          }

          if (state === "closed" || state === "disconnected" || state === "failed") {
            markSyncing("rtc-ice-connection-state", state, { rtcIceConnectionState: state });
          }
        });
      } catch (error) {
        log("rtc peer connection state patch failed", String(error));
      }

      return pc;
    }

    CGORTCPeerConnection.prototype = NativeRTCPeerConnection.prototype;
    Object.setPrototypeOf(CGORTCPeerConnection, NativeRTCPeerConnection);

    window.RTCPeerConnection = CGORTCPeerConnection;
    window.__CGO_RTCPEERCONNECTION_PATCHED__ = true;
  }

  window.__CGO_MAIN_HOOK_API__ = {
    handleFetchResponse,
  };

  patchRTCPeerConnection();
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

  /**
   * Installs a safe wrapper around the platform EventSource to intercept JSON message payloads.
   *
   * When a native EventSource exists and has not already been patched, replaces window.EventSource
   * with a constructor that forwards parsed JSON `event.data` to `handleSseEvent` for both
   * the built-in "message" listener and any additional listeners added via `addEventListener`.
   * Preserves the original EventSource constructor on `window.__CGO_ORIGINAL_EVENTSOURCE__`
   * and marks the environment as patched via `window.__CGO_EVENTSOURCE_PATCHED__`.
   *
   * No action is taken if EventSource is unavailable or already patched.
   */
  function patchEventSource() {
    const NativeEventSource = window.EventSource;
    if (!NativeEventSource || window.__CGO_EVENTSOURCE_PATCHED__) return;

    window.__CGO_ORIGINAL_EVENTSOURCE__ =
      window.__CGO_ORIGINAL_EVENTSOURCE__ || NativeEventSource;

    /**
     * Wrapped `EventSource` constructor that mirrors parsed SSE payloads into the stream parser.
     *
     * @param {string|URL} url - EventSource endpoint.
     * @param {Object} [config] - Optional EventSource configuration.
     * @returns {EventSource} Wrapped native EventSource instance.
     */
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
      // Authenticate request
      if (data.secret !== PAGE_BRIDGE_SECRET) {
        return; // Ignore unauthenticated requests
      }

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
      // Authenticate request
      if (data.secret !== PAGE_BRIDGE_SECRET) {
        return; // Ignore unauthenticated requests
      }

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
      // Authenticate request
      if (data.secret !== PAGE_BRIDGE_SECRET) {
        return; // Ignore unauthenticated requests
      }

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
