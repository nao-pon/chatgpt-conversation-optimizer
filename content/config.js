(() => {
  globalThis.__CGO_SKIP__ = !!window.__cgoInstalled;
  if (globalThis.__CGO_SKIP__) return;
  window.__cgoInstalled = true;
  const CGO = (globalThis.__CGO ||= {});


  CGO.PAGE_HOOK_VERSION = "6";
  CGO.PAGE_MAIN_HOOK_ID = "cgo-page-hook-script";
  // Keep viewer payloads reloadable for 24 hours unless this hardcoded switch is enabled.
  CGO.VIEWER_DELETE_AFTER_RENDER = false;

  CGO.DETECTION_PATTERNS = {
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

  CGO.CONFIG = {
    keepDomMessages: 40,
    domTrimDelayMs: 5000,
    debug: false,
    debugLevel: "BASIC",
  };

  CGO.STATE = {
    domTrimTimer: null,
    domTrimTicket: 0,
    effectiveKeepDomMessages: null,
    activeConversationId: "",
    activeConversationHistoryMode: "unknown",
    activeConversationHistoryModeConversationId: "",
    exportToolbarVisible: false,

    conversationHeadMeta: null,
    domTrimState: {
      omittedCount: 0,
      firstKeptId: "",
    },

    initialPruneNoticeScheduled: false,
    initialPruneNoticeTimer: null,
    initialPruneNoticeRetryCount: 0,

    projectGuide: {
      conversationId: "",
      projectName: "",
      stats: null,
      level: 0,
    },

    voiceExportGuard: {
      state: "normal",
      conversationId: "",
      syncRetryCount: 0,
      syncRetryTimer: null,
      syncCheckInFlight: false,
      lastChangedAt: 0,
      reason: "",
    },
  };

  CGO.DOMS = {
    exportButtons: {},
  };

  CGO.DEFAULT_SETTINGS = {
    keepDomMessages: 40,
    autoAdjustEnabled: true,
    htmlDownloadIncludeImages: true,
    debugEnabled: false,
    debugLevel: "BASIC",
  };

  CGO.SETTINGS = {
    ...CGO.DEFAULT_SETTINGS,
  };

  CGO.SETTING_STORAGE_KEY = "cgo_settings";

  function normalizeDebugLevel(value) {
    const key = String(value || "").toUpperCase();
    if (key === "STREAM" || key === "TRACE") {
      return key;
    }
    return "BASIC";
  }

  /**
   * Clamp the keep-dom setting to the supported integer range.
   *
   * @param {*} value - Candidate keep-dom value.
   * @returns {number} Normalized keep-dom count.
   */
  function clampKeepDomMessages(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return CGO.DEFAULT_SETTINGS.keepDomMessages;
    return Math.max(5, Math.min(200, Math.round(n)));
  }

  /**
   * Normalize persisted settings into a complete configuration object with defaults applied.
   *
   * @param {Object} [input={}] - Partial settings loaded from storage or UI input.
   * @returns {{keepDomMessages: number, autoAdjustEnabled: boolean, htmlDownloadIncludeImages: boolean, debugEnabled: boolean, debugLevel: string}} Sanitized settings.
   */
  function normalizeSettings(input = {}) {
    return {
      keepDomMessages: CGO.clampKeepDomMessages(
        input.keepDomMessages ?? CGO.DEFAULT_SETTINGS.keepDomMessages
      ),
      autoAdjustEnabled: Boolean(
        input.autoAdjustEnabled ?? CGO.DEFAULT_SETTINGS.autoAdjustEnabled
      ),
      htmlDownloadIncludeImages:
        input.htmlDownloadIncludeImages !== false,
      debugEnabled: Boolean(
        input.debugEnabled ?? CGO.DEFAULT_SETTINGS.debugEnabled
      ),
      debugLevel: normalizeDebugLevel(
        input.debugLevel ?? CGO.DEFAULT_SETTINGS.debugLevel
      ),
    };
  }

  /**
   * Apply normalized settings to in-memory state shared across the content scripts.
   *
   * @param {Object} [settings={}] - Partial settings to merge into the current configuration.
   * @returns {Object} The live `CGO.SETTINGS` object after normalization.
   */
  function applySettings(settings = {}) {
    const normalized = normalizeSettings(settings);

    CGO.SETTINGS.keepDomMessages = normalized.keepDomMessages;
    CGO.SETTINGS.autoAdjustEnabled = normalized.autoAdjustEnabled;
    CGO.SETTINGS.htmlDownloadIncludeImages = normalized.htmlDownloadIncludeImages;
    CGO.SETTINGS.debugEnabled = normalized.debugEnabled;
    CGO.SETTINGS.debugLevel = normalized.debugLevel;

    CGO.CONFIG.keepDomMessages = normalized.keepDomMessages;
    CGO.CONFIG.debug = normalized.debugEnabled;
    CGO.CONFIG.debugLevel = normalized.debugLevel;
    CGO.STATE.effectiveKeepDomMessages = normalized.keepDomMessages;

    return CGO.SETTINGS;
  }

  /**
   * Load persisted extension settings from local storage and apply them in memory.
   *
   * @returns {Promise<Object>} Active settings after normalization.
   */
  async function loadSettings() {
    try {
      const stored = await chrome.storage.local.get(CGO.SETTING_STORAGE_KEY);
      const raw = stored?.[CGO.SETTING_STORAGE_KEY] || {};
      return applySettings(raw);
    } catch (error) {
      CGO.log("[warn] CGO.loadSettings failed", String(error));
      return applySettings(CGO.DEFAULT_SETTINGS);
    }
  }

  /**
   * Persist a partial settings update and return the normalized result.
   *
   * @param {Object} [partial={}] - Settings fields to update.
   * @returns {Promise<Object>} Saved settings object.
   */
  async function saveSettings(partial = {}) {
    const next = applySettings({
      ...CGO.SETTINGS,
      ...partial,
    });

    await chrome.storage.local.set({
      [CGO.SETTING_STORAGE_KEY]: {
        keepDomMessages: next.keepDomMessages,
        autoAdjustEnabled: next.autoAdjustEnabled,
        htmlDownloadIncludeImages: next.htmlDownloadIncludeImages,
        debugEnabled: next.debugEnabled,
        debugLevel: next.debugLevel,
      },
    });

    return next;
  }

  const PROJECT_GUIDE_DISMISSED_STORAGE_KEY = "cgo_project_guide_dismissed";

  /**
   * Compute the project-guide warning level for a conversation.
   *
   * @param {?Object} [stats=null] - Conversation statistics.
   * @returns {number} Warning level from `0` to `3`.
   */
  function getProjectGuideLevel(stats = null) {
    if (!stats) return 0;

    const conversationalLength = Number(stats.conversationalLength || 0);
    const chainLength = Number(stats.chainLength || 0);

    if (conversationalLength >= 950 || chainLength >= 3200) return 3;
    if (conversationalLength >= 800 || chainLength >= 2600) return 2;
    if (conversationalLength >= 600 || chainLength >= 2000) return 1;
    return 0;
  }

  /**
   * Load the per-conversation dismissal state for project guide banners.
   *
   * @returns {Promise<Object>} Map keyed by conversation id containing dismissal metadata.
   */
  async function loadProjectGuideDismissedMap() {
    try {
      const stored = await chrome.storage.local.get(PROJECT_GUIDE_DISMISSED_STORAGE_KEY);
      return stored?.[PROJECT_GUIDE_DISMISSED_STORAGE_KEY] || {};
    } catch (error) {
      CGO.log("[warn] loadProjectGuideDismissedMap failed", String(error));
      return {};
    }
  }

  /**
   * Check whether the project guide has been dismissed for a conversation and level.
   *
   * @param {string} conversationId - Conversation identifier.
   * @param {number} [level=0] - Warning level being evaluated.
   * @returns {Promise<boolean>} `true` when the guide is already dismissed.
   */
  async function isProjectGuideDismissed(conversationId, level = 0) {
    if (!conversationId || level <= 0) return false;

    const map = await loadProjectGuideDismissedMap();
    const saved = map?.[conversationId];
    if (!saved) return false;

    return Number(saved.level || 0) >= level;
  }

  /**
   * Persist dismissal state for the project guide of a conversation.
   *
   * @param {string} conversationId - Conversation identifier.
   * @param {number} [level=0] - Warning level being dismissed.
   * @returns {Promise<void>}
   */
  async function dismissProjectGuide(conversationId, level = 0) {
    if (!conversationId || level <= 0) return;

    const map = await loadProjectGuideDismissedMap();
    map[conversationId] = {
      level: Number(level || 0),
      updatedAt: Date.now(),
    };

    await chrome.storage.local.set({
      [PROJECT_GUIDE_DISMISSED_STORAGE_KEY]: map,
    });
  }

  /**
   * Remove any saved project-guide dismissal state for a conversation.
   *
   * @param {string} conversationId - Conversation identifier.
   * @returns {Promise<void>}
   */
  async function clearProjectGuideDismissed(conversationId) {
    if (!conversationId) return;

    const map = await loadProjectGuideDismissedMap();
    if (!map[conversationId]) return;

    delete map[conversationId];

    await chrome.storage.local.set({
      [PROJECT_GUIDE_DISMISSED_STORAGE_KEY]: map,
    });
  }
 
  /**
   * Compute the effective DOM retention count for the active conversation.
   *
   * Auto-adjusted values are derived from the user's base setting and optional conversation stats.
   *
   * @param {?string} [conversationId=null] - Explicit conversation id when already known.
   * @param {?Object} [stats=null] - Optional conversation statistics used for auto-adjust.
   * @returns {Promise<number>} Effective number of conversation turns to keep in the DOM.
   */
  async function getEffectiveKeepDomMessagesForConversation(conversationId = null, stats = null) {
    void conversationId;
    return getEffectiveKeepDomMessages(stats);
  }

  /**
   * Post the current effective settings to the injected page hook.
   *
   * @param {?Object} [stats=null] - Optional current conversation stats for an immediate effective value.
   * @returns {Promise<void>}
   */
  async function postSettingsToPageHook(stats = null) {
    const keepDomMessages = await getEffectiveKeepDomMessagesForConversation(null, stats);
    CGO.STATE.effectiveKeepDomMessages = keepDomMessages;
    const settingsKey = JSON.stringify({
      keepDomMessages,
      baseKeepDomMessages: CGO.CONFIG.keepDomMessages,
      autoAdjustEnabled: CGO.SETTINGS.autoAdjustEnabled,
      debugEnabled: CGO.SETTINGS.debugEnabled,
      debugLevel: CGO.SETTINGS.debugLevel,
    });
    const now = Date.now();
    if (
      CGO.lastPageHookSettingsKey === settingsKey &&
      now - Number(CGO.lastPageHookSettingsPostedAt || 0) < 1000
    ) {
      return;
    }

    CGO.lastPageHookSettingsKey = settingsKey;
    CGO.lastPageHookSettingsPostedAt = now;

    window.postMessage(
      {
        source: "CGO_CONTENT",
        type: "CGO_UPDATE_SETTINGS",
        settings: {
          keepDomMessages: keepDomMessages,
          baseKeepDomMessages: CGO.CONFIG.keepDomMessages,
          autoAdjustEnabled: CGO.SETTINGS.autoAdjustEnabled,
          debugEnabled: CGO.SETTINGS.debugEnabled,
          debugLevel: CGO.SETTINGS.debugLevel,
        },
      },
      "*"
    );
  }

  /**
   * Return the auto-adjust severity level for the computed conversation score.
   *
   * @param {number} score - Conversation weight score.
   * @returns {number} Auto-adjust level from 0 to 3.
   */
  function getKeepDomAutoAdjustLevel(score) {
    if (score >= 5000) return 3;
    if (score >= 3000) return 2;
    if (score >= 1000) return 1;
    return 0;
  }

  /**
   * Reduce the keep-dom value in three steps between the user's base value and the fixed floor.
   *
   * @param {number} baseKeepDomMessages - User-configured keep-dom count.
   * @param {number} autoAdjustLevel - Auto-adjust level from 0 to 3.
   * @returns {{effectiveKeepDomMessages: number, minimumKeepDomMessages: number}} Recommended keep-dom decision.
   */
  function getSteppedKeepDomMessages(baseKeepDomMessages, autoAdjustLevel) {
    const base = Math.max(1, Math.round(Number(baseKeepDomMessages) || 1));
    const minimumKeepDomMessages = Math.min(base, 25);
    const span = base - minimumKeepDomMessages;
    const level = Math.max(0, Math.min(3, Math.round(Number(autoAdjustLevel) || 0)));

    if (level <= 0 || span <= 0) {
      return {
        effectiveKeepDomMessages: base,
        minimumKeepDomMessages,
      };
    }

    if (level >= 3) {
      return {
        effectiveKeepDomMessages: minimumKeepDomMessages,
        minimumKeepDomMessages,
      };
    }

    return {
      effectiveKeepDomMessages: Math.max(
        minimumKeepDomMessages,
        base - Math.round((span * level) / 3)
      ),
      minimumKeepDomMessages,
    };
  }

  /**
   * Return the currently active keep-dom count used by DOM trimming.
   *
   * @returns {number} Effective keep-dom count for the current conversation.
   */
  function getActiveKeepDomMessages() {
    const effective = Number(CGO.STATE.effectiveKeepDomMessages);
    if (Number.isFinite(effective) && effective > 0) {
      return CGO.clampKeepDomMessages(effective);
    }
    return CGO.SETTINGS.keepDomMessages;
  }

  /**
   * Derive a smaller DOM retention budget only for very large conversations.
   *
   * @param {?Object} [stats=null] - Conversation metrics such as turn count and media counts.
   * @returns {number} Effective keep-dom value after applying auto-adjust thresholds.
   */
  function getEffectiveKeepDomMessages(stats = null) {
    return getEffectiveKeepDomMessagesForSettings(CGO.SETTINGS, stats, true);
  }

  /**
   * Compute the effective keep-dom count for a candidate settings object.
   *
   * @param {Object} [settings={}] - Candidate settings, usually from the settings panel.
   * @param {?Object} [stats=null] - Conversation metrics used for auto-adjust.
   * @param {boolean} [logDecision=false] - Whether to emit a debug decision log.
   * @returns {number} Effective keep-dom value.
   */
  function getEffectiveKeepDomMessagesForSettings(settings = {}, stats = null, logDecision = false) {
    const normalized = normalizeSettings({
      ...CGO.SETTINGS,
      ...settings,
    });

    if (!normalized.autoAdjustEnabled || !stats) {
      return normalized.keepDomMessages;
    }
    
    const turnCount = Number(stats.turnCount || 0);
    const textLength = Number(stats.textLength || 0);
    const imageCount = Number(stats.imageCount || 0);
    const attachmentCount = Number(stats.attachmentCount || 0);
    
    const score =
      turnCount * 3 +
      textLength / 3000 +
      imageCount * 8 +
      attachmentCount * 4;
    const baseKeepDomMessages = normalized.keepDomMessages;
    const autoAdjustLevel = getKeepDomAutoAdjustLevel(score);
    const { effectiveKeepDomMessages, minimumKeepDomMessages } =
      getSteppedKeepDomMessages(baseKeepDomMessages, autoAdjustLevel);

    if (logDecision) {
      CGO.log("[autoAdjust] keep-dom decision", {
        score,
        autoAdjustLevel,
        baseKeepDomMessages,
        minimumKeepDomMessages,
        effectiveKeepDomMessages,
        stats,
      });
    }
    
    return effectiveKeepDomMessages;
  }

  /**
   * Determine which language-specific detection rules should be used for UI text heuristics.
   *
   * @returns {"ja"|"en"} Detection language key.
   */
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

  CGO.DETECTION_LANG = getDetectionLanguage();

  CGO.toolbarBase = undefined;

  /**
   * Return the localized text-pattern bundle used for feature detection heuristics.
   *
   * @returns {Object} Pattern set for the currently selected detection language.
   */
  function getDetectionPatternSet() {
    return (
      CGO.DETECTION_PATTERNS[CGO.DETECTION_LANG] ||
      CGO.DETECTION_PATTERNS.en
    );
  }

  /**
   * Wait for the bootstrap script to acknowledge that the page bridge is alive.
   *
   * @param {number} [timeoutMs=1200] - Maximum time to wait for the handshake response.
   * @returns {Promise<boolean>} `true` when the bootstrap replies with a matching version.
   */
  function waitForBootstrapPong(timeoutMs = 1200) {
    return new Promise((resolve) => {
      let done = false;

      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);

      /**
       * Stop any pending timeout and unregister the message event listener, performing cleanup exactly once.
       */
      function cleanup() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
      }

      /**
       * Announces the content script to the page hook by posting a ping message on window.
       *
       * Posts a message with the shape `{ source: "CGO_CONTENT", type: "CGO_PING", version: PAGE_HOOK_VERSION }` via `window.postMessage`.
       */
      function sendPing() {
        window.postMessage(
          {
            source: "CGO_CONTENT",
            type: "CGO_PING",
            version: CGO.PAGE_HOOK_VERSION,
          },
          "*"
        );
      }

      /**
       * Handle window 'message' events for the CGO bootstrap handshake.
       *
       * Ignores messages not originating from window or not marked with `source === "CGO_PAGE"`. For
       * `type === "CGO_READY"` with `bootstrap === true` it sends a follow-up ping. For
       * `type === "CGO_PONG"` with `bootstrap === true` it performs cleanup and resolves the surrounding
       * handshake promise with `true` if the page hook version matches `PAGE_HOOK_VERSION`, `false` otherwise.
       * @param {MessageEvent} event - The message event received on window.
       */
      function onMessage(event) {
        if (event.source !== window) return;

        const data = event.data;
        if (!data || data.source !== "CGO_PAGE") return;

        CGO.log("[CGO content] saw window message", data);

        // bootstrap が起動完了したら再 ping
        if (data.type === "CGO_READY" && data.bootstrap === true) {
          sendPing();
          return;
        }

        if (data.type === "CGO_PONG" && data.bootstrap === true) {
          cleanup();
          resolve(data.version === CGO.PAGE_HOOK_VERSION);
        }
      }

      window.addEventListener("message", onMessage);

      // 最初の1回
      sendPing();
    });
  }

  /**
   * Wait for the main page hook to accept initial settings and return its bridge secret.
   *
   * @param {number} [timeoutMs=1000] - Maximum time to wait for initialization acknowledgement.
   * @returns {Promise<boolean>} `true` when the main hook acknowledges the expected version.
   */
  function waitForMainHookInitAck(timeoutMs = 1000) {
    return new Promise((resolve) => {
      let done = false;

      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);

      /**
       * Stop any pending timeout and unregister the message event listener, performing cleanup exactly once.
       */
      function cleanup() {
        if (done) return;
        done = true;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
      }

      /**
       * Send the current extension settings to the page hook via window.postMessage.
       *
       * The posted message has shape { source: "CGO_CONTENT", type: "CGO_INIT_SETTINGS", version, settings }
       * where `settings` contains `keepDomMessages`, `autoAdjustEnabled`, `debugEnabled`, and `debugLevel`.
       */
      function sendInit() {
        const settings = {
          keepDomMessages: CGO.SETTINGS.keepDomMessages,
          baseKeepDomMessages: CGO.CONFIG.keepDomMessages,
          autoAdjustEnabled: CGO.SETTINGS.autoAdjustEnabled,
          debugEnabled: CGO.SETTINGS.debugEnabled,
          debugLevel: CGO.SETTINGS.debugLevel,
        };
        CGO.lastPageHookSettingsKey = JSON.stringify(settings);
        CGO.lastPageHookSettingsPostedAt = Date.now();

        window.postMessage(
          {
            source: "CGO_CONTENT",
            type: "CGO_INIT_SETTINGS",
            version: CGO.PAGE_HOOK_VERSION,
            settings,
          },
          "*"
        );
      }

      /**
       * Handle window `message` events for the page-hook initialization acknowledgement.
       *
       * Listens for messages originating from the page with `data.source === "CGO_PAGE"`.
       * When a `CGO_INIT_SETTINGS_ACK` message with `mainHook === true` is received, it performs cleanup and resolves the pending handshake with `true` if `data.version` equals `PAGE_HOOK_VERSION`, `false` otherwise.
       *
       * @param {MessageEvent} event - The message event posted to `window`. Expects `event.data` to be an object containing at least `source`, `type`, and `mainHook`; `version` is read when acknowledging initialization.
       */
      function onMessage(event) {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== "CGO_PAGE") return;

        if (data.type === "CGO_INIT_SETTINGS_ACK" && data.mainHook === true) {
          // Store the bridge secret for authenticated requests
          if (data.secret) {
            window.__CGO_BRIDGE_SECRET__ = data.secret;
          }
          cleanup();
          resolve(data.version === CGO.PAGE_HOOK_VERSION);
        }
      }

      window.addEventListener("message", onMessage);
      sendInit();
    });
  }

  /**
   * Inject the main page hook script into the page context.
   *
   * @returns {Promise<void>} Resolves after the script loads successfully.
   */
  async function injectMainPageHookScript() {
    return new Promise((resolve, reject) => {
      const oldScript = document.getElementById(CGO.PAGE_MAIN_HOOK_ID);
      if (oldScript) {
        oldScript.remove();
      }

      const script = document.createElement("script");
      script.id = CGO.PAGE_MAIN_HOOK_ID;
      script.src = chrome.runtime.getURL("page-hook.js");
      script.dataset.cgoVersion = CGO.PAGE_HOOK_VERSION;

      script.onload = () => {
        CGO.log("main page-hook loaded");
        resolve();
      };

      script.onerror = (error) => {
        CGO.log("[error] main page-hook load failed", error);
        reject(new Error("page-hook.js load failed"));
      };

      (document.documentElement || document.head).appendChild(script);
    });
  }

  /**
   * Ensure both bridge scripts are responsive and reinject the main hook when needed.
   *
   * @returns {Promise<boolean>} `true` when the page hooks are ready.
   */
  async function ensurePageHooksInjected() {
    if (CGO.pageHookEnsureInFlight) {
      return CGO.pageHookEnsureInFlight;
    }

    CGO.pageHookEnsureInFlight = (async () => {
      const bootstrapAlive = await waitForBootstrapPong();

      if (!bootstrapAlive) {
        CGO.log("[warn] bootstrap not responding");
        return false;
      }

      const mainHookAliveBeforeInject = await waitForMainHookInitAck(150);
      if (mainHookAliveBeforeInject) {
        return true;
      }

      try {
        await injectMainPageHookScript();

        //const mainHookAliveAfterInject = await waitForMainHookPong();
        const mainHookAliveAfterInject = await waitForMainHookInitAck();
        if (!mainHookAliveAfterInject) {
          CGO.log("[warn] main hook did not respond after inject");
          return false;
        }

        CGO.log("main hook injected successfully");
        return true;
      } catch (error) {
        CGO.log("[error] failed to inject main hook", error);
        return false;
      }
    })();

    try {
      return await CGO.pageHookEnsureInFlight;
    } finally {
      CGO.pageHookEnsureInFlight = null;
    }
  }

  CGO.LAST_PATHNAME = location.pathname;

  /**
   * Watch SPA route changes and refresh CGO state when the conversation changes.
   */
  function observeRouteChanges() {
    let routeChangeQueue = Promise.resolve();

    function isUsableConversationCache(data) {
      return !!(
        data &&
        typeof data === "object" &&
        data.mapping &&
        typeof data.mapping === "object" &&
        Object.keys(data.mapping).length > 0
      );
    }

    async function refreshForRouteChange() {
      const conversationId = CGO.getConversationIdFromLocation?.() || "";
      const previousConversationId = CGO.STATE.activeConversationId || "";
      const sameConversation =
        !!conversationId &&
        !!previousConversationId &&
        conversationId === previousConversationId;
      CGO.STATE.activeConversationId = conversationId;
      CGO.setActiveConversationHistoryMode?.("unknown", conversationId);

      CGO.STATE.projectGuide = {
        conversationId: "",
        projectName: "",
        stats: null,
        level: 0,
      };
      CGO.resetInitialPruneNoticeState?.(true);
      CGO.handleConversationRouteChanged?.(conversationId);

      if (!conversationId || (!sameConversation && previousConversationId)) {
        CGO.updateExportButtonVisibility?.(false);
      }

      const ok = await CGO.ensurePageHooksInjected();
      if (ok) {
        await CGO.postSettingsToPageHook?.();
        const panel = document.getElementById("cgo-settings-panel");
        if (panel && typeof panel.__cgoSyncFromSettings === "function") {
          await panel.__cgoSyncFromSettings();
        }
      }

      if (conversationId) {
        try {
          const cached = await CGO.getConversationFromCache?.(conversationId);
          if (isUsableConversationCache(cached)) {
            const historyMode = cached.__cgo_paginated_history === true
              ? "paginated"
              : "legacy";
            CGO.setActiveConversationHistoryMode?.(historyMode, conversationId);
            CGO.updateExportButtonVisibility?.(true);
            if (historyMode !== "paginated") {
              CGO.requestInitialPruneMetaFromPageHook?.(conversationId);
            }
          }
        } catch (_) {
          // The cache may not be ready yet; stream/full-response events will reveal the toolbar later.
        }
      }
    }

    function handlePossibleRouteChange() {
      if (location.pathname === CGO.LAST_PATHNAME) return;

      CGO.LAST_PATHNAME = location.pathname;
      routeChangeQueue = routeChangeQueue
        .catch(() => {})
        .then(refreshForRouteChange);
    }

    const observer = new MutationObserver(() => {
      handlePossibleRouteChange();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    window.addEventListener("popstate", handlePossibleRouteChange);
    window.addEventListener("hashchange", handlePossibleRouteChange);
    setInterval(handlePossibleRouteChange, 500);
  }

  /**
   * Test whether a string matches any regular expression in a pattern list.
   *
   * @param {string} text - Text to test.
   * @param {RegExp[]} patterns - Candidate patterns.
   * @returns {boolean} `true` when at least one pattern matches.
   */
  function matchesAnyPattern(text, patterns) {
    if (!text || !Array.isArray(patterns)) return false;
    return patterns.some((pattern) => pattern.test(text));
  }

  /**
   * Detect whether text matches a localized generated-image lead-in.
   *
   * @param {string} text - Text to inspect.
   * @returns {boolean} `true` when the text matches a known generated-image prefix.
   */
  function matchesGeneratedImagePrefix(text) {
    const patterns = getDetectionPatternSet().generatedImagePrefixes;
    return matchesAnyPattern(text, patterns);
  }

  /**
   * Emit a debug log only when extension debug mode is enabled.
   *
   * @param {...any} args - Values to log.
   */
  function log(...args) {
    if (!CGO.CONFIG.debug) return;
    console.log("[CGO]", ...args);
  }

  /**
   * Resolve a localized message key with optional substitutions.
   *
   * @param {string} key - Translation key.
   * @param {Array|*} [substitutions=[]] - Replacement values for the message.
   * @returns {string} Localized text or the key when missing.
   */
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

  /**
   * Decode HTML entities into plain text.
   *
   * @param {*} str - Escaped text value.
   * @returns {string} Decoded text.
   */
  function unescapeHtml(str) {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = String(str || "");
    return textarea.value;
  }

  // page-hook.js に同名関数あり、変更時は合わせて変更
  /**
   * Compute a compact stable hash string for cache keys and ids.
   *
   * @param {string} str - Source text.
   * @returns {string} Unsigned base-36 hash.
   */
  function hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (h << 5) - h + str.charCodeAt(i);
      h |= 0;
    }
    return (h >>> 0).toString(36);
  }

  CGO.clampKeepDomMessages = clampKeepDomMessages;
  CGO.clearProjectGuideDismissed = clearProjectGuideDismissed;
  CGO.dismissProjectGuide = dismissProjectGuide;
  CGO.ensurePageHooksInjected = ensurePageHooksInjected;
  CGO.getEffectiveKeepDomMessages = getEffectiveKeepDomMessages;
  CGO.getEffectiveKeepDomMessagesForConversation = getEffectiveKeepDomMessagesForConversation;
  CGO.getEffectiveKeepDomMessagesForSettings = getEffectiveKeepDomMessagesForSettings;
  CGO.getProjectGuideLevel = getProjectGuideLevel;
  CGO.getActiveKeepDomMessages = getActiveKeepDomMessages;
  CGO.hash = hash;
  CGO.isProjectGuideDismissed = isProjectGuideDismissed;
  CGO.loadSettings = loadSettings;
  CGO.log = log;
  CGO.matchesGeneratedImagePrefix = matchesGeneratedImagePrefix;
  CGO.observeRouteChanges = observeRouteChanges;
  CGO.postSettingsToPageHook = postSettingsToPageHook;
  CGO.saveSettings = saveSettings;
  CGO.t = t;
  CGO.unescapeHtml = unescapeHtml;
})();
