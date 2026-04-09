(() => {
  globalThis.__CGO_SKIP__ = !!window.__cgoInstalled;
  if (globalThis.__CGO_SKIP__) return;
  window.__cgoInstalled = true;
  const CGO = (globalThis.__CGO ||= {});
  with (CGO) {

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

    CGO.clampKeepDomMessages = function clampKeepDomMessages(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return DEFAULT_SETTINGS.keepDomMessages;
      return Math.max(5, Math.min(200, Math.round(n)));
    }

    CGO.normalizeSettings = function normalizeSettings(input = {}) {
      return {
        keepDomMessages: clampKeepDomMessages(
          input.keepDomMessages ?? DEFAULT_SETTINGS.keepDomMessages
        ),
        autoAdjustEnabled: Boolean(
          input.autoAdjustEnabled ?? DEFAULT_SETTINGS.autoAdjustEnabled
        ),
        htmlDownloadIncludeImages:
          input.htmlDownloadIncludeImages !== false,
      };
    }

    CGO.applySettings = function applySettings(settings = {}) {
      const normalized = normalizeSettings(settings);

      SETTINGS.keepDomMessages = normalized.keepDomMessages;
      SETTINGS.autoAdjustEnabled = normalized.autoAdjustEnabled;
      SETTINGS.htmlDownloadIncludeImages = normalized.htmlDownloadIncludeImages;

      CONFIG.keepDomMessages = normalized.keepDomMessages;

      return SETTINGS;
    }

    CGO.loadSettings = async function loadSettings() {
      try {
        const stored = await chrome.storage.local.get(SETTING_STORAGE_KEY);
        const raw = stored?.[SETTING_STORAGE_KEY] || {};
        return applySettings(raw);
      } catch (error) {
        log("[warn] loadSettings failed", String(error));
        return applySettings(DEFAULT_SETTINGS);
      }
    }

    CGO.saveSettings = async function saveSettings(partial = {}) {
      const next = applySettings({
        ...SETTINGS,
        ...partial,
      });

      await chrome.storage.local.set({
        [SETTING_STORAGE_KEY]: {
          keepDomMessages: next.keepDomMessages,
          autoAdjustEnabled: next.autoAdjustEnabled,
          htmlDownloadIncludeImages: next.htmlDownloadIncludeImages,
        },
      });

      return next;
    }

    CGO.CONVERSATION_OVERRIDE_STORAGE_KEY = "cgo_conversation_overrides";

    CGO.PROJECT_GUIDE_DISMISSED_STORAGE_KEY = "cgo_project_guide_dismissed";

    CGO.getProjectGuideLevel = function getProjectGuideLevel(stats = null) {
      if (!stats) return 0;

      const conversationalLength = Number(stats.conversationalLength || 0);
      const chainLength = Number(stats.chainLength || 0);

      if (conversationalLength >= 950 || chainLength >= 3200) return 3;
      if (conversationalLength >= 800 || chainLength >= 2600) return 2;
      if (conversationalLength >= 600 || chainLength >= 2000) return 1;
      return 0;
    }

    CGO.loadProjectGuideDismissedMap = async function loadProjectGuideDismissedMap() {
      try {
        const stored = await chrome.storage.local.get(PROJECT_GUIDE_DISMISSED_STORAGE_KEY);
        return stored?.[PROJECT_GUIDE_DISMISSED_STORAGE_KEY] || {};
      } catch (error) {
        log("[warn] loadProjectGuideDismissedMap failed", String(error));
        return {};
      }
    }

    CGO.isProjectGuideDismissed = async function isProjectGuideDismissed(conversationId, level = 0) {
      if (!conversationId || level <= 0) return false;

      const map = await loadProjectGuideDismissedMap();
      const saved = map?.[conversationId];
      if (!saved) return false;

      return Number(saved.level || 0) >= level;
    }

    CGO.dismissProjectGuide = async function dismissProjectGuide(conversationId, level = 0) {
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

    CGO.clearProjectGuideDismissed = async function clearProjectGuideDismissed(conversationId) {
      if (!conversationId) return;

      const map = await loadProjectGuideDismissedMap();
      if (!map[conversationId]) return;

      delete map[conversationId];

      await chrome.storage.local.set({
        [PROJECT_GUIDE_DISMISSED_STORAGE_KEY]: map,
      });
    }
 
    CGO.loadConversationOverrides = async function loadConversationOverrides() {
      try {
        const stored = await chrome.storage.local.get(CONVERSATION_OVERRIDE_STORAGE_KEY);
        return stored?.[CONVERSATION_OVERRIDE_STORAGE_KEY] || {};
      } catch (error) {
        log("[warn] loadConversationOverrides failed", String(error));
        return {};
      }
    }

    CGO.loadConversationOverride = async function loadConversationOverride(conversationId) {
      if (!conversationId) return null;

      const map = await loadConversationOverrides();
      return map?.[conversationId] || null;
    }

    CGO.saveConversationOverride = async function saveConversationOverride(conversationId, keepDomMessages) {
      if (!conversationId) return null;

      const map = await loadConversationOverrides();

      map[conversationId] = {
        keepDomMessages: clampKeepDomMessages(keepDomMessages),
        updatedAt: Date.now(),
      };

      await chrome.storage.local.set({
        [CONVERSATION_OVERRIDE_STORAGE_KEY]: map,
      });

      return map[conversationId];
    }

    CGO.clearConversationOverride = async function clearConversationOverride(conversationId) {
      if (!conversationId) return;

      const map = await loadConversationOverrides();
      delete map[conversationId];

      await chrome.storage.local.set({
        [CONVERSATION_OVERRIDE_STORAGE_KEY]: map,
      });
    }

    CGO.getEffectiveKeepDomMessagesForConversation =
      async function getEffectiveKeepDomMessagesForConversation(conversationId = null, stats = null) {
        if (!SETTINGS.autoAdjustEnabled) {
          return SETTINGS.keepDomMessages;
        }

        if (!conversationId) {
          conversationId = getConversationIdFromLocation()
        }

        if (conversationId) {
          const override = await loadConversationOverride(conversationId);
          if (override?.keepDomMessages) {
            return clampKeepDomMessages(override.keepDomMessages);
          }
        }
        if (stats) {
          return getEffectiveKeepDomMessages(stats);
        } else {
          return SETTINGS.keepDomMessages;
        }
      }

    CGO.postSettingsToPageHook = async function postSettingsToPageHook() {
      const keepDomMessages = await getEffectiveKeepDomMessagesForConversation();
      window.postMessage(
        {
          source: "CGO_CONTENT",
          type: "CGO_UPDATE_SETTINGS",
          settings: {
            keepDomMessages: keepDomMessages,
            autoAdjustEnabled: SETTINGS.autoAdjustEnabled,
          },
        },
        "*"
      );
    }

    CGO.getEffectiveKeepDomMessages = function getEffectiveKeepDomMessages(stats = null) {
      if (!SETTINGS.autoAdjustEnabled || !stats) {
        return SETTINGS.keepDomMessages;
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
    
      if (score >= 480) return Math.max(8, Math.min(SETTINGS.keepDomMessages, 10));
      if (score >= 220) return Math.max(10, Math.min(SETTINGS.keepDomMessages, 15));
      if (score >= 140) return Math.max(12, Math.min(SETTINGS.keepDomMessages, 25));
    
      return SETTINGS.keepDomMessages;
    }

    CGO.getDetectionLanguage = function getDetectionLanguage() {
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

    CGO.getDetectionPatternSet = function getDetectionPatternSet() {
      return (
        DETECTION_PATTERNS[DETECTION_LANG] ||
        DETECTION_PATTERNS.en
      );
    }

    CGO.injectPageBootstrapScript = function injectPageBootstrapScript() {
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

    CGO.waitForBootstrapPong = function waitForBootstrapPong(timeoutMs = 1200) {
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
              version: PAGE_HOOK_VERSION,
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

    /*    CGO.waitForMainHookPong = function waitForMainHookPong(timeoutMs = 1000) {
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
        }*/

    CGO.waitForMainHookInitAck = function waitForMainHookInitAck(timeoutMs = 1000) {
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
              version: PAGE_HOOK_VERSION,
              settings: {
                keepDomMessages: SETTINGS.keepDomMessages,
                autoAdjustEnabled: SETTINGS.autoAdjustEnabled,
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
            resolve(data.version === PAGE_HOOK_VERSION);
          }
        }

        window.addEventListener("message", onMessage);
        sendInit();
      });
    }

    CGO.injectMainPageHookScript = async function injectMainPageHookScript() {
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

    CGO.ensurePageHooksInjected = async function ensurePageHooksInjected() {
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

        //const mainHookAliveAfterInject = await waitForMainHookPong();
        const mainHookAliveAfterInject = await waitForMainHookInitAck();
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

    CGO.LAST_PATHNAME = location.pathname;

    CGO.observeRouteChanges = function observeRouteChanges() {
      const observer = new MutationObserver(async () => {
        if (location.pathname !== LAST_PATHNAME) {
          LAST_PATHNAME = location.pathname;

          STATE.projectGuide = {
            conversationId: "",
            projectName: "",
            stats: null,
            level: 0,
          };

          updateExportButtonVisibility(false);
          injectExportButtonIntoHeader();

          const ok = await ensurePageHooksInjected();
          if (ok) {
            await postSettingsToPageHook?.();
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

    /*    CGO.observeConversationStats = function observeConversationStats() {
          window.addEventListener("message", (event) => {
            if (event.source !== window) return;
    
            const data = event.data;
            if (!data || data.source !== "CGO_PAGE") return;
    
            if (data.type === "CGO_AUTO_ADJUST_RESULT") {
              const conversationId = data.conversationId || "";
              const effectiveKeepDomMessages = Number(data.effectiveKeepDomMessages || 0);
              const baseKeepDomMessages = Number(data.baseKeepDomMessages || 0);
    
              log("[autoAdjustResult]", {
                conversationId,
                baseKeepDomMessages,
                effectiveKeepDomMessages,
                stats: data.stats || null,
              });
    
              if (
                SETTINGS.autoAdjustEnabled &&
                conversationId &&
                Number.isFinite(effectiveKeepDomMessages) &&
                effectiveKeepDomMessages > 0 &&
                effectiveKeepDomMessages < SETTINGS.keepDomMessages
              ) {
                saveConversationOverride(conversationId, effectiveKeepDomMessages)
                  .then(() => {
                    log("[autoAdjustResult] saved override", {
                      conversationId,
                      keepDomMessages: effectiveKeepDomMessages,
                    });
                  })
                  .catch((error) => {
                    log("[warn] saveConversationOverride failed", String(error));
                  });
              }
            }
          });
        }*/

    CGO.matchesAnyPattern = function matchesAnyPattern(text, patterns) {
      if (!text || !Array.isArray(patterns)) return false;
      return patterns.some((pattern) => pattern.test(text));
    }

    CGO.matchesGeneratedImagePrefix = function matchesGeneratedImagePrefix(text) {
      const patterns = getDetectionPatternSet().generatedImagePrefixes;
      return matchesAnyPattern(text, patterns);
    }

    CGO.log = function log(...args) {
      if (!CONFIG.debug) return;
      console.log("[CGO]", ...args);
    }

    CGO.t = function t(key, substitutions = []) {
      if (!Array.isArray(substitutions)) {
        substitutions = [substitutions];
      }
      try {
        return chrome.i18n.getMessage(key, substitutions) || key;
      } catch {
        return key;
      }
    }

    CGO.unescapeHtml = function unescapeHtml(str) {
      const textarea = document.createElement("textarea");
      textarea.innerHTML = String(str || "");
      return textarea.value;
    }

    // page-hook.js に同名関数あり、変更時は合わせて変更
    CGO.hash = function hash(str) {
      let h = 0;
      for (let i = 0; i < str.length; i++) {
        h = (h << 5) - h + str.charCodeAt(i);
        h |= 0;
      }
      return (h >>> 0).toString(36);
    }

  }
})();