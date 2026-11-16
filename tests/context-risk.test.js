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
    mappingCount: 1000,
    turnCount: 660,
    autoAdjustScore: 2200,
  }), 0);
  assert.equal(CGO.getProjectGuideLevel({
    mappingCount: 1070,
    turnCount: 705,
    autoAdjustScore: 2360,
  }), 1);
  assert.equal(CGO.getProjectGuideLevel({
    mappingCount: 1190,
    turnCount: 785,
    autoAdjustScore: 2630,
  }), 2);
  assert.equal(CGO.getProjectGuideLevel({
    mappingCount: 1375,
    turnCount: 905,
    autoAdjustScore: 3030,
  }), 3);
});

test("November 2026 observation reaches the advisory strong-warning stage", () => {
  const CGO = loadConfig();
  const stats = {
    mappingCount: 1525,
    chainLength: 1525,
    turnCount: 1004,
    autoAdjustScore: 3362.449,
    currentNodeId: "limit-message",
    currentNodeRole: "assistant",
    currentMessageStatus: "finished_successfully",
    currentMessageEndTurn: false,
    latestAssistantMessageId: "previous-reply",
    latestAssistantStatus: "finished_successfully",
    latestAssistantEndTurn: false,
  };

  assert.equal(CGO.getProjectGuideLevel(stats), 3);
  const structure = CGO.getConversationStructureRiskDetails(stats);
  assert.ok(structure.ratio >= 1);
  assert.equal(structure.replyLimitReached, false);
  assert.equal(structure.directFailureSignal, false);
  assert.equal(
    CGO.getProjectGuideProfileKey(stats),
    "structure-v2:1525:1004:3362"
  );
});

test("reply-limit state uses a fresh dismissal profile", () => {
  const CGO = loadConfig();
  const base = {
    mappingCount: 1375,
    turnCount: 905,
    autoAdjustScore: 3030,
  };
  const limited = {
    ...base,
    conversationTooLarge: true,
    conversationLimitCode: "conversation_too_large",
  };

  assert.equal(
    CGO.getProjectGuideProfileKey(base),
    "structure-v2:1525:1004:3362"
  );
  assert.equal(
    CGO.getProjectGuideProfileKey(limited),
    "structure-v2:1525:1004:3362:reply-limit"
  );
});

test("explicit conversation-too-large response is sufficient without structure stats", () => {
  const CGO = loadConfig();
  const stats = {
    conversationTooLarge: true,
    conversationLimitCode: "conversation_too_large",
  };

  assert.equal(CGO.getProjectGuideLevel(stats), 3);
  assert.equal(
    CGO.getConversationStructureRiskDetails(stats).replyLimitReached,
    true
  );
  assert.equal(
    CGO.getProjectGuideProfileKey(stats),
    "structure-v2:1525:1004:3362:reply-limit"
  );
});

test("previously observed long conversations now map to the strong stage", () => {
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

  assert.equal(CGO.getProjectGuideLevel(longConversation), 3);
  assert.equal(CGO.getProjectGuideLevel(failedConversation), 3);
});

test("one structural outlier does not dominate the median", () => {
  const CGO = loadConfig();
  const stats = {
    mappingCount: 2800,
    turnCount: 500,
    autoAdjustScore: 1600,
  };

  assert.equal(CGO.getProjectGuideLevel(stats), 0);
  assert.ok(CGO.getConversationStructureRiskDetails(stats).ratio < 0.7);
});

test("persistence and stream failures immediately raise a strong warning", () => {
  const CGO = loadConfig();
  const base = {
    mappingCount: 1070,
    turnCount: 705,
    autoAdjustScore: 2360,
  };

  assert.equal(CGO.getProjectGuideLevel(base), 1);
  assert.equal(CGO.getProjectGuideLevel({
    ...base,
    latestAssistantPersisted: false,
  }), 3);
  assert.equal(CGO.getProjectGuideLevel({ ...base, streamError: true }), 3);
  assert.equal(CGO.getProjectGuideLevel({ ...base, streamIncomplete: true }), 3);

  const nearLimit = {
    mappingCount: 1190,
    turnCount: 785,
    autoAdjustScore: 2630,
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

test("legacy visible-message thresholds remain a structural-data fallback", () => {
  const CGO = loadConfig();
  assert.equal(CGO.getProjectGuideLevel({ conversationalLength: 800 }), 2);
});
