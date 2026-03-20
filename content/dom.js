(() => {
  const CGO = (globalThis.CGO = globalThis.CGO || {});

  let routeObserver = null;
  let streamObserver = null;
  let lastKnownUrl = location.href;

  function onDomReady(callback) {
    if (
      document.readyState === "interactive" ||
      document.readyState === "complete"
    ) {
      callback();
      return;
    }

    window.addEventListener("DOMContentLoaded", callback, { once: true });
  }

  function getConversationRoot() {
    return (
      document.querySelector("main") ||
      document.body
    );
  }

  function getTurnArticles() {
    return Array.from(
      document.querySelectorAll('section[data-turn-id], article[data-turn-id]')
    );
  }

  function getTurnArticlesForExport() {
    return getTurnArticles().filter((el) => {
      const turnId = el.getAttribute("data-turn-id");
      return !!turnId;
    });
  }

  function extractMessageIdFromTurn(turnEl) {
    if (!turnEl) return "";

    const direct = turnEl.getAttribute("data-turn-id");
    if (direct) return direct;

    const msgEl = turnEl.querySelector("[data-message-id]");
    if (msgEl) {
      return msgEl.getAttribute("data-message-id") || "";
    }

    return "";
  }

  function getTurnRoleFromDom(turnEl) {
    if (!turnEl) return "unknown";

    const explicit = turnEl.getAttribute("data-turn");
    if (explicit) return explicit;

    const msgEl = turnEl.querySelector("[data-message-author-role]");
    if (msgEl) {
      return msgEl.getAttribute("data-message-author-role") || "unknown";
    }

    return "unknown";
  }

  function guessFileNameFromUrl(url) {
    try {
      const u = new URL(url, location.origin);
      return u.pathname.split("/").pop() || "";
    } catch {
      return "";
    }
  }

  function extractImagesFromTurn(turnEl) {
    const byUrl = new Map();
    const imgNodes = turnEl.querySelectorAll("img");

    for (const img of imgNodes) {
      const url = img.currentSrc || img.src || "";
      if (!url) continue;

      const alt = (img.alt || "").trim();
      const width = Number(img.getAttribute("width") || img.naturalWidth || 0);
      const height = Number(img.getAttribute("height") || img.naturalHeight || 0);
      const fileId = CGO.extractFileIdFromEstuaryUrl
        ? CGO.extractFileIdFromEstuaryUrl(url)
        : "";

      const score =
        (alt ? 1000 : 0) +
        (width * height) +
        (img.id ? 10 : 0);

      const prev = byUrl.get(url);
      const candidate = CGO.normalizeImageMeta
        ? CGO.normalizeImageMeta({
          url,
          alt,
          width,
          height,
          fileId,
          fileName: guessFileNameFromUrl(url),
          source: "dom",
        })
        : {
          url,
          alt,
          width,
          height,
          fileId,
          fileName: guessFileNameFromUrl(url),
          source: "dom",
        };

      if (!prev || score > prev.score) {
        byUrl.set(url, { ...candidate, score });
      }
    }

    return Array.from(byUrl.values()).map(({ score, ...item }) => item);
  }

  function extractAttachmentsFromTurn(turnEl) {
    const attachments = [];
    const links = turnEl.querySelectorAll('a[href]');

    for (const link of links) {
      const href = link.getAttribute("href") || "";
      const text = (link.textContent || "").trim();
      if (!href) continue;

      const looksLikeAttachment =
        /\/backend-api\/files\//i.test(href) ||
        /\/sandbox\//i.test(href) ||
        /\.(zip|pdf|txt|json|csv|md|js|ts|py|docx?|xlsx?|pptx?)($|\?)/i.test(href);

      if (!looksLikeAttachment) continue;

      const name = text || guessFileNameFromUrl(href) || "file";
      const mimeType = "";
      const kind = CGO.guessAttachmentKind
        ? CGO.guessAttachmentKind(name, mimeType)
        : "file";

      attachments.push({
        fileId: "",
        name,
        mimeType,
        fileSizeBytes: 0,
        url: href,
        localPath: "",
        unresolved: false,
        kind,
        source: "dom-link",
        skipReason: "",
        isSandboxArtifact: /sandbox:/i.test(href),
      });
    }

    return attachments;
  }

  function buildDomAssetMap() {
    const turnEls = getTurnArticlesForExport();
    const byTurnId = new Map();

    for (const turnEl of turnEls) {
      const turnId = extractMessageIdFromTurn(turnEl);
      if (!turnId) continue;

      byTurnId.set(turnId, {
        turnId,
        role: getTurnRoleFromDom(turnEl),
        images: extractImagesFromTurn(turnEl),
        attachments: extractAttachmentsFromTurn(turnEl),
      });
    }

    return byTurnId;
  }

  function trimOldDomTurns() {
    const nodes = getTurnArticles();
    const keep = CGO.SETTINGS?.keepDomMessages ?? CGO.CONFIG.keepDomMessages;

    if (!nodes.length || nodes.length <= keep) return;

    const removeCount = nodes.length - keep;
    const removeTargets = nodes.slice(0, removeCount);

    for (const node of removeTargets) {
      node.remove();
    }

    CGO.log("DOM trim", {
      total: nodes.length,
      removed: removeCount,
      kept: keep,
    });
  }

  function runWhenIdle(fn, timeout = 500) {
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(() => fn(), { timeout });
      return;
    }

    window.setTimeout(fn, 0);
  }

  function scheduleDomTrim() {
    if (CGO.STATE.trimScheduled) return;
    CGO.STATE.trimScheduled = true;

    const delay = CGO.CONFIG?.domTrimDelayMs ?? 1200;

    window.setTimeout(() => {
      runWhenIdle(() => {
        try {
          trimOldDomTurns();
        } finally {
          CGO.STATE.trimScheduled = false;
        }
      });
    }, delay);
  }

  function observeRouteChanges() {
    if (routeObserver) return;

    const root = document.documentElement;

    routeObserver = new MutationObserver(() => {
      if (location.href === lastKnownUrl) return;

      lastKnownUrl = location.href;
      CGO.log("route changed", lastKnownUrl);

      if (CGO.closeSettingsPanel) {
        CGO.closeSettingsPanel();
      }

      if (CGO.injectExportButtonIntoHeader) {
        CGO.injectExportButtonIntoHeader();
      }

      scheduleDomTrim();
    });

    routeObserver.observe(root, {
      childList: true,
      subtree: true,
    });
  }

  function isStreamingStillActive() {
    const indicators = [
      '[data-testid="stop-button"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="停止"]',
    ];

    for (const selector of indicators) {
      if (document.querySelector(selector)) return true;
    }

    return false;
  }

  function observeStreamCompletion() {
    if (streamObserver) return;

    const root = getConversationRoot();

    streamObserver = new MutationObserver(() => {
      const isActive = isStreamingStillActive();

      if (CGO.STATE.lastStopVisible && !isActive) {
        CGO.log("stream completed");
        scheduleDomTrim();
      }

      CGO.STATE.lastStopVisible = isActive;
    });

    streamObserver.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  }

  function getCurrentVisibleMessageId() {
    const turns = getTurnArticlesForExport();
    if (!turns.length) return "";

    const viewportTop = 0;
    let best = "";
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const turn of turns) {
      const rect = turn.getBoundingClientRect();
      const turnId = extractMessageIdFromTurn(turn);
      if (!turnId) continue;

      const distance = Math.abs(rect.top - viewportTop);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = turnId;
      }
    }

    return best || extractMessageIdFromTurn(turns[turns.length - 1]) || "";
  }

  function scrollToMessageId(messageId) {
    if (!messageId) return false;

    const target =
      document.querySelector(`[data-turn-id="${CSS.escape(messageId)}"]`) ||
      document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);

    if (!target) return false;

    target.scrollIntoView({
      block: "start",
      behavior: "smooth",
    });

    return true;
  }

  CGO.onDomReady = onDomReady;
  CGO.getConversationRoot = getConversationRoot;
  CGO.getTurnArticles = getTurnArticles;
  CGO.getTurnArticlesForExport = getTurnArticlesForExport;
  CGO.extractMessageIdFromTurn = extractMessageIdFromTurn;
  CGO.getTurnRoleFromDom = getTurnRoleFromDom;
  CGO.extractImagesFromTurn = extractImagesFromTurn;
  CGO.extractAttachmentsFromTurn = extractAttachmentsFromTurn;
  CGO.buildDomAssetMap = buildDomAssetMap;

  CGO.trimOldDomTurns = trimOldDomTurns;
  CGO.runWhenIdle = runWhenIdle;
  CGO.scheduleDomTrim = scheduleDomTrim;
  CGO.observeRouteChanges = observeRouteChanges;
  CGO.observeStreamCompletion = observeStreamCompletion;

  CGO.getCurrentVisibleMessageId = getCurrentVisibleMessageId;
  CGO.scrollToMessageId = scrollToMessageId;
})();