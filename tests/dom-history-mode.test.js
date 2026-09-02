const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("DOM pruning is disabled for paginated history and retained for legacy history", async () => {
  let removedCount = 0;
  const turnNodes = Array.from({ length: 3 }, (_, index) => ({
    isConnected: true,
    getAttribute(name) {
      return name === "data-message-id" ? `message-${index}` : "";
    },
    querySelector() {
      return null;
    },
    remove() {
      if (!this.isConnected) return;
      this.isConnected = false;
      removedCount += 1;
    },
  }));
  const conversationRoot = {
    querySelectorAll() {
      return turnNodes;
    },
  };
  const trimNoticeText = { textContent: "" };
  const trimNotice = {
    querySelector() {
      return trimNoticeText;
    },
    remove() {},
  };
  const document = {
    getElementById(id) {
      return id === "cgo-dom-trim-notice" ? trimNotice : null;
    },
    querySelector(selector) {
      return selector === "main" ? conversationRoot : null;
    },
  };
  const window = {
    addEventListener() {},
    removeEventListener() {},
    postMessage() {},
  };
  window.__CGO = {
    CONFIG: { domTrimDelayMs: 0 },
    SETTINGS: { keepDomMessages: 1 },
    STATE: {
      activeConversationHistoryMode: "unknown",
      activeConversationHistoryModeConversationId: "",
      domTrimTimer: null,
      domTrimTicket: 0,
      domTrimState: { omittedCount: 0, firstKeptId: "" },
      initialPruneNoticeTimer: null,
      initialPruneNoticeScheduled: false,
      initialPruneNoticeRetryCount: 0,
      fixedTrimSummarySuppressTimer: null,
      voiceExportGuard: {
        state: "normal",
        conversationId: "",
        syncRetryCount: 0,
        syncRetryTimer: null,
        syncCheckInFlight: false,
        reason: "",
      },
    },
    getActiveKeepDomMessages() {
      return 1;
    },
    getConversationIdFromLocation() {
      return "conversation-1";
    },
    log() {},
    t(key) {
      return key;
    },
  };

  const runIdle = (callback) => {
    callback({ didTimeout: false, timeRemaining: () => 50 });
    return 1;
  };
  const context = vm.createContext({
    window,
    globalThis: window,
    document,
    requestIdleCallback: runIdle,
    setTimeout,
    clearTimeout,
    Date,
    console,
  });
  const domPath = path.join(__dirname, "..", "content", "dom.js");
  vm.runInContext(fs.readFileSync(domPath, "utf8"), context, {
    filename: domPath,
  });

  window.__CGO.scheduleDomTrim(0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(removedCount, 0, "unknown history mode must be non-destructive");

  window.__CGO.setActiveConversationHistoryMode("paginated", "conversation-1");
  window.__CGO.scheduleDomTrim(0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(removedCount, 0);
  assert.equal(window.__CGO.isPaginatedHistoryActive(), true);

  window.__CGO.setActiveConversationHistoryMode("legacy", "conversation-1");
  window.__CGO.scheduleDomTrim(0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(removedCount, 2);
  assert.equal(window.__CGO.isPaginatedHistoryActive(), false);
  assert.equal(window.__CGO.isDomPruningEnabled(), true);
});
