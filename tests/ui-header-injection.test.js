const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadUi(document, windowOverrides = {}) {
  const window = { __CGO: {}, ...windowOverrides };
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
  const nativeMenuButton = {
    parentElement: actionRow,
    closest() {
      return null;
    },
  };
  const surface = {
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
  const nativeButton = {
    parentElement: actionRow,
    closest() {
      return null;
    },
  };
  const obstacle = {
    querySelectorAll(selector) {
      return selector === "button" ? [nativeButton] : [];
    },
  };
  const surface = {
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

test("header action lookup ignores buttons inside the extension toolbar", () => {
  const toolbar = {};
  const ownButton = {
    parentElement: toolbar,
    closest() {
      return toolbar;
    },
  };
  const actionRow = {};
  const nativeButton = {
    parentElement: actionRow,
    closest() {
      return null;
    },
  };
  const obstacle = {
    querySelectorAll(selector) {
      return selector === "button" ? [ownButton, nativeButton] : [];
    },
  };
  const surface = {
    querySelectorAll(selector) {
      if (selector === 'button[aria-haspopup="menu"]') return [ownButton];
      return selector === '[data-app-shell-header-obstacle="true"]'
        ? [obstacle]
        : [];
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

test("existing toolbar is not prepended into itself or its descendants", () => {
  for (const target of ["self", "descendant"]) {
    const toolbar = {
      parentElement: { id: "old-parent" },
      hidden: true,
      contains(element) {
        return element === toolbar || element === descendant;
      },
    };
    const descendant = {
      prepend() {
        throw new Error("cannot prepend toolbar into its descendant");
      },
    };
    const headerActions = target === "self" ? toolbar : descendant;
    const document = {
      getElementById(id) {
        if (id === "conversation-header-actions") return headerActions;
        if (id === "cgo-settings-panel") return {};
        return null;
      },
      querySelector(selector) {
        return selector === "div.cgo-toolbar" ? toolbar : null;
      },
    };
    const CGO = loadUi(document);
    CGO.STATE = { exportToolbarVisible: true };
    CGO.getConversationIdFromLocation = () => "conversation-id";
    CGO.updateProjectGuideAlertVisibility = () => {};

    assert.doesNotThrow(() => CGO.injectExportButtonIntoHeader());
    assert.equal(CGO.toolbarBase, toolbar);
    assert.equal(toolbar.hidden, false);
  }
});

test("existing toolbar still moves to a different header action row", () => {
  const toolbar = {
    parentElement: { id: "old-parent" },
    hidden: true,
    contains() {
      return false;
    },
  };
  let prependCount = 0;
  const headerActions = {
    prepend(element) {
      assert.equal(element, toolbar);
      toolbar.parentElement = this;
      prependCount += 1;
    },
  };
  const document = {
    getElementById(id) {
      if (id === "conversation-header-actions") return headerActions;
      if (id === "cgo-settings-panel") return {};
      return null;
    },
    querySelector(selector) {
      return selector === "div.cgo-toolbar" ? toolbar : null;
    },
  };
  const CGO = loadUi(document);
  CGO.STATE = { exportToolbarVisible: true };
  CGO.getConversationIdFromLocation = () => "conversation-id";
  CGO.updateProjectGuideAlertVisibility = () => {};

  CGO.injectExportButtonIntoHeader();
  CGO.injectExportButtonIntoHeader();

  assert.equal(prependCount, 1);
  assert.equal(toolbar.parentElement, headerActions);
  assert.equal(toolbar.hidden, false);
});

test("project guide aligns with the current conversation content column", () => {
  const guide = {
    dataset: { cgoHeaderLayout: "app-shell" },
    style: {},
  };
  const content = {
    getBoundingClientRect() {
      return { left: 420.25, width: 760.4 };
    },
  };
  const document = {
    getElementById(id) {
      return id === "cgo-project-guide" ? guide : null;
    },
    querySelector(selector) {
      return selector ===
        '[data-thread-user-message-navigation-content="true"]'
        ? content
        : null;
    },
  };

  const CGO = loadUi(document, { innerWidth: 1600 });
  CGO.positionProjectGuide();

  assert.equal(guide.style.left, "420px");
  assert.equal(guide.style.right, "auto");
  assert.equal(guide.style.width, "760px");
  assert.equal(guide.style.transform, "none");
});
