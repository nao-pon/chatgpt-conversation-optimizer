(() => {
  if (globalThis.__CGO_SKIP__) return;
  const CGO = (globalThis.__CGO ||= {});
  const INITIAL_PRUNE_NOTICE_DEBOUNCE_MS = 120;
  const INITIAL_PRUNE_NOTICE_RETRY_DELAY_MS = 250;
  const INITIAL_PRUNE_NOTICE_MAX_RETRIES = 40;
  const FIXED_TRIM_SUMMARY_ID = "cgo-dom-fixed-trim-summary";
  const FIXED_TRIM_SUMMARY_VISIBLE_SCROLL_Y = 80;
  const FIXED_TRIM_SUMMARY_INITIAL_SUPPRESS_MS = 1500;
  const ENABLE_VOICE_EXPORT_GUARD = false;
  const VOICE_SYNC_RETRY_DELAYS_MS = [500, 1000, 2000, 4000];

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
   * locating message marker elements and climbing to a reasonable block parent.
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
      '[data-testid^="conversation-turn-"]',
      "article[data-turn-id]",
      "section[data-turn-id]",
      "div[data-turn-id]",
      'div[class*="group/conversation-turn"]',
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

    const messageNodes = Array.from(root.querySelectorAll("[data-message-id], [data-message-author-role]"))
      .filter((node) => node && node.isConnected);

    if (!messageNodes.length) {
      CGO.log("[dom] getTurnBlocks: no message marker nodes found");
      //return [];
    }

    const blocks = [];
    const seen = new Set();

    for (const node of messageNodes) {
      const block =
        node.closest('[data-testid^="conversation-turn-"]') ||
        node.closest('[data-turn-id]') ||
        node.closest('div[class*="group/conversation-turn"]') ||
        node.closest("article") ||
        node.closest("section") ||
        node.closest("div");

      if (!block || !block.isConnected || seen.has(block)) continue;

      seen.add(block);
      blocks.push(block);
    }

    CGO.log("[dom] getTurnBlocks: fallback via message markers", {
      markerNodeCount: messageNodes.length,
      blockCount: blocks.length,
    });

    return blocks;
  }

  /**
   * Remove the custom omission notice inserted between the preserved first turn and newer turns.
   */
  function removeTrimNotice() {
    const notice = document.getElementById("cgo-dom-trim-notice");
    const button = notice?.querySelector("[data-cgo-export-button-key='trim_notice_lightweight']") || null;
    CGO.unregisterExportButton?.("trim_notice_lightweight", button);
    notice?.remove();
    removeEmptyFixedTrimSummary();
  }

  /**
   * Remove the synthetic first-message card injected for initial pruned renders.
   */
  function removeInitialMessageCard() {
    document.getElementById("cgo-dom-initial-message")?.remove();
    removeEmptyFixedTrimSummary();
  }

  /**
   * Remove the fixed trim summary wrapper when it has no remaining content.
   */
  function removeEmptyFixedTrimSummary() {
    const summary = document.getElementById(FIXED_TRIM_SUMMARY_ID);
    if (summary && !summary.children.length) {
      summary.remove();
    }
  }

  /**
   * Return the largest known vertical scroll offset for the current ChatGPT viewport.
   *
   * @param {Event} [event] - Optional scroll event carrying an internal scroll target.
   * @returns {number} Best-effort vertical scroll offset.
   */
  function getCurrentScrollOffset(event) {
    const target = event?.target;
    const scrollRoot = getChatGptScrollRoot();
    const targetScrollTop =
      target && target !== document && target !== window
        ? Number(target.scrollTop || 0)
        : 0;
    const scrollRootScrollTop = scrollRoot
      ? Number(scrollRoot.scrollTop || 0)
      : 0;

    return Math.max(
      targetScrollTop,
      scrollRootScrollTop,
      Number(window.scrollY || 0),
      Number(window.pageYOffset || 0),
      Number(document.scrollingElement?.scrollTop || 0),
      Number(document.documentElement?.scrollTop || 0),
      Number(document.body?.scrollTop || 0),
      getLargestElementScrollTop()
    );
  }

  /**
   * Return ChatGPT's current internal scroll container when present.
   *
   * @returns {?HTMLElement} Scroll root element.
   */
  function getChatGptScrollRoot() {
    const node = document.querySelector("[data-scroll-root]");
    return node instanceof HTMLElement ? node : null;
  }

  /**
   * Return the largest scrollTop from visible scroll containers in ChatGPT's nested layout.
   *
   * @returns {number} Largest element-level scroll offset.
   */
  function getLargestElementScrollTop() {
    let largest = 0;
    const nodes = Array.from(document.querySelectorAll("[data-scroll-root], main, main *"));

    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;

      const scrollTop = Number(node.scrollTop || 0);
      if (scrollTop <= largest) continue;
      if (node.scrollHeight <= node.clientHeight + 80) continue;

      largest = scrollTop;
    }

    return largest;
  }

  /**
   * Show the fixed trim summary only while the user is near the top of the conversation.
   */
  function updateFixedTrimSummaryVisibility() {
    const summary = document.getElementById(FIXED_TRIM_SUMMARY_ID);
    if (!summary) return;

    if (isFixedTrimSummaryInitiallySuppressed()) {
      summary.hidden = true;
      scheduleFixedTrimSummaryAfterSuppress();
      return;
    }

    const hasTrim = Number(CGO.STATE.domTrimState?.omittedCount || 0) > 0;
    const onConversationRoute = !!CGO.getConversationIdFromLocation?.();
    const nearTop =
      Number(CGO.STATE.fixedTrimSummaryScrollY || 0) <=
      FIXED_TRIM_SUMMARY_VISIBLE_SCROLL_Y;

    summary.hidden = !(hasTrim && onConversationRoute && nearTop);
  }

  /**
   * Align the fixed trim summary with the visible conversation content column.
   */
  function updateFixedTrimSummaryLayout() {
    const summary = document.getElementById(FIXED_TRIM_SUMMARY_ID);
    if (!summary) return;

    const rect = getConversationContentColumnRect();

    if (!rect) {
      summary.style.removeProperty("--cgo-fixed-trim-left");
      summary.style.removeProperty("--cgo-fixed-trim-width");
      summary.style.removeProperty("--cgo-fixed-trim-transform");
      return;
    }

    const left = Math.max(10, Math.round(rect.left));
    const width = Math.min(
      Math.round(rect.width),
      Math.max(280, window.innerWidth - left - 10)
    );

    summary.style.setProperty("--cgo-fixed-trim-left", `${left}px`);
    summary.style.setProperty("--cgo-fixed-trim-width", `${width}px`);
    summary.style.setProperty("--cgo-fixed-trim-transform", "none");
  }

  /**
   * Find a visible message-content column rect rather than the full-width turn wrapper.
   *
   * @returns {?DOMRect} Best-effort content column rect.
   */
  function getConversationContentColumnRect() {
    const root = getConversationRoot();
    if (!root) return null;

    const selectors = [
      "[data-conversation-screenshot-content]",
      ".markdown",
      '[data-message-author-role="assistant"] .markdown',
      '[data-message-author-role="assistant"]',
      "[data-message-id] .markdown",
      "[data-message-id]",
      "pre",
    ];
    const viewportWidth = window.innerWidth || 0;
    const maxColumnWidth = Math.min(1100, Math.max(320, viewportWidth - 40));
    const candidates = [];

    for (const selector of selectors) {
      for (const node of root.querySelectorAll(selector)) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.closest(`#${FIXED_TRIM_SUMMARY_ID}`)) continue;
        if (!node.offsetParent && node.getClientRects().length === 0) continue;

        const rect = node.getBoundingClientRect();
        if (rect.width < 360 || rect.width > maxColumnWidth) continue;
        if (rect.height < 12) continue;
        if (rect.right < 0 || rect.left > viewportWidth) continue;

        candidates.push(rect);
      }
    }

    if (candidates.length) {
      return candidates
        .sort((a, b) => {
          const aVisible = a.bottom >= 0 && a.top <= window.innerHeight;
          const bVisible = b.bottom >= 0 && b.top <= window.innerHeight;
          if (aVisible !== bVisible) return aVisible ? -1 : 1;
          return b.width - a.width;
        })[0];
    }

    const width = Math.min(960, Math.max(320, viewportWidth - 32));
    const left = Math.max(10, Math.round((viewportWidth - width) / 2));
    return {
      left,
      width,
    };
  }

  /**
   * Schedule a single fixed-summary visibility update for the next animation frame.
   *
   * @param {Event} [event] - Scroll event used to read internal scroll offsets.
   */
  function scheduleFixedTrimSummaryVisibilityUpdate(event) {
    CGO.STATE.fixedTrimSummaryScrollY = getCurrentScrollOffset(event);
    if (CGO.STATE.fixedTrimSummaryRaf) return;

    const requestFrame =
      window.requestAnimationFrame ||
      ((callback) => window.setTimeout(callback, 16));

    CGO.STATE.fixedTrimSummaryRaf = requestFrame(() => {
      CGO.STATE.fixedTrimSummaryRaf = 0;
      updateFixedTrimSummaryLayout();
      updateFixedTrimSummaryVisibility();
    });
  }

  /**
   * Hide the fixed summary briefly while ChatGPT restores its internal scroll position.
   */
  function suppressFixedTrimSummaryInitialFlash() {
    const now = getNowMs();
    const until = now + FIXED_TRIM_SUMMARY_INITIAL_SUPPRESS_MS;
    CGO.STATE.fixedTrimSummarySuppressUntil = Math.max(
      Number(CGO.STATE.fixedTrimSummarySuppressUntil || 0),
      until
    );
  }

  /**
   * Return true while the fixed summary is inside the initial load suppression window.
   *
   * @returns {boolean} Whether visibility should be suppressed.
   */
  function isFixedTrimSummaryInitiallySuppressed() {
    return getNowMs() < Number(CGO.STATE.fixedTrimSummarySuppressUntil || 0);
  }

  /**
   * Re-run visibility once the initial load suppression window expires.
   */
  function scheduleFixedTrimSummaryAfterSuppress() {
    if (CGO.STATE.fixedTrimSummarySuppressTimer) return;

    const remaining =
      Number(CGO.STATE.fixedTrimSummarySuppressUntil || 0) - getNowMs();
    if (remaining <= 0) return;

    CGO.STATE.fixedTrimSummarySuppressTimer = setTimeout(() => {
      CGO.STATE.fixedTrimSummarySuppressTimer = null;
      scheduleFixedTrimSummaryVisibilityUpdate();
    }, Math.max(0, remaining + 20));
  }

  /**
   * Return a monotonic-ish timestamp for short UI timing windows.
   *
   * @returns {number} Current timestamp in milliseconds.
   */
  function getNowMs() {
    return typeof performance !== "undefined" && performance.now
      ? performance.now()
      : Date.now();
  }

  /**
   * Attach a scroll listener to ChatGPT's nested scroll root, which can change on SPA navigation.
   */
  function observeCurrentChatGptScrollRoot() {
    const scrollRoot = getChatGptScrollRoot();
    if (!scrollRoot || CGO.STATE.fixedTrimSummaryScrollRoot === scrollRoot) {
      return;
    }

    CGO.STATE.fixedTrimSummaryScrollRoot = scrollRoot;
    CGO.STATE.fixedTrimSummaryScrollRoots ||= new WeakSet();
    if (!CGO.STATE.fixedTrimSummaryScrollRoots.has(scrollRoot)) {
      CGO.STATE.fixedTrimSummaryScrollRoots.add(scrollRoot);
      scrollRoot.addEventListener("scroll", scheduleFixedTrimSummaryVisibilityUpdate, {
        passive: true,
      });
    }
    CGO.STATE.fixedTrimSummaryScrollY = getCurrentScrollOffset();
  }

  /**
   * Install scroll listeners used by the fixed trim summary.
   */
  function ensureFixedTrimSummaryScrollObserver() {
    if (CGO.STATE.fixedTrimSummaryScrollObserverStarted) return;

    CGO.STATE.fixedTrimSummaryScrollObserverStarted = true;
    CGO.STATE.fixedTrimSummaryScrollY = getCurrentScrollOffset();
    observeCurrentChatGptScrollRoot();

    window.addEventListener("scroll", scheduleFixedTrimSummaryVisibilityUpdate, {
      capture: true,
      passive: true,
    });
    document.addEventListener("scroll", scheduleFixedTrimSummaryVisibilityUpdate, {
      capture: true,
      passive: true,
    });
    window.addEventListener("resize", scheduleFixedTrimSummaryVisibilityUpdate, {
      passive: true,
    });

    if (document.body && typeof MutationObserver === "function") {
      const observer = new MutationObserver(() => {
        observeCurrentChatGptScrollRoot();
        scheduleFixedTrimSummaryVisibilityUpdate();
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
      CGO.STATE.fixedTrimSummaryLayoutObserver = observer;
    }
  }

  /**
   * Ensure the body-level fixed trim summary wrapper exists.
   *
   * @returns {?HTMLDivElement} Fixed summary wrapper.
   */
  function ensureFixedTrimSummary() {
    if (!document.body) return null;

    let summary = document.getElementById(FIXED_TRIM_SUMMARY_ID);
    if (summary) return summary;

    summary = document.createElement("div");
    summary.id = FIXED_TRIM_SUMMARY_ID;
    summary.className = "cgo-dom-fixed-trim-summary";
    summary.hidden = true;
    document.body.appendChild(summary);
    suppressFixedTrimSummaryInitialFlash();
    ensureFixedTrimSummaryScrollObserver();
    return summary;
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
    if (CGO.STATE.fixedTrimSummarySuppressTimer) {
      clearTimeout(CGO.STATE.fixedTrimSummarySuppressTimer);
    }

    CGO.STATE.initialPruneNoticeTimer = null;
    CGO.STATE.initialPruneNoticeScheduled = false;
    CGO.STATE.initialPruneNoticeRetryCount = 0;
    CGO.STATE.fixedTrimSummarySuppressTimer = null;

    if (clearMeta) {
      CGO.STATE.fixedTrimSummarySuppressUntil = getNowMs() + FIXED_TRIM_SUMMARY_INITIAL_SUPPRESS_MS;
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
   * Cancel a scheduled DOM trim and invalidate any idle callback that was already queued.
   */
  function cancelPendingDomTrim() {
    if (CGO.STATE.domTrimTimer) {
      clearTimeout(CGO.STATE.domTrimTimer);
      CGO.STATE.domTrimTimer = null;
    }
    CGO.STATE.domTrimTicket = Number(CGO.STATE.domTrimTicket || 0) + 1;
  }

  /**
   * Return whether the active conversation uses ChatGPT's server-side paginated history.
   *
   * @returns {boolean} `true` when CGO must not remove conversation DOM nodes.
   */
  function isPaginatedHistoryActive() {
    return CGO.STATE.activeConversationHistoryMode === "paginated";
  }

  /**
   * Return whether legacy DOM pruning is explicitly enabled for the active conversation.
   *
   * Unknown mode remains non-destructive until the transport has been identified.
   *
   * @returns {boolean} `true` only for the legacy full-conversation API.
   */
  function isDomPruningEnabled() {
    return CGO.STATE.activeConversationHistoryMode === "legacy";
  }

  /**
   * Record the active conversation transport mode and apply its DOM-pruning policy.
   *
   * @param {"unknown"|"legacy"|"paginated"} mode - Detected history transport mode.
   * @param {string} [conversationId=""] - Conversation associated with the detection.
   * @returns {boolean} Whether the mode was accepted for the current route.
   */
  function setActiveConversationHistoryMode(mode, conversationId = "") {
    const normalizedMode =
      mode === "paginated" || mode === "legacy" ? mode : "unknown";
    const currentConversationId = CGO.getConversationIdFromLocation?.() || "";
    if (
      conversationId &&
      currentConversationId &&
      conversationId !== currentConversationId
    ) {
      return false;
    }

    const changed =
      CGO.STATE.activeConversationHistoryMode !== normalizedMode ||
      CGO.STATE.activeConversationHistoryModeConversationId !== conversationId;
    CGO.STATE.activeConversationHistoryMode = normalizedMode;
    CGO.STATE.activeConversationHistoryModeConversationId =
      conversationId || currentConversationId || "";

    if (normalizedMode !== "legacy") {
      cancelPendingDomTrim();
    }
    if (normalizedMode === "paginated") {
      resetInitialPruneNoticeState(true);
    }

    if (changed) {
      const panel = document.getElementById("cgo-settings-panel");
      if (panel && typeof panel.__cgoSyncFromSettings === "function") {
        void panel.__cgoSyncFromSettings();
      }
    }

    return true;
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
    button.title = button.textContent;
    button.setAttribute("aria-label", button.textContent);
    button.dataset.baseTitle = button.textContent;
    button.dataset.cgoExportKind = "lightweight";
    button.dataset.cgoExportButtonKey = "trim_notice_lightweight";
    CGO.registerExportButton?.("trim_notice_lightweight", button);
    CGO.applyVoiceExportGuardToButton?.(button);

    button.addEventListener("click", async () => {
      if (typeof CGO.exportCurrentConversationAsHtml !== "function") return;

      try {
        button.disabled = true;
        await CGO.exportCurrentConversationAsHtml(button, anchorMessageId || CGO.getCurrentVisibleMessageId?.() || "");
      } catch (error) {
        CGO.log("[warn] lightweight viewer from trim notice failed", String(error));
      } finally {
        button.disabled = false;
        button.setAttribute("aria-disabled", "false");
        CGO.applyVoiceExportGuardToButton?.(button);
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
   * Build the inline voice-transcription badge HTML for the lightweight initial message card.
   *
   * @param {{isVoiceTranscription?: boolean}} message - Initial message payload.
   * @returns {string} Badge HTML string or an empty string.
   */
  function getVoiceTranscriptionBadgeHtml(message) {
    if (!message?.isVoiceTranscription) return "";

    const label = escapeHtml(CGO.t("voice_transcription_label"));
    return `
      <span
        class="cgo-dom-voice-badge"
        role="img"
        aria-label="${label}"
        title="${label}"
        style="display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:999px;border:1px solid rgba(148,163,184,0.22);background:rgba(255,255,255,0.08);color:rgba(226,232,240,0.92);flex:0 0 auto;"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true" style="display:block;width:11px;height:11px;">
          <path d="M12 4.75a2.75 2.75 0 0 0-2.75 2.75v4.9a2.75 2.75 0 0 0 5.5 0V7.5A2.75 2.75 0 0 0 12 4.75Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></path>
          <path d="M7.75 11.9a4.25 4.25 0 0 0 8.5 0M12 16.15v3.1M9.35 19.25h5.3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></path>
        </svg>
      </span>`;
  }

  /**
   * Build a lightweight DOM card for the original first message kept outside the pruned data payload.
   *
   * @param {{role?: string, text?: string, createTime?: number|null, isVoiceTranscription?: boolean}} message - Initial message payload.
   * @returns {HTMLDivElement} Render-ready card element.
   */
  function createInitialMessageCard(message) {
    const role = String(message?.role || "user");
    const roleLabel = role === "assistant" ? CGO.t("role_assistant") : CGO.t("role_user");
    const dateText = formatCreateTime(message?.createTime);
    const text = escapeHtml(String(message?.renderText || message?.text || ""));
    const voiceBadge = getVoiceTranscriptionBadgeHtml(message);

    const card = document.createElement("div");
    card.id = "cgo-dom-initial-message";
    card.className = `cgo-dom-initial-message cgo-dom-initial-message-${role}`;
    card.innerHTML = `
      <div class="cgo-dom-initial-message-header">
        <span class="cgo-dom-initial-message-role">${escapeHtml(roleLabel)}</span>
        ${voiceBadge}
        <span class="cgo-dom-initial-message-date">${escapeHtml(dateText)}</span>
      </div>
      <div class="cgo-dom-initial-message-body">${text.replace(/\n/g, "<br>")}</div>
    `;

    return card;
  }

  /**
   * Render the fixed omission summary for the initial pruned response as soon as metadata is available.
   *
   * @returns {"done"|"retry"} `retry` when the DOM is not ready yet.
   */
  function ensureInitialPruneNotice() {
    const head = CGO.STATE.conversationHeadMeta;
    const trim = CGO.STATE.domTrimState;

    if (!trim || Number(trim.omittedCount || 0) <= 0) return "done";

    const conversationId = CGO.getConversationIdFromLocation?.() || "";
    if (head?.conversationId && conversationId && head.conversationId !== conversationId) {
      return "done";
    }

    const firstKeptId = String(trim.firstKeptId || "");

    removeTrimNotice();

    let summary = null;
    if (head?.firstMessage) {
      removeInitialMessageCard();
      summary = ensureFixedTrimSummary();
      if (!summary) return "retry";
      summary.appendChild(createInitialMessageCard(head.firstMessage));
    } else {
      removeInitialMessageCard();
    }

    summary = summary || ensureFixedTrimSummary();
    if (!summary) return "retry";

    const notice = createTrimNotice(Number(trim.omittedCount || 0), firstKeptId);
    summary.appendChild(notice);
    CGO.STATE.fixedTrimSummaryScrollY = getCurrentScrollOffset();
    updateFixedTrimSummaryLayout();
    updateFixedTrimSummaryVisibility();
    return "done";
  }

  /**
   * Ask the injected page hook to restore trim metadata for a cached conversation after SPA navigation.
   *
   * @param {string} conversationId - Conversation id to restore.
   */
  function requestInitialPruneMetaFromPageHook(conversationId) {
    if (!conversationId) return;

    window.postMessage(
      {
        type: "CGO_TRIM_META_REQUEST",
        conversationId,
        secret: window.__CGO_BRIDGE_SECRET__ || "",
      },
      "*"
    );
  }

  /**
   * Debounce and retry initial-prune notice rendering until the document body is available.
   *
   * @param {number} [delayMs=INITIAL_PRUNE_NOTICE_DEBOUNCE_MS] - Delay before the next attempt.
   */
  function scheduleInitialPruneNotice(delayMs = INITIAL_PRUNE_NOTICE_DEBOUNCE_MS) {
    const trim = CGO.STATE.domTrimState;

    if (!trim || Number(trim.omittedCount || 0) <= 0) {
      resetInitialPruneNoticeState();
      return;
    }

    if (CGO.STATE.initialPruneNoticeTimer) {
      clearTimeout(CGO.STATE.initialPruneNoticeTimer);
    }

    CGO.STATE.initialPruneNoticeScheduled = true;
    CGO.STATE.initialPruneNoticeTimer = setTimeout(() => {
      CGO.STATE.initialPruneNoticeTimer = null;

      runOnNextFrame(() => {
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
      });
    }, Math.max(0, Number(delayMs) || 0));
  }

  /**
   * Run a callback on the next animation frame, falling back to a zero-delay timer.
   *
   * @param {Function} fn - Callback to run soon.
   */
  function runOnNextFrame(fn) {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(fn);
      return;
    }
    setTimeout(fn, 0);
  }

  /**
   * Remove the oldest visible turns once the DOM exceeds the configured retention budget.
   */
  function trimOldDomTurns() {
    if (!isDomPruningEnabled()) {
      CGO.log("[dom] trim skipped outside legacy history mode");
      return;
    }

    const nodes = getTurnBlocks();
    const keepDomMessages = CGO.getActiveKeepDomMessages?.() || CGO.SETTINGS.keepDomMessages;
    const removeCount = nodes.length - keepDomMessages;
    if (removeCount <= 0 || !nodes.length) return;

    const keepCount = Math.max(1, keepDomMessages);
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
      kept: keepDomMessages,
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
    if (!isDomPruningEnabled()) {
      cancelPendingDomTrim();
      return;
    }

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
   * Clear any pending retry timer used by the voice export guard.
   */
  function clearVoiceSyncRetryTimer() {
    const guard = CGO.STATE.voiceExportGuard;
    if (guard?.syncRetryTimer) {
      clearTimeout(guard.syncRetryTimer);
    }
    guard.syncRetryTimer = null;
  }

  /**
   * Return the most useful conversation id for the voice export guard.
   *
   * @param {string} [conversationId=""] - Optional conversation id from a runtime event.
   * @returns {string} Resolved conversation id, or an empty string when unavailable.
   */
  function resolveVoiceGuardConversationId(conversationId = "") {
    return (
      conversationId ||
      CGO.STATE.voiceExportGuard?.conversationId ||
      CGO.getConversationIdFromLocation?.() ||
      ""
    );
  }

  /**
   * Check whether a voice-session event belongs to the active route before locking this page.
   *
   * @param {string} [conversationId=""] - Conversation id carried by the event.
   * @returns {boolean} `true` when the event can safely affect the current toolbar.
   */
  function isVoiceGuardEventForCurrentRoute(conversationId = "") {
    const currentConversationId = CGO.getConversationIdFromLocation?.() || "";
    return !conversationId || !currentConversationId || conversationId === currentConversationId;
  }

  /**
   * Check whether a cached conversation payload is valid enough to unlock export after voice sync.
   *
   * @param {*} data - Cached conversation candidate.
   * @returns {boolean} `true` when the cache looks usable for export.
   */
  function isValidExportCache(data) {
    return !!(
      data &&
      typeof data === "object" &&
      data.mapping &&
      typeof data.mapping === "object" &&
      Object.keys(data.mapping).length > 0
    );
  }

  /**
   * Move the voice export guard into a new state and apply the matching button lock UI.
   *
   * @param {"normal"|"voice_active"|"voice_syncing"} state - Next guard state.
   * @param {string} [conversationId=""] - Best-effort conversation id associated with the state.
   * @param {string} [reason=""] - Optional user-facing lock reason.
   */
  function setVoiceExportGuardState(state, conversationId = "", reason = "") {
    const guard = CGO.STATE.voiceExportGuard;
    const resolvedConversationId =
      state === "normal"
        ? ""
        : resolveVoiceGuardConversationId(conversationId);
    const resolvedReason =
      reason ||
      (state === "voice_active"
        ? CGO.t("voice_export_guard_active")
        : state === "voice_syncing"
          ? CGO.t("voice_export_guard_syncing")
          : "");

    if (
      guard.state === state &&
      guard.conversationId === resolvedConversationId &&
      guard.reason === resolvedReason
    ) {
      CGO.setExportButtonsLocked?.(state !== "normal", resolvedReason);
      return;
    }

    if (state === "normal") {
      clearVoiceSyncRetryTimer();
      guard.syncRetryCount = 0;
      guard.syncCheckInFlight = false;
    }

    guard.state = state;
    guard.conversationId = resolvedConversationId;
    guard.reason = resolvedReason;
    guard.lastChangedAt = Date.now();

    CGO.setExportButtonsLocked?.(state !== "normal", resolvedReason);
  }

  /**
   * Decide whether a sync-complete notification should trigger an export-cache unlock check.
   *
   * @param {string} [conversationId=""] - Conversation id inferred from the incoming runtime message.
   * @returns {boolean} `true` when the notification matches the guarded conversation.
   */
  function shouldTryUnlockForConversation(conversationId = "") {
    const guard = CGO.STATE.voiceExportGuard;
    if (guard.state !== "voice_syncing") return false;

    const currentConversationId = CGO.getConversationIdFromLocation?.() || "";
    const targetConversationId =
      conversationId ||
      guard.conversationId ||
      currentConversationId;

    if (!targetConversationId) return false;
    if (guard.conversationId && guard.conversationId !== targetConversationId) return false;
    if (currentConversationId && currentConversationId !== targetConversationId) return false;
    return true;
  }

  /**
   * Retry export-cache validation after voice chat closes until the normal conversation sync becomes available.
   *
   * @param {string} [conversationId=""] - Conversation id to validate against the page cache.
   * @param {number} [delayMs=0] - Delay before the next cache lookup.
   */
  function scheduleVoiceSyncCheck(conversationId = "", delayMs = 0) {
    const guard = CGO.STATE.voiceExportGuard;
    if (guard.state !== "voice_syncing") return;

    clearVoiceSyncRetryTimer();
    guard.syncRetryTimer = setTimeout(() => {
      guard.syncRetryTimer = null;
      void tryUnlockExportAfterVoiceSync(conversationId);
    }, Math.max(0, Number(delayMs) || 0));
  }

  /**
   * Attempt to unlock export after a voice session by verifying that a normal export cache is now available.
   *
   * @param {string} [conversationId=""] - Conversation id to fetch from the page cache.
   * @returns {Promise<boolean>} `true` when export was unlocked.
   */
  async function tryUnlockExportAfterVoiceSync(conversationId = "") {
    const guard = CGO.STATE.voiceExportGuard;
    if (guard.state !== "voice_syncing" || guard.syncCheckInFlight) return false;

    const targetConversationId = resolveVoiceGuardConversationId(conversationId);
    if (!targetConversationId) return false;

    guard.syncCheckInFlight = true;
    try {
      const cached = await CGO.getConversationFromCache?.(targetConversationId);
      if (isValidExportCache(cached)) {
        setVoiceExportGuardState("normal", targetConversationId, "");
        return true;
      }
    } catch (error) {
      CGO.log("[voiceExportGuard] cache check failed", String(error));
    } finally {
      guard.syncCheckInFlight = false;
    }

    const retryIndex = Number(guard.syncRetryCount || 0);
    const retryDelay = VOICE_SYNC_RETRY_DELAYS_MS[retryIndex] ?? 0;
    guard.syncRetryCount = retryIndex + 1;

    if (retryDelay > 0) {
      scheduleVoiceSyncCheck(targetConversationId, retryDelay);
    } else {
      const lockReason = CGO.t("voice_export_guard_still_syncing");
      CGO.setExportButtonsLocked?.(true, lockReason);
      guard.reason = lockReason;
    }

    return false;
  }

  /**
   * Reset or preserve the voice export guard when the active conversation route changes.
   *
   * @param {string} [conversationId=""] - New route conversation id.
   */
  function handleConversationRouteChanged(conversationId = "") {
    const guard = CGO.STATE.voiceExportGuard;
    const nextConversationId = conversationId || CGO.getConversationIdFromLocation?.() || "";

    if (
      guard.state !== "normal" &&
      guard.conversationId &&
      nextConversationId &&
      guard.conversationId === nextConversationId
    ) {
      CGO.setExportButtonsLocked?.(true, guard.reason || "");
      return;
    }

    setVoiceExportGuardState("normal", "", "");
  }

  /**
   * Handle messages emitted by the injected page runtime and update extension UI state.
   *
   * @param {Object} data - Runtime payload posted on `window`.
   */
  function handleRuntimeMessage(data) {
    if (data.type === "voiceSessionState") {
      if (!ENABLE_VOICE_EXPORT_GUARD) {
        setVoiceExportGuardState("normal", "", "");
        return;
      }

      const eventConversationId = data.conversationId || "";
      if (!isVoiceGuardEventForCurrentRoute(eventConversationId)) {
        return;
      }

      const conversationId = resolveVoiceGuardConversationId(eventConversationId);

      if (data.state === "active") {
        setVoiceExportGuardState("voice_active", conversationId, CGO.t("voice_export_guard_active"));
        return;
      }

      if (data.state === "syncing") {
        setVoiceExportGuardState("voice_syncing", conversationId, CGO.t("voice_export_guard_syncing"));
        if (conversationId) {
          scheduleVoiceSyncCheck(conversationId, 10000);
        }
        return;
      }

      if (data.state === "idle") {
        setVoiceExportGuardState("normal", "", "");
        return;
      }
    }

    if (data.type === "autoAdjustResult") {
      const conversationId = data.conversationId || CGO.getConversationIdFromLocation?.() || "";
      const projectName = data.projectName || "";
      const stats = data.stats || null;
      const level = CGO.getProjectGuideLevel(stats);
      const effective = Number(data.effectiveKeepDomMessages || 0);
      const historyMode = data.historyMode === "paginated" ? "paginated" : "legacy";

      setActiveConversationHistoryMode(historyMode, conversationId);
      const domPruningEnabled = isDomPruningEnabled();

      CGO.log("[autoAdjustResult]", data);

      if (domPruningEnabled && CGO.SETTINGS.autoAdjustEnabled && effective > 0) {
        const previousEffective = CGO.getActiveKeepDomMessages?.() || CGO.SETTINGS.keepDomMessages;
        CGO.STATE.effectiveKeepDomMessages = CGO.clampKeepDomMessages(effective);

        if (CGO.STATE.effectiveKeepDomMessages < previousEffective) {
          scheduleDomTrim(0);
        }
      } else {
        CGO.STATE.effectiveKeepDomMessages = CGO.SETTINGS.keepDomMessages;
      }

      CGO.STATE.projectGuide = {
        conversationId,
        projectName,
        stats,
        level,
      };

      void CGO.updateProjectGuideVisibility?.();
      void CGO.updateProjectGuideAlertVisibility?.();
      const panel = document.getElementById("cgo-settings-panel");
      if (panel && typeof panel.__cgoSyncFromSettings === "function") {
        void panel.__cgoSyncFromSettings();
      }

      if (shouldTryUnlockForConversation(conversationId)) {
        scheduleVoiceSyncCheck(conversationId, 0);
      }

      return;
    }

    if (data.type === "conversationHeadMeta") {
      if (isPaginatedHistoryActive()) return;

      CGO.STATE.conversationHeadMeta = {
        conversationId: data.conversationId || "",
        firstMessageId: data.meta?.firstMessageId || "",
        firstMessage: data.meta?.firstMessage || null,
      };
      if (Number(CGO.STATE.domTrimState?.omittedCount || 0) > 0) {
        scheduleInitialPruneNotice(0);
      }
      return;
    }

    if (data.type === "initialPruneMeta") {
      if (isPaginatedHistoryActive()) return;

      resetInitialPruneNoticeState();
      CGO.STATE.domTrimState = {
        omittedCount: Number(data.meta?.omittedCount || 0),
        firstKeptId: data.meta?.firstKeptId || "",
      };

      scheduleInitialPruneNotice(0);
      return;
    }

    if (data.type === "analysis") {
      const conversationId =
        data.summary?.conversationId ||
        CGO.getConversationIdFromLocation?.() ||
        "";
      const historyMode = data.summary?.historyMode === "paginated"
        ? "paginated"
        : "legacy";
      setActiveConversationHistoryMode(historyMode, conversationId);

      CGO.updateExportButtonVisibility?.(true);
      if (CGO.CONFIG.debug) {
        console.group("[CGO prune analysis]");
        console.log("url:", data.url);
        console.log("summary:", data.summary);
        console.groupEnd();
      }

      if (shouldTryUnlockForConversation(conversationId)) {
        scheduleVoiceSyncCheck(conversationId, 0);
      }
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

  /**
   * Subscribe to bridge messages posted from the page hook and route them to the DOM handler.
   */
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
  CGO.handleConversationRouteChanged = handleConversationRouteChanged;
  CGO.isDomPruningEnabled = isDomPruningEnabled;
  CGO.isPaginatedHistoryActive = isPaginatedHistoryActive;
  CGO.requestInitialPruneMetaFromPageHook = requestInitialPruneMetaFromPageHook;
  CGO.resetInitialPruneNoticeState = resetInitialPruneNoticeState;
  CGO.scheduleDomTrim = scheduleDomTrim;
  CGO.setActiveConversationHistoryMode = setActiveConversationHistoryMode;
})();
