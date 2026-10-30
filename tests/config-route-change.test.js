const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("route changes clear and hide the previous conversation guide", async () => {
  let mutationCallback;
  const location = { pathname: "/c/conversation-1" };
  const window = {
    __CGO: {},
    addEventListener() {},
    removeEventListener() {},
    postMessage() {},
  };
  const document = {
    body: {},
    documentElement: { lang: "en" },
    getElementById() { return null; },
  };
  class FakeMutationObserver {
    constructor(callback) {
      mutationCallback = callback;
    }
    observe() {}
  }
  const context = vm.createContext({
    window,
    globalThis: window,
    document,
    location,
    navigator: { language: "en" },
    chrome: {
      i18n: { getUILanguage: () => "en", getMessage: () => "" },
      storage: { local: {} },
    },
    MutationObserver: FakeMutationObserver,
    console,
    setTimeout,
    clearTimeout,
    setInterval() { return 1; },
    URL,
  });
  const configPath = path.join(__dirname, "..", "content", "config.js");
  vm.runInContext(fs.readFileSync(configPath, "utf8"), context, {
    filename: configPath,
  });

  const CGO = window.__CGO;
  let guideRefreshes = 0;
  let alertRefreshes = 0;
  CGO.STATE.activeConversationId = "conversation-1";
  CGO.STATE.projectGuide = {
    conversationId: "conversation-1",
    projectName: "Project",
    stats: { conversationalLength: 800 },
    level: 2,
  };
  CGO.getConversationIdFromLocation = () => "";
  CGO.setActiveConversationHistoryMode = () => {};
  CGO.updateProjectGuideVisibility = async () => { guideRefreshes += 1; };
  CGO.updateProjectGuideAlertVisibility = async () => { alertRefreshes += 1; };
  CGO.resetInitialPruneNoticeState = () => {};
  CGO.handleConversationRouteChanged = () => {};
  CGO.updateExportButtonVisibility = () => {};
  CGO.ensurePageHooksInjected = async () => false;

  CGO.observeRouteChanges();
  location.pathname = "/g/project-1";
  mutationCallback();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(
    JSON.parse(JSON.stringify(CGO.STATE.projectGuide)),
    { conversationId: "", projectName: "", stats: null, level: 0 }
  );
  assert.equal(guideRefreshes, 1);
  assert.equal(alertRefreshes, 1);
});

test("bootstrap and main hook handshakes use independent versions", async () => {
  const bootstrapSource = fs.readFileSync(
    path.join(__dirname, "..", "page-bootstrap.js"),
    "utf8"
  );
  const pageHookSource = fs.readFileSync(
    path.join(__dirname, "..", "page-hook.js"),
    "utf8"
  );
  const bootstrapVersion = bootstrapSource.match(/const VERSION = "([^"]+)"/)?.[1];
  const pageHookVersion = pageHookSource.match(
    /const PAGE_HOOK_VERSION = "([^"]+)"/
  )?.[1];
  assert.ok(bootstrapVersion);
  assert.ok(pageHookVersion);

  const listeners = new Map();
  const window = {
    __CGO: {},
    addEventListener(type, listener) {
      const current = listeners.get(type) || [];
      current.push(listener);
      listeners.set(type, current);
    },
    removeEventListener(type, listener) {
      listeners.set(
        type,
        (listeners.get(type) || []).filter((candidate) => candidate !== listener)
      );
    },
    postMessage(data) {
      queueMicrotask(() => {
        let response = null;
        if (data?.source === "CGO_CONTENT" && data.type === "CGO_PING") {
          response = {
            source: "CGO_PAGE",
            type: "CGO_PONG",
            version: bootstrapVersion,
            bootstrap: true,
          };
        } else if (
          data?.source === "CGO_CONTENT" &&
          data.type === "CGO_INIT_SETTINGS"
        ) {
          response = {
            source: "CGO_PAGE",
            type: "CGO_INIT_SETTINGS_ACK",
            version: pageHookVersion,
            mainHook: true,
            secret: "test-secret",
          };
        }

        if (!response) return;
        for (const listener of listeners.get("message") || []) {
          listener({ source: window, data: response });
        }
      });
    },
  };
  const context = vm.createContext({
    window,
    globalThis: window,
    document: {
      body: {},
      documentElement: { lang: "en" },
      getElementById() { return null; },
    },
    location: { pathname: "/c/conversation-1" },
    navigator: { language: "en" },
    chrome: {
      i18n: { getUILanguage: () => "en", getMessage: () => "" },
      storage: { local: {} },
    },
    MutationObserver: class { observe() {} },
    console,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    setInterval() { return 1; },
    URL,
  });
  const configPath = path.join(__dirname, "..", "content", "config.js");
  vm.runInContext(fs.readFileSync(configPath, "utf8"), context, {
    filename: configPath,
  });

  assert.equal(window.__CGO.PAGE_BOOTSTRAP_VERSION, bootstrapVersion);
  assert.equal(window.__CGO.PAGE_HOOK_VERSION, pageHookVersion);
  assert.equal(await window.__CGO.ensurePageHooksInjected(), true);
  assert.equal(window.__CGO_BRIDGE_SECRET__, "test-secret");
});
