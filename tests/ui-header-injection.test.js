const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadUi(document, windowOverrides = {}) {
  const window = { __CGO: {}, ...windowOverrides };
  const location = windowOverrides.location || { pathname: "/c/conversation-1" };
  window.location = location;
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

test("project guide hides when its analysis belongs to another conversation", async () => {
  const guide = {
    hidden: false,
    dataset: {},
    querySelector() { return null; },
  };
  const document = {
    getElementById(id) {
      return id === "cgo-project-guide" ? guide : null;
    },
  };
  const CGO = loadUi(document, {
    location: { pathname: "/c/conversation-2" },
  });
  CGO.STATE = {
    projectGuide: {
      conversationId: "conversation-1",
      stats: { conversationalLength: 800 },
      level: 2,
    },
  };
  CGO.getConversationIdFromLocation = () => "conversation-2";
  CGO.isProjectGuideDismissed = async () => {
    throw new Error("mismatched guide must not read dismissal state");
  };

  await CGO.updateProjectGuideVisibility();

  assert.equal(guide.hidden, true);
});

test("an older guide refresh cannot reappear after route state is cleared", async () => {
  let resolveDismissed;
  let currentConversationId = "conversation-1";
  const dismissed = new Promise((resolve) => { resolveDismissed = resolve; });
  const title = { textContent: "" };
  const body = { textContent: "" };
  const guide = {
    hidden: true,
    dataset: {},
    querySelector(selector) {
      return {
        ".cgo-project-guide-title": title,
        ".cgo-project-guide-body": body,
      }[selector] || null;
    },
  };
  const document = {
    getElementById(id) {
      return id === "cgo-project-guide" ? guide : null;
    },
  };
  const CGO = loadUi(document);
  CGO.STATE = {
    projectGuide: {
      conversationId: "conversation-1",
      projectName: "Project",
      stats: { conversationalLength: 800 },
      level: 2,
    },
  };
  CGO.getConversationIdFromLocation = () => currentConversationId;
  CGO.isProjectGuideDismissed = () => dismissed;
  CGO.t = (key) => key;

  const oldRefresh = CGO.updateProjectGuideVisibility();
  currentConversationId = "conversation-2";
  CGO.STATE.projectGuide = {
    conversationId: "",
    projectName: "",
    stats: null,
    level: 0,
  };
  await CGO.updateProjectGuideVisibility();
  resolveDismissed(false);
  await oldRefresh;

  assert.equal(guide.hidden, true);
});

test("migration prompt fills ChatGPT's current mobile composer textarea without submitting", () => {
  const events = [];
  const textarea = {
    tagName: "TEXTAREA",
    value: "existing draft",
    disabled: false,
    focused: false,
    selection: null,
    getAttribute() { return null; },
    focus() { this.focused = true; },
    setSelectionRange(start, end) { this.selection = [start, end]; },
    dispatchEvent(event) { events.push(event); },
  };
  const document = {
    querySelector(selector) {
      return selector === "#mobile-composer-prompt" ? textarea : null;
    },
  };
  class FakeEvent {
    constructor(type) { this.type = type; }
  }

  const CGO = loadUi(document, { Event: FakeEvent });
  const prompt = "Migration prompt, please.";

  assert.equal(CGO.fillChatComposer(prompt), true);
  assert.equal(textarea.value, prompt);
  assert.equal(textarea.focused, true);
  assert.deepEqual(textarea.selection, [prompt.length, prompt.length]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "input");
});

test("migration prompt prefers the visible data-composer-input ProseMirror editor", () => {
  const events = [];
  const paragraph = {
    childNodes: [{ nodeType: 3 }],
    textContent: "existing draft",
  };
  const hiddenLegacyComposer = {
    tagName: "DIV",
    textContent: "",
    disabled: false,
    getAttribute() { return null; },
    getClientRects() { return []; },
  };
  const composer = {
    tagName: "DIV",
    textContent: "existing draft",
    disabled: false,
    focused: false,
    getAttribute() { return null; },
    getClientRects() { return [{}]; },
    querySelectorAll(selector) { return selector === "p" ? [paragraph] : []; },
    focus() { this.focused = true; },
    dispatchEvent(event) { events.push(event); },
  };
  const rangeCalls = [];
  const document = {
    querySelectorAll(selector) {
      if (selector === "#prompt-textarea") return [hiddenLegacyComposer];
      return selector ===
        '[data-composer-input] [contenteditable="true"][role="textbox"]'
        ? [composer]
        : [];
    },
    execCommand(command, _showUi, value) {
      assert.equal(command, "insertText");
      composer.textContent = value;
      return true;
    },
    createRange() {
      return {
        setStart(node, offset) { rangeCalls.push(["start", node, offset]); },
        setEnd(node, offset) { rangeCalls.push(["end", node, offset]); },
        selectNodeContents(node) { rangeCalls.push(["contents", node]); },
        collapse(value) { rangeCalls.push(["collapse", value]); },
      };
    },
  };
  class FakeInputEvent {
    constructor(type, options) {
      this.type = type;
      this.data = options.data;
    }
  }

  const selection = {
    removeAllRanges() {},
    addRange() {},
  };
  const CGO = loadUi(document, {
    InputEvent: FakeInputEvent,
    getSelection: () => selection,
  });
  const prompt = "Migration prompt, please.";

  assert.equal(CGO.fillChatComposer(prompt), true);
  assert.equal(composer.textContent, prompt);
  assert.equal(composer.focused, true);
  assert.deepEqual(rangeCalls[0], ["start", paragraph, 0]);
  assert.deepEqual(rangeCalls[1], ["end", paragraph, 1]);
  assert.equal(events.length, 0, "native edit path must not dispatch a duplicate input event");
});

test("migration prompt fallback preserves a ProseMirror paragraph", () => {
  const events = [];
  const paragraph = {
    childNodes: [{ nodeType: 3 }],
    textContent: "existing draft",
  };
  const composer = {
    tagName: "DIV",
    disabled: false,
    get textContent() { return paragraph.textContent; },
    set textContent(value) { paragraph.textContent = value; },
    getAttribute() { return null; },
    getClientRects() { return [{}]; },
    querySelectorAll(selector) { return selector === "p" ? [paragraph] : []; },
    replaceChildren(node) { assert.equal(node, paragraph); },
    focus() {},
    dispatchEvent(event) { events.push(event); },
  };
  const document = {
    querySelectorAll(selector) {
      return selector ===
        '[data-composer-input] [contenteditable="true"][role="textbox"]'
        ? [composer]
        : [];
    },
    execCommand() { return false; },
  };
  class FakeInputEvent {
    constructor(type, options) {
      this.type = type;
      this.data = options.data;
    }
  }

  const CGO = loadUi(document, { InputEvent: FakeInputEvent });
  const prompt = "Migration prompt, please.";

  assert.equal(CGO.fillChatComposer(prompt), true);
  assert.equal(paragraph.textContent, prompt);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "input");
  assert.equal(events[0].data, prompt);
});

test("project guide ZIP button shows progress, completion, and retry state", async () => {
  let clickZip;
  let mountedGuide = null;
  const zipButton = {
    dataset: {},
    textContent: "",
    title: "",
    disabled: false,
    classList: { add() {}, remove() {} },
    setAttribute() {},
    querySelector() { return null; },
    addEventListener(type, listener) {
      if (type === "click") clickZip = listener;
    },
  };
  const migrateButton = { textContent: "", addEventListener() {} };
  const hideButton = { textContent: "", addEventListener() {} };
  const title = { textContent: "" };
  const body = { textContent: "" };
  const headerActions = {
    after(guide) { mountedGuide = guide; },
  };
  const guide = {
    dataset: {},
    hidden: true,
    querySelector(selector) {
      return {
        ".cgo-project-guide-migrate": migrateButton,
        ".cgo-project-guide-zip": zipButton,
        ".cgo-project-guide-hide": hideButton,
        ".cgo-project-guide-title": title,
        ".cgo-project-guide-body": body,
      }[selector] || null;
    },
  };
  const document = {
    getElementById(id) {
      if (id === "conversation-header-actions") return headerActions;
      if (id === "cgo-project-guide") return mountedGuide;
      return null;
    },
    createElement() { return guide; },
  };
  const CGO = loadUi(document);
  CGO.STATE = {
    projectGuide: {
      conversationId: "conversation-1",
      projectName: "Project",
      stats: { conversationalLength: 800 },
      level: 2,
    },
  };
  CGO.getConversationIdFromLocation = () => "conversation-1";
  CGO.isProjectGuideDismissed = async () => false;
  CGO.t = (key) => ({
    zip_download_button: "Save as ZIP",
    hide_button: "Hide",
    exporting: "Exporting...",
    export_retry: "Retry",
  })[key] || key;
  CGO.log = () => {};

  await CGO.updateProjectGuideVisibility();
  assert.equal(guide.hidden, false);

  let finishExport;
  let receivedButton;
  CGO.exportCurrentConversationAsZip = (button) => {
    receivedButton = button;
    CGO.setToolbarButtonText(button, "Loading history...");
    return new Promise((resolve) => { finishExport = resolve; });
  };
  const pending = clickZip();
  assert.equal(receivedButton, zipButton);
  assert.equal(zipButton.disabled, true);
  assert.equal(zipButton.textContent, "Loading history...");
  finishExport();
  await pending;
  assert.equal(zipButton.disabled, false);
  assert.equal(zipButton.textContent, "Save as ZIP");

  CGO.exportCurrentConversationAsZip = async () => {
    throw new Error("ZIP download failed");
  };
  await clickZip();
  assert.equal(zipButton.disabled, false);
  assert.equal(zipButton.textContent, "Retry");
  assert.equal(zipButton.title, "ZIP download failed");
});
