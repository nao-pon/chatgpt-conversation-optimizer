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

test("conversation structure risk uses empirically calibrated stages", () => {
  const CGO = loadConfig();
  assert.equal(CGO.getProjectGuideLevel({
    mappingCount: 1750,
    turnCount: 1050,
    autoAdjustScore: 3350,
  }), 0);
  assert.equal(CGO.getProjectGuideLevel({
    mappingCount: 1900,
    turnCount: 1150,
    autoAdjustScore: 3650,
  }), 1);
  assert.equal(CGO.getProjectGuideLevel({
    mappingCount: 2170,
    turnCount: 1300,
    autoAdjustScore: 4150,
  }), 2);
  assert.equal(CGO.getProjectGuideLevel({
    mappingCount: 2450,
    turnCount: 1500,
    autoAdjustScore: 4700,
  }), 3);
});

test("observed long and failed conversations map to preparation and strong stages", () => {
  const CGO = loadConfig();
  const longConversation = {
    mappingCount: 2174,
    chainLength: 2174,
    turnCount: 1289,
    autoAdjustScore: 4122.065666666667,
  };
  const failedConversation = {
    mappingCount: 2700,
    chainLength: 2700,
    turnCount: 1639,
    autoAdjustScore: 5173.292333333334,
  };

  assert.equal(CGO.getProjectGuideLevel(longConversation), 2);
  assert.equal(CGO.getProjectGuideLevel(failedConversation), 3);
});

test("one structural outlier does not dominate the median", () => {
  const CGO = loadConfig();
  const stats = {
    mappingCount: 2800,
    turnCount: 900,
    autoAdjustScore: 2800,
  };

  assert.equal(CGO.getProjectGuideLevel(stats), 0);
  assert.ok(CGO.getConversationStructureRiskDetails(stats).ratio < 0.7);
});

test("persistence and stream failures immediately raise a strong warning", () => {
  const CGO = loadConfig();
  const base = {
    mappingCount: 1950,
    turnCount: 1160,
    autoAdjustScore: 3650,
  };

  assert.equal(CGO.getProjectGuideLevel(base), 1);
  assert.equal(CGO.getProjectGuideLevel({
    ...base,
    latestAssistantPersisted: false,
  }), 3);
  assert.equal(CGO.getProjectGuideLevel({ ...base, streamError: true }), 3);
  assert.equal(CGO.getProjectGuideLevel({ ...base, streamIncomplete: true }), 3);

  const nearLimit = {
    mappingCount: 2170,
    turnCount: 1300,
    autoAdjustScore: 4150,
    streamDone: true,
    streamCompletedNormally: false,
  };
  assert.equal(CGO.getProjectGuideLevel(nearLimit), 3);
});

test("stream errors do not turn a short conversation into a limit warning", () => {
  const CGO = loadConfig();
  assert.equal(
    CGO.getProjectGuideLevel({
      mappingCount: 500,
      turnCount: 300,
      autoAdjustScore: 900,
      streamError: true,
    }),
    0
  );
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

test("token estimates remain reference data and do not trigger warnings", () => {
  const CGO = loadConfig();
  const stats = {
    safeTokenCount: 500000,
    contextLimit: 128000,
    contextLimitSource: "fallback",
    tokenConfidence: "low",
    mappingCount: 500,
    turnCount: 300,
    autoAdjustScore: 900,
  };

  assert.equal(CGO.getProjectGuideLevel(stats), 0);
  assert.ok(CGO.getContextRiskDetails(stats).ratio > 1);
});

test("legacy visible-message thresholds remain a structural-data fallback", () => {
  const CGO = loadConfig();
  assert.equal(CGO.getProjectGuideLevel({ conversationalLength: 800 }), 2);
});
