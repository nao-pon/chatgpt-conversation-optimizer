const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadUi(document) {
  const location = { pathname: "/g/project-1/c/conversation-1" };
  const window = { __CGO: {}, location };
  const context = vm.createContext({
    window,
    globalThis: window,
    document,
    location,
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

test("header action lookup skips a stale hidden surface after SPA navigation", () => {
  const staleSurface = {
    offsetWidth: 0,
    offsetHeight: 0,
    querySelectorAll() {
      return [];
    },
  };
  const titlebar = { id: "active-titlebar" };
  const actionRow = { id: "active-action-row" };
  const nativeMenuButton = {
    parentElement: actionRow,
    closest() {
      return null;
    },
  };
  const activeSurface = {
    offsetWidth: 320,
    offsetHeight: 48,
    querySelectorAll(selector) {
      return selector === 'button[aria-haspopup="menu"]'
        ? [nativeMenuButton]
        : [];
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
        ? staleSurface
        : null;
    },
    querySelectorAll(selector) {
      return selector ===
        '[data-testid="app-shell-header-context-menu-surface"]'
        ? [staleSurface, activeSurface]
        : [];
    },
  };

  const CGO = loadUi(document);
  const guideAnchor = CGO.findProjectGuideAnchor();
  assert.equal(CGO.findConversationHeaderSurface(), activeSurface);
  assert.equal(CGO.findConversationHeaderActions(), actionRow);
  assert.equal(guideAnchor.element, titlebar);
  assert.equal(guideAnchor.layout, "app-shell");
});
