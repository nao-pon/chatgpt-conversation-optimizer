const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadUi(document) {
  const window = { __CGO: {} };
  const context = vm.createContext({
    window,
    globalThis: window,
    document,
    console,
    setTimeout,
    clearTimeout,
  });
  const uiPath = path.join(__dirname, "..", "content", "ui.js");
  vm.runInContext(fs.readFileSync(uiPath, "utf8"), context, {
    filename: uiPath,
  });
  return window.__CGO;
}

test("header action lookup preserves the legacy ChatGPT container", () => {
  const legacyActions = { id: "conversation-header-actions" };
  const document = {
    getElementById(id) {
      return id === "conversation-header-actions" ? legacyActions : null;
    },
    querySelector() {
      throw new Error("modern lookup should not run when the legacy container exists");
    },
  };

  const CGO = loadUi(document);
  const guideAnchor = CGO.findProjectGuideAnchor();
  assert.equal(CGO.findConversationHeaderActions(), legacyActions);
  assert.equal(guideAnchor.element, legacyActions);
  assert.equal(guideAnchor.layout, "legacy");
});

test("header action lookup supports the current app-shell sibling layout", () => {
  const titlebar = { id: "modern-titlebar" };
  const actionRow = { id: "modern-action-row" };
  const nativeMenuButton = { parentElement: actionRow };
  const surface = {
    querySelector(selector) {
      return selector === 'button[aria-haspopup="menu"]'
        ? nativeMenuButton
        : null;
    },
    querySelectorAll() {
      return [];
    },
    closest(selector) {
      return selector === 'header[data-app-shell-titlebar="true"]'
        ? titlebar
        : null;
    },
  };
  const document = {
    getElementById() {
      return null;
    },
    querySelector(selector) {
      return selector ===
        '[data-testid="app-shell-header-context-menu-surface"]'
        ? surface
        : null;
    },
  };

  const CGO = loadUi(document);
  const guideAnchor = CGO.findProjectGuideAnchor();
  assert.equal(CGO.findConversationHeaderSurface(), surface);
  assert.equal(CGO.findConversationHeaderActions(), actionRow);
  assert.equal(guideAnchor.element, titlebar);
  assert.equal(guideAnchor.layout, "app-shell");
});

test("header action lookup falls back to a native button inside an app-shell obstacle", () => {
  const actionRow = { id: "fallback-action-row" };
  const nativeButton = { parentElement: actionRow };
  const obstacle = {
    querySelector(selector) {
      return selector === "button" ? nativeButton : null;
    },
  };
  const surface = {
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      return selector === '[data-app-shell-header-obstacle="true"]'
        ? [obstacle]
        : [];
    },
    closest() {
      return null;
    },
  };
  const document = {
    getElementById() {
      return null;
    },
    querySelector() {
      return surface;
    },
  };

  const CGO = loadUi(document);
  assert.equal(CGO.findConversationHeaderActions(), actionRow);
});
