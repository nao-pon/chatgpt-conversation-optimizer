(() => {
  if (globalThis.__CGO_SKIP__) return;
  const CGO = (globalThis.__CGO ||= {});

  function getConversationRoot() {
    return document.querySelector("main");
  }
    
  function getTurnArticles() {
    const root = getConversationRoot();
    if (!root) return [];
    
    return Array.from(
      root.querySelectorAll('article[data-testid^="conversation-turn-"]')
    ).filter((node) => node && node.isConnected);
  }

  function trimOldDomTurns() {
    const nodes = getTurnArticles();
    const removeCount = nodes.length - CGO.CONFIG.keepDomMessages;

    if (removeCount <= 0 || !nodes.length) return;

    // const fragment = document.createDocumentFragment();

    for (const node of nodes.slice(0, removeCount)) {
      // fragment.appendChild(node);
      node.remove();
    }

    CGO.log("DOM trim", {
      total: nodes.length,
      removed: removeCount,
      kept: CGO.CONFIG.keepDomMessages,
    });
  }

  function runWhenIdle(fn, timeout = 2000) {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(fn, { timeout });
      return;
    }
    setTimeout(fn, 0);
  }

  function scheduleDomTrim(delayMs = CGO.CONFIG.domTrimDelayMs) {
    if (CGO.STATE.trimScheduled) return;
    CGO.STATE.trimScheduled = true;

    setTimeout(() => {
      runWhenIdle(() => {
        CGO.STATE.trimScheduled = false;
        trimOldDomTurns();
      }, 2000);
    }, delayMs);
  }

  CGO.observeStreamCompletion = function observeStreamCompletion() {
    const observer = new MutationObserver(() => {
      if (!location.pathname.startsWith("/c/")) return;

      const stopButton = document.querySelector('button[data-testid="stop-button"]');
      const stopVisible = !!stopButton;

      if (CGO.STATE.lastStopVisible && !stopVisible) {
        scheduleDomTrim();
      }

      CGO.STATE.lastStopVisible = stopVisible;
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function handleRuntimeMessage(data) {
    if (data.type === "autoAdjustResult") {
      const conversationId = data.conversationId || CGO.getConversationIdFromLocation?.() || "";
      const projectName = data.projectName || "";
      const stats = data.stats || null;
      const level = CGO.getProjectGuideLevel(stats);
      const effective = Number(data.effectiveKeepDomMessages || 0);

      CGO.log("[autoAdjustResult]", data);

      if (
        CGO.SETTINGS.autoAdjustEnabled &&
        conversationId &&
        effective > 0 &&
        effective < CGO.SETTINGS.keepDomMessages
      ) {
        CGO.saveConversationOverride(conversationId, effective)
          .then(() => {
            CGO.log("[autoAdjustResult] saved", {
              conversationId,
              effective,
            });
            CGO.SETTINGS.keepDomMessages = effective;
            scheduleDomTrim(0);
          })
          .catch((e) => {
            CGO.log("[warn] saveConversationOverride failed", String(e));
          });
      }

      CGO.STATE.projectGuide = {
        conversationId,
        projectName,
        stats,
        level,
      };

      void CGO.updateProjectGuideVisibility?.();
      void CGO.updateProjectGuideAlertVisibility?.();

      return;
    }

    if (data.type === "analysis") {
      CGO.updateExportButtonVisibility?.(true)
      console.group("[CGO prune analysis]");
      console.log("url:", data.url);
      console.log("summary:", data.summary);
      console.groupEnd();
      return;
    }

    if (data.type === "streamNotify") {
      CGO.updateExportButtonVisibility?.(true);
      CGO.log("[streamNotify]", data.message);
      return;
    }

    if (data.type === "log") {
      CGO.log(...(data.args || []));
      return;
    }

    if (data.type === "error") {
      CGO.log("[error]", data.error);
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
})();