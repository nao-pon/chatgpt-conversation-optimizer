(() => {
  if (globalThis.__CGO_SKIP__) return;
  const CGO = (globalThis.__CGO ||= {});
  with (CGO) {
    CGO.getConversationRoot = function getConversationRoot() {
      return document.querySelector("main");
    }
    
    CGO.getTurnArticles = function getTurnArticles() {
      const root = getConversationRoot();
      if (!root) return [];
    
      return Array.from(
        root.querySelectorAll('article[data-testid^="conversation-turn-"]')
      ).filter((node) => node && node.isConnected);
    }

    CGO.trimOldDomTurns = function trimOldDomTurns() {
      const nodes = getTurnArticles();
      const removeCount = nodes.length - CONFIG.keepDomMessages;

      if (removeCount <= 0 || !nodes.length) return;

      // const fragment = document.createDocumentFragment();

      for (const node of nodes.slice(0, removeCount)) {
        // fragment.appendChild(node);
        node.remove();
      }

      log("DOM trim", {
        total: nodes.length,
        removed: removeCount,
        kept: CONFIG.keepDomMessages,
      });
    }

    CGO.runWhenIdle = function runWhenIdle(fn, timeout = 2000) {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(fn, { timeout });
        return;
      }
      setTimeout(fn, 0);
    }

    CGO.scheduleDomTrim = function scheduleDomTrim(delayMs = CONFIG.domTrimDelayMs) {
      if (STATE.trimScheduled) return;
      STATE.trimScheduled = true;

      setTimeout(() => {
        runWhenIdle(() => {
          STATE.trimScheduled = false;
          trimOldDomTurns();
        }, 2000);
      }, delayMs);
    }

    CGO.observeStreamCompletion = function observeStreamCompletion() {
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

    CGO.handleRuntimeMessage = function handleRuntimeMessage(data) {
      if (data.type === "autoAdjustResult") {
        const conversationId = data.conversationId || getConversationIdFromLocation?.() || "";
        const projectName = data.projectName || "";
        const stats = data.stats || null;
        const level = getProjectGuideLevel(stats);
        const effective = Number(data.effectiveKeepDomMessages || 0);

        log("[autoAdjustResult]", data);

        if (
          SETTINGS.autoAdjustEnabled &&
          conversationId &&
          effective > 0 &&
          effective < SETTINGS.keepDomMessages
        ) {
          saveConversationOverride(conversationId, effective)
            .then(() => {
              log("[autoAdjustResult] saved", {
                conversationId,
                effective,
              });
              SETTINGS.keepDomMessages = effective;
              scheduleDomTrim(0);
            })
            .catch((e) => {
              log("[warn] saveConversationOverride failed", String(e));
            });
        }

        STATE.projectGuide = {
          conversationId,
          projectName,
          stats,
          level,
        };

        void updateProjectGuideVisibility?.();
        void updateProjectGuideAlertVisibility?.();

        return;
      }

      if (data.type === "analysis") {
        updateExportButtonVisibility(true)
        console.group("[CGO prune analysis]");
        console.log("url:", data.url);
        console.log("summary:", data.summary);
        console.groupEnd();
        return;
      }

      if (data.type === "streamNotify") {
        updateExportButtonVisibility(true);
        log("[streamNotify]", data.message);
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

    CGO.observeWindowMessages = function observeWindowMessages() {
      window.addEventListener("message", (event) => {
        if (event.source !== window) return;

        const data = event.data;
        if (!data || data.source !== "cgo-prune-runtime") return;

        handleRuntimeMessage(data);
      });
    }

    // exporter
  }
})();