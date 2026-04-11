(() => {
  if (globalThis.__CGO_SKIP__) return;
  const CGO = (globalThis.__CGO ||= {});

  /**
   * Return the root element that contains the visible conversation turns.
   *
   * @returns {?HTMLElement} Conversation root element.
   */
  function getConversationRoot() {
    return document.querySelector("main");
  }
    
  /**
   * Collect currently mounted conversation turn articles from the ChatGPT UI.
   *
   * @returns {HTMLElement[]} Connected turn nodes in DOM order.
   */
  function getTurnArticles() {
    const root = getConversationRoot();
    if (!root) return [];
    
    return Array.from(
      root.querySelectorAll('article[data-testid^="conversation-turn-"]')
    ).filter((node) => node && node.isConnected);
  }

  /**
   * Remove the oldest visible turns once the DOM exceeds the configured retention budget.
   */
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

  /**
   * Schedule work during an idle period with a timeout fallback for browsers without `requestIdleCallback`.
   *
   * @param {Function} fn - Callback to run when the browser is idle.
   * @param {number} [timeout=2000] - Idle callback timeout hint in milliseconds.
   */
  function runWhenIdle(fn, timeout = 2000) {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(fn, { timeout });
      return;
    }
    setTimeout(fn, 0);
  }

  /**
   * Queue a single deferred DOM trim pass after streaming settles.
   *
   * @param {number} [delayMs=CGO.CONFIG.domTrimDelayMs] - Delay before trimming begins.
   */
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

  function observeStreamCompletion() {
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

  /**
   * Handle messages emitted by the injected page runtime and update extension UI state.
   *
   * @param {Object} data - Runtime payload posted on `window`.
   */
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

  function observeWindowMessages() {
    window.addEventListener("message", (event) => {
      if (event.source !== window) return;

      const data = event.data;
      if (!data || data.source !== "cgo-prune-runtime") return;

      handleRuntimeMessage(data);
    });
  }

  CGO.observeStreamCompletion = observeStreamCompletion;
  CGO.observeWindowMessages = observeWindowMessages;
})();
