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
