const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadConfig() {
  const window = {
    __CGO: {},
    addEventListener() {},
    removeEventListener() {},
    postMessage() {},
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
    setTimeout,
    clearTimeout,
    setInterval() { return 1; },
    URL,
  });
  const configPath = path.join(__dirname, "..", "content", "config.js");
  vm.runInContext(fs.readFileSync(configPath, "utf8"), context, {
    filename: configPath,
  });
  return window.__CGO;
}

test("context risk uses staged thresholds with output headroom", () => {
  const CGO = loadConfig();
  const base = {
    contextLimit: 128000,
    contextLimitSource: "fallback",
    historyComplete: true,
    hasUncertainMedia: false,
  };

  assert.equal(CGO.getProjectGuideLevel({ ...base, safeTokenCount: 74000 }), 0);
  assert.equal(CGO.getProjectGuideLevel({ ...base, safeTokenCount: 75000 }), 1);
  assert.equal(CGO.getProjectGuideLevel({ ...base, safeTokenCount: 90000 }), 2);
  assert.equal(CGO.getProjectGuideLevel({ ...base, safeTokenCount: 102000 }), 3);
});

test("uncertain media or incomplete history warns earlier", () => {
  const CGO = loadConfig();
  const stats = {
    safeTokenCount: 70000,
    contextLimit: 128000,
    historyComplete: false,
    hasUncertainMedia: true,
  };

  assert.equal(CGO.getProjectGuideLevel(stats), 1);
  assert.equal(CGO.getContextRiskDetails(stats).uncertain, true);
});

test("manual context reference overrides the detected model limit", () => {
  const CGO = loadConfig();
  CGO.SETTINGS.contextTokenLimit = 256000;
  const stats = {
    safeTokenCount: 90000,
    contextLimit: 128000,
    contextLimitSource: "model",
    historyComplete: true,
    hasUncertainMedia: false,
    modelSlug: "gpt-5-chat-latest",
  };

  const risk = CGO.getContextRiskDetails(stats);
  assert.equal(risk.contextLimit, 256000);
  assert.equal(risk.contextLimitSource, "setting");
  assert.equal(CGO.getProjectGuideLevel(stats), 0);
});

test("legacy message-count thresholds remain a token-data fallback", () => {
  const CGO = loadConfig();
  assert.equal(CGO.getProjectGuideLevel({ conversationalLength: 800 }), 2);
});
