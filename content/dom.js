(() => {
  if (globalThis.__CGO_SKIP__) return;
  const CGO = (globalThis.__CGO ||= {});
  const INITIAL_PRUNE_NOTICE_DEBOUNCE_MS = 120;
  const INITIAL_PRUNE_NOTICE_RETRY_DELAY_MS = 180;
  const INITIAL_PRUNE_NOTICE_MAX_RETRIES = 10;

  /**
   * Return the root element that contains the visible conversation turns.
   *
   * @returns {?HTMLElement} Conversation root element.
   */
  function getConversationRoot() {
    return document.querySelector("main");
  }
    
  /**
   * Collect visible conversation turn blocks from the ChatGPT UI.
   *
   * The current ChatGPT DOM is not stable enough to rely on a single selector.
   * This function first tries known turn container selectors, then falls back to
   * locating elements with `data-message-id` and climbing to a reasonable block parent.
   *
   * @returns {HTMLElement[]} Connected turn-like block nodes in DOM order.
   */
  function getTurnBlocks() {
    const root = getConversationRoot();
    if (!root) {
      CGO.log("[dom] getTurnBlocks: root not found");
      return [];
    }

    const directSelectors = [
      'article[data-testid^="conversation-turn-"]',
      "article[data-turn-id]",
      "section[data-turn-id]",
      "div[data-turn-id]",
    ];

    for (const selector of directSelectors) {
      const nodes = Array.from(root.querySelectorAll(selector))
        .filter((node) => node && node.isConnected);

      if (nodes.length) {
        CGO.log("[dom] getTurnBlocks: matched direct selector", {
          selector,
          count: nodes.length,
        });
        return nodes;
      }
    }

    const messageNodes = Array.from(root.querySelectorAll("[data-message-id]"))
      .filter((node) => node && node.isConnected);

    if (!messageNodes.length) {
      CGO.log("[dom] getTurnBlocks: no [data-message-id] nodes found");
      //return [];
    }

    const blocks = [];
    const seen = new Set();

    for (const node of messageNodes) {
      const block =
        node.closest("article") ||
        node.closest("section") ||
        node.closest("div");

      if (!block || !block.isConnected || seen.has(block)) continue;

      seen.add(block);
      blocks.push(block);
    }

    CGO.log("[dom] getTurnBlocks: fallback via [data-message-id]", {
      messageNodeCount: messageNodes.length,
      blockCount: blocks.length,
    });

    return blocks;
  }

  /**
   * Remove the custom omission notice inserted between the preserved first turn and newer turns.
   */
  function removeTrimNotice() {
    document.getElementById("cgo-dom-trim-notice")?.remove();
  }

  /**
   * Remove the synthetic first-message card injected for initial pruned renders.
   */
  function removeInitialMessageCard() {
    document.getElementById("cgo-dom-initial-message")?.remove();
  }

  /**
   * Clear pending initial-prune notice scheduling state.
   *
   * @param {boolean} [clearMeta=false] - When true, also drop the stored initial prune metadata.
   */
  function resetInitialPruneNoticeState(clearMeta = false) {
    if (CGO.STATE.initialPruneNoticeTimer) {
      clearTimeout(CGO.STATE.initialPruneNoticeTimer);
    }

    CGO.STATE.initialPruneNoticeTimer = null;
    CGO.STATE.initialPruneNoticeScheduled = false;
    CGO.STATE.initialPruneNoticeRetryCount = 0;

    if (clearMeta) {
      CGO.STATE.conversationHeadMeta = null;
      CGO.STATE.domTrimState = {
        omittedCount: 0,
        firstKeptId: "",
      };
      removeTrimNotice();
      removeInitialMessageCard();
    }
  }

  /**
   * Extract the best-effort message id from a visible conversation block node.
   *
   * @param {HTMLElement|null|undefined} node - Chat turn block element.
   * @returns {string} Message id or an empty string when unavailable.
   */
  function getTurnMessageId(node) {
    if (!node || !node.isConnected) return "";

    return (
      node.getAttribute("data-message-id") ||
      node.getAttribute("data-turn-id") ||
      node.querySelector("[data-message-id]")?.getAttribute("data-message-id") ||
      ""
    );
  }

  /**
   * Build the omission notice shown after the preserved first message.
   *
   * @param {number} omittedCount - Number of hidden messages between the preserved head and tail.
   * @param {string} anchorMessageId - Message id used as the lightweight viewer scroll target.
   * @returns {HTMLDivElement} Render-ready notice element.
   */
  function createTrimNotice(omittedCount, anchorMessageId) {
    const notice = document.createElement("div");
    notice.id = "cgo-dom-trim-notice";
    notice.className = "cgo-dom-trim-notice";
    notice.setAttribute("role", "status");

    const text = document.createElement("span");
    text.className = "cgo-dom-trim-notice-text";
    text.textContent = CGO.t("dom_trim_omitted_notice", String(omittedCount));

    const button = document.createElement("button");
    button.type = "button";
    button.className = "cgo-dom-trim-notice-link";
    button.textContent = CGO.t("dom_trim_open_lightweight_link");

    button.addEventListener("click", async () => {
      if (typeof CGO.exportCurrentConversationAsHtml !== "function") return;

      try {
        button.disabled = true;
        await CGO.exportCurrentConversationAsHtml(button, anchorMessageId || CGO.getCurrentVisibleMessageId?.() || "");
      } catch (error) {
        CGO.log("[warn] lightweight viewer from trim notice failed", String(error));
      } finally {
        button.disabled = false;
      }
    });

    notice.append(text, button);
    return notice;
  }

  /**
   * Escape message text for safe inline HTML.
   *
   * @param {*} value - Text value.
   * @returns {string} Escaped HTML string.
   */
  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * Format a unix timestamp (seconds) for the injected first-message card.
   *
   * @param {number|null|undefined} value - Unix timestamp in seconds.
   * @returns {string} Localized date/time text.
   */
  function formatCreateTime(value) {
    if (!value) return "";
    try {
      return new Date(Number(value) * 1000).toLocaleString();
    } catch (_) {
      return "";
    }
  }

  /**
   * Build a lightweight DOM card for the original first message kept outside the pruned data payload.
   *
   * @param {{role?: string, text?: string, createTime?: number|null}} message - Initial message payload.
   * @returns {HTMLDivElement} Render-ready card element.
   */
  function createInitialMessageCard(message) {
    const role = String(message?.role || "user");
    const roleLabel = role === "assistant" ? CGO.t("role_assistant") : CGO.t("role_user");
    const dateText = formatCreateTime(message?.createTime);
    const text = escapeHtml(String(message?.renderText || message?.text || ""));

    const card = document.createElement("div");
    card.id = "cgo-dom-initial-message";
    card.className = `cgo-dom-initial-message cgo-dom-initial-message-${role}`;
    card.innerHTML = `
      <div class="cgo-dom-initial-message-header">
        <span class="cgo-dom-initial-message-role">${escapeHtml(roleLabel)}</span>
        <span class="cgo-dom-initial-message-date">${escapeHtml(dateText)}</span>
      </div>
      <div class="cgo-dom-initial-message-body">${text.replace(/\n/g, "<br>")}</div>
    `;

    return card;
  }

  /**
   * Insert the omission notice for the initial pruned response once the first and tail turns are mounted.
   *
   * @returns {"done"|"retry"} `retry` when the DOM is not ready yet.
   */
  function ensureInitialPruneNotice() {
    const head = CGO.STATE.conversationHeadMeta;
    const trim = CGO.STATE.domTrimState;

    if (!trim || Number(trim.omittedCount || 0) <= 0) return "done";
    if (document.getElementById("cgo-dom-trim-notice")) return "done";

    const conversationId = CGO.getConversationIdFromLocation?.() || "";
    if (head?.conversationId && conversationId && head.conversationId !== conversationId) {
      return "done";
    }

    const nodes = getTurnBlocks();
    if (!nodes.length) return "retry";

    const preservedHead = nodes[0] || null;
    const preservedTailFirst =
      nodes.find((node) => getTurnMessageId(node) === trim.firstKeptId) ||
      nodes[0] ||
      null;

    if (!preservedHead || !preservedTailFirst) return "retry";

    if (head?.firstMessage && !document.getElementById("cgo-dom-initial-message")) {
      const initialCard = createInitialMessageCard(head.firstMessage);
      preservedHead.insertAdjacentElement("beforebegin", initialCard);
    }

    const anchor = document.getElementById("cgo-dom-initial-message") || preservedHead;
    if (!anchor || !anchor.isConnected) return "retry";

    const notice = createTrimNotice(Number(trim.omittedCount || 0), trim.firstKeptId || "");
    anchor.insertAdjacentElement("afterend", notice);
    return "done";
  }

  /**
   * Debounce and retry initial-prune notice insertion until the required DOM blocks are mounted.
   *
   * @param {number} [delayMs=INITIAL_PRUNE_NOTICE_DEBOUNCE_MS] - Delay before the next attempt.
   */
  function scheduleInitialPruneNotice(delayMs = INITIAL_PRUNE_NOTICE_DEBOUNCE_MS) {
    const trim = CGO.STATE.domTrimState;

    if (!trim || Number(trim.omittedCount || 0) <= 0) {
      resetInitialPruneNoticeState();
      return;
    }

    if (document.getElementById("cgo-dom-trim-notice")) {
      resetInitialPruneNoticeState(false);
      return;
    }

    if (CGO.STATE.initialPruneNoticeTimer) {
      clearTimeout(CGO.STATE.initialPruneNoticeTimer);
    }

    CGO.STATE.initialPruneNoticeScheduled = true;
    CGO.STATE.initialPruneNoticeTimer = setTimeout(() => {
      CGO.STATE.initialPruneNoticeTimer = null;

      runWhenIdle(() => {
        const result = ensureInitialPruneNotice();
        CGO.STATE.initialPruneNoticeScheduled = false;

        if (result === "retry") {
          const retryCount = Number(CGO.STATE.initialPruneNoticeRetryCount || 0) + 1;
          CGO.STATE.initialPruneNoticeRetryCount = retryCount;

          if (retryCount < INITIAL_PRUNE_NOTICE_MAX_RETRIES) {
            scheduleInitialPruneNotice(INITIAL_PRUNE_NOTICE_RETRY_DELAY_MS);
          }
          return;
        }

        CGO.STATE.initialPruneNoticeRetryCount = 0;
      }, 1000);
    }, Math.max(0, Number(delayMs) || 0));
  }

  /**
   * Remove the oldest visible turns once the DOM exceeds the configured retention budget.
   */
  function trimOldDomTurns() {
    const nodes = getTurnBlocks();
    const removeCount = nodes.length - CGO.SETTINGS.keepDomMessages;
    if (removeCount <= 0 || !nodes.length) return;

    const keepCount = Math.max(1, CGO.SETTINGS.keepDomMessages);
    const tailStartIndex = Math.max(0, nodes.length - keepCount);
    const removedNodes = nodes.slice(0, tailStartIndex);
    const preservedTailFirst = nodes[tailStartIndex] || null;

    for (const node of removedNodes) {
      node.remove();
    }

    if (preservedTailFirst && removedNodes.length > 0) {
      CGO.STATE.domTrimState.omittedCount =
        Number(CGO.STATE.domTrimState?.omittedCount || 0) + removedNodes.length;

      CGO.STATE.domTrimState.firstKeptId =
        getTurnMessageId(preservedTailFirst) || CGO.STATE.domTrimState.firstKeptId || "";

      const notice = document.getElementById("cgo-dom-trim-notice");
      const textEl = notice?.querySelector(".cgo-dom-trim-notice-text");

      if (textEl) {
        textEl.textContent = CGO.t(
          "dom_trim_omitted_notice",
          String(CGO.STATE.domTrimState.omittedCount)
        );
      } else {
        scheduleInitialPruneNotice(0);
      }
    }

    CGO.log("DOM trim", {
      total: nodes.length,
      removed: removedNodes.length,
      kept: CGO.SETTINGS.keepDomMessages,
      omittedCount: CGO.STATE.domTrimState.omittedCount,
      firstKeptId: CGO.STATE.domTrimState.firstKeptId,
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
    if (CGO.STATE.domTrimTimer) {
      clearTimeout(CGO.STATE.domTrimTimer);
    }

    const ticket = (CGO.STATE.domTrimTicket || 0) + 1;
    CGO.STATE.domTrimTicket = ticket;

    CGO.STATE.domTrimTimer = setTimeout(() => {
      CGO.STATE.domTrimTimer = null;

      runWhenIdle(() => {
        if (CGO.STATE.domTrimTicket !== ticket) return;

        trimOldDomTurns();
      }, 2000);
    }, delayMs);
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

    if (data.type === "conversationHeadMeta") {
      CGO.STATE.conversationHeadMeta = {
        conversationId: data.conversationId || "",
        firstMessageId: data.meta?.firstMessageId || "",
        firstMessage: data.meta?.firstMessage || null,
      };
      return;
    }

    if (data.type === "initialPruneMeta") {
      resetInitialPruneNoticeState();
      CGO.STATE.domTrimState = {
        omittedCount: Number(data.meta?.omittedCount || 0),
        firstKeptId: data.meta?.firstKeptId || "",
      };

      scheduleInitialPruneNotice(0);
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
      scheduleDomTrim();
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

  CGO.observeWindowMessages = observeWindowMessages;
  CGO.ensureInitialPruneNotice = ensureInitialPruneNotice;
  CGO.resetInitialPruneNoticeState = resetInitialPruneNoticeState;
})();
