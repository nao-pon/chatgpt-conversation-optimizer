(() => {
  globalThis.__CGO_SKIP__ = !!window.__cgoInstalled;
  if (globalThis.__CGO_SKIP__) return;
  window.__cgoInstalled = true;
  const CGO = (globalThis.__CGO ||= {});


  CGO.PAGE_HOOK_VERSION = "2";
  CGO.PAGE_BOOTSTRAP_ID = "cgo-page-bootstrap";
  CGO.PAGE_MAIN_HOOK_ID = "cgo-page-hook-script";

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
    domTrimDelayMs: 1200,
    debug: true,
  };

  CGO.STATE = {
    trimScheduled: false,
    initialPruneMeta: null,
    initialPruneNoticeScheduled: false,
    initialPruneNoticeTimer: null,
    initialPruneNoticeRetryCount: 0,
    lastStopVisible: false,
    projectGuide: {
      conversationId: "",
      projectName: "",
      stats: null,
      level: 0,
    },
  };

  CGO.DEFAULT_SETTINGS = {
    keepDomMessages: 40,
    autoAdjustEnabled: true,
    htmlDownloadIncludeImages: true,
  };

  CGO.SETTINGS = {
    ...CGO.DEFAULT_SETTINGS,
  };

  CGO.SETTING_STORAGE_KEY = "cgo_settings";

  function clampKeepDomMessages(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return CGO.DEFAULT_SETTINGS.keepDomMessages;
    return Math.max(5, Math.min(200, Math.round(n)));
  }

  /**
   * Normalize persisted settings into a complete configuration object with defaults applied.
   *
   * @param {Object} [input={}] - Partial settings loaded from storage or UI input.
   * @returns {{keepDomMessages: number, autoAdjustEnabled: boolean, htmlDownloadIncludeImages: boolean}} Sanitized settings.
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

    CGO.CONFIG.keepDomMessages = normalized.keepDomMessages;

    return CGO.SETTINGS;
  }

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
      },
    });

    return next;
  }

  CGO.CONVERSATION_OVERRIDE_STORAGE_KEY = "cgo_conversation_overrides";
  const PROJECT_GUIDE_DISMISSED_STORAGE_KEY = "cgo_project_guide_dismissed";

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

  async function isProjectGuideDismissed(conversationId, level = 0) {
    if (!conversationId || level <= 0) return false;

    const map = await loadProjectGuideDismissedMap();
    const saved = map?.[conversationId];
    if (!saved) return false;

    return Number(saved.level || 0) >= level;
  }

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
   * Read saved conversation-specific DOM retention overrides from local storage.
   *
   * @returns {Promise<Object>} Map of conversation ids to override objects.
   */
  async function loadConversationOverrides() {
    try {
      const stored = await chrome.storage.local.get(CGO.CONVERSATION_OVERRIDE_STORAGE_KEY);
      return stored?.[CGO.CONVERSATION_OVERRIDE_STORAGE_KEY] || {};
    } catch (error) {
      CGO.log("[warn] loadConversationOverrides failed", String(error));
      return {};
    }
  }

  async function loadConversationOverride(conversationId) {
    if (!conversationId) return null;

    const map = await loadConversationOverrides();
    return map?.[conversationId] || null;
  }

  async function saveConversationOverride(conversationId, keepDomMessages) {
    if (!conversationId) return null;

    const map = await loadConversationOverrides();

    map[conversationId] = {
      keepDomMessages: CGO.clampKeepDomMessages(keepDomMessages),
      updatedAt: Date.now(),
    };

    await chrome.storage.local.set({
      [CGO.CONVERSATION_OVERRIDE_STORAGE_KEY]: map,
    });

    return map[conversationId];
  }

  async function clearConversationOverride(conversationId) {
    if (!conversationId) return;

    const map = await loadConversationOverrides();
    delete map[conversationId];

    await chrome.storage.local.set({
      [CGO.CONVERSATION_OVERRIDE_STORAGE_KEY]: map,
    });
  }

  /**
   * Compute the effective DOM retention count for the active conversation.
   *
   * Conversation-specific overrides take precedence, followed by auto-adjusted values from
   * conversation stats, and finally the global setting.
   *
   * @param {?string} [conversationId=null] - Explicit conversation id when already known.
   * @param {?Object} [stats=null] - Optional conversation statistics used for auto-adjust.
   * @returns {Promise<number>} Effective number of conversation turns to keep in the DOM.
   */
  async function getEffectiveKeepDomMessagesForConversation(conversationId = null, stats = null) {
    if (!CGO.SETTINGS.autoAdjustEnabled) {
      return CGO.SETTINGS.keepDomMessages;
    }

    if (!conversationId) {
      conversationId = CGO.getConversationIdFromLocation()
    }

    if (conversationId) {
      const override = await CGO.loadConversationOverride(conversationId);
      if (override?.keepDomMessages) {
        return CGO.clampKeepDomMessages(override.keepDomMessages);
      }
    }
    if (stats) {
      return getEffectiveKeepDomMessages(stats);
    } else {
      return CGO.SETTINGS.keepDomMessages;
    }
  }

  async function postSettingsToPageHook() {
    const keepDomMessages = await getEffectiveKeepDomMessagesForConversation();
    window.postMessage(
      {
        source: "CGO_CONTENT",
        type: "CGO_UPDATE_SETTINGS",
        settings: {
          keepDomMessages: keepDomMessages,
          autoAdjustEnabled: CGO.SETTINGS.autoAdjustEnabled,
        },
      },
      "*"
    );
  }

  /**
   * Derive a smaller DOM retention budget for large conversations based on conversation stats.
   *
   * @param {?Object} [stats=null] - Conversation metrics such as turn count and media counts.
   * @returns {number} Effective keep-dom value after applying auto-adjust thresholds.
   */
  function getEffectiveKeepDomMessages(stats = null) {
    if (!CGO.SETTINGS.autoAdjustEnabled || !stats) {
      return CGO.SETTINGS.keepDomMessages;
    }
    
    const turnCount = Number(stats.turnCount || 0);
    const textLength = Number(stats.textLength || 0);
    const imageCount = Number(stats.imageCount || 0);
    const attachmentCount = Number(stats.attachmentCount || 0);
    
    const score =
      turnCount * 3 +
      textLength / 2000 +
      imageCount * 8 +
      attachmentCount * 4;
    
    if (score >= 480) return Math.max(8, Math.min(CGO.SETTINGS.keepDomMessages, 10));
    if (score >= 220) return Math.max(10, Math.min(CGO.SETTINGS.keepDomMessages, 15));
    if (score >= 140) return Math.max(12, Math.min(CGO.SETTINGS.keepDomMessages, 25));
    
    return CGO.SETTINGS.keepDomMessages;
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
   * Inject the lightweight bootstrap page script that establishes the content/page bridge.
   */
  function injectPageBootstrapScript() {
    const oldScript = document.getElementById(CGO.PAGE_BOOTSTRAP_ID);
    if (oldScript) {
      oldScript.remove();
    }

    const script = document.createElement("script");
    script.id = CGO.PAGE_BOOTSTRAP_ID;
    script.src = chrome.runtime.getURL("page-bootstrap.js");
    script.dataset.cgoVersion = CGO.PAGE_HOOK_VERSION;

    script.onload = () => {
      CGO.log("page bootstrap loaded");
    };

    script.onerror = (error) => {
      CGO.log("[error] page bootstrap load failed", error);
    };

    (document.documentElement || document.head).prepend(script);
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
       * where `settings` contains `keepDomMessages` and `autoAdjustEnabled`.
       */
      function sendInit() {
        window.postMessage(
          {
            source: "CGO_CONTENT",
            type: "CGO_INIT_SETTINGS",
            version: CGO.PAGE_HOOK_VERSION,
            settings: {
              keepDomMessages: CGO.SETTINGS.keepDomMessages,
              autoAdjustEnabled: CGO.SETTINGS.autoAdjustEnabled,
            },
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

  async function ensurePageHooksInjected() {
    const bootstrapAlive = await waitForBootstrapPong();

    if (!bootstrapAlive) {
      CGO.log("[warn] bootstrap not responding");
      return false;
    }

    // ChatGPT Web は SPA（シングルページアプリ）のため
    // injection が外れることがあるので毎回 inject する
    // 副作用は殆どない
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
  }

  CGO.LAST_PATHNAME = location.pathname;

  function observeRouteChanges() {
    const observer = new MutationObserver(async () => {
      if (location.pathname !== CGO.LAST_PATHNAME) {
        CGO.LAST_PATHNAME = location.pathname;

        CGO.STATE.projectGuide = {
          conversationId: "",
          projectName: "",
          stats: null,
          level: 0,
        };
        CGO.resetInitialPruneNoticeState?.(true);

        CGO.updateExportButtonVisibility?.(false);
        CGO.injectExportButtonIntoHeader?.();

        const ok = await CGO.ensurePageHooksInjected();
        if (ok) {
          await CGO.postSettingsToPageHook?.();
          const panel = document.getElementById("cgo-settings-panel");
          if (panel && typeof panel.__cgoSyncFromSettings === "function") {
            await panel.__cgoSyncFromSettings();
          }
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
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

  function matchesGeneratedImagePrefix(text) {
    const patterns = getDetectionPatternSet().generatedImagePrefixes;
    return matchesAnyPattern(text, patterns);
  }

  function log(...args) {
    if (!CGO.CONFIG.debug) return;
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

  function unescapeHtml(str) {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = String(str || "");
    return textarea.value;
  }

  // page-hook.js に同名関数あり、変更時は合わせて変更
  function hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (h << 5) - h + str.charCodeAt(i);
      h |= 0;
    }
    return (h >>> 0).toString(36);
  }

  CGO.clampKeepDomMessages = clampKeepDomMessages;
  CGO.clearConversationOverride = clearConversationOverride;
  CGO.clearProjectGuideDismissed = clearProjectGuideDismissed;
  CGO.dismissProjectGuide = dismissProjectGuide;
  CGO.ensurePageHooksInjected = ensurePageHooksInjected;
  CGO.getProjectGuideLevel = getProjectGuideLevel;
  CGO.hash = hash;
  CGO.isProjectGuideDismissed = isProjectGuideDismissed;
  CGO.loadConversationOverride = loadConversationOverride;
  CGO.loadSettings = loadSettings;
  CGO.log = log;
  CGO.matchesGeneratedImagePrefix = matchesGeneratedImagePrefix;
  CGO.observeRouteChanges = observeRouteChanges;
  CGO.postSettingsToPageHook = postSettingsToPageHook;
  CGO.saveConversationOverride = saveConversationOverride;
  CGO.saveSettings = saveSettings;
  CGO.t = t;
  CGO.unescapeHtml = unescapeHtml;
})();
