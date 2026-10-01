const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("settings checkboxes keep edits while history mode changes and save them", async () => {
  const controls = new Map();
  function control(selector) {
    const element = {
      checked: false,
      disabled: false,
      value: "",
      style: {},
      listeners: {},
      addEventListener(type, listener) {
        this.listeners[type] = listener;
      },
    };
    controls.set(selector, element);
    return element;
  }

  control("#cgo-setting-keep-dom-messages");
  control("#cgo-setting-auto-adjust-enabled");
  control("#cgo-setting-auto-adjust-label");
  const images = control("#cgo-setting-html-include-images");
  const debug = control("#cgo-setting-debug-enabled");
  const debugLevel = control("#cgo-setting-debug-level");
  control(".cgo-settings-save-btn");
  control(".cgo-settings-cancel-btn");

  const rows = [{ hidden: false, style: {} }, { hidden: false, style: {} }];
  const panel = {
    hidden: true,
    querySelector(selector) {
      return controls.get(selector) || null;
    },
    querySelectorAll(selector) {
      return selector === ".cgo-dom-optimization-setting" ? rows : [];
    },
    addEventListener() {},
  };
  const headerActions = {};
  const toolbar = { parentElement: headerActions, hidden: false };
  let mountedPanel = null;
  const document = {
    body: {
      appendChild(element) {
        mountedPanel = element;
      },
    },
    getElementById(id) {
      if (id === "conversation-header-actions") return headerActions;
      if (id === "cgo-settings-panel") return mountedPanel;
      return null;
    },
    querySelector(selector) {
      return selector === "div.cgo-toolbar" ? toolbar : null;
    },
    createElement() {
      return panel;
    },
  };
  const window = { __CGO: {} };
  const context = vm.createContext({
    window,
    globalThis: window,
    document,
    Date,
    console,
    setTimeout,
    clearTimeout,
  });
  const CGO = window.__CGO;
  CGO.CONFIG = { keepDomMessages: 40, debugLevel: "BASIC" };
  CGO.SETTINGS = {
    keepDomMessages: 40,
    autoAdjustEnabled: true,
    htmlDownloadIncludeImages: true,
    debugEnabled: false,
    debugLevel: "BASIC",
  };
  CGO.STATE = {
    activeConversationHistoryMode: "unknown",
    activeConversationHistoryModeConversationId: "conversation-1",
    projectGuide: {},
  };
  CGO.getConversationIdFromLocation = () => "conversation-1";
  CGO.getEffectiveKeepDomMessagesForSettings = () => 40;
  CGO.clampKeepDomMessages = Number;
  CGO.escapeHtml = String;
  CGO.t = (key) => key;
  CGO.log = () => {};
  let savedSettings = null;
  CGO.saveSettings = async (settings) => {
    savedSettings = { ...settings };
    Object.assign(CGO.SETTINGS, settings);
  };

  for (const file of ["ui.js", "dom.js"]) {
    const filePath = path.join(__dirname, "..", "content", file);
    vm.runInContext(fs.readFileSync(filePath, "utf8"), context, {
      filename: filePath,
    });
  }

  CGO.injectExportButtonIntoHeader();
  assert.equal(mountedPanel, panel);
  assert.equal(images.checked, true);
  assert.equal(debug.checked, false);

  panel.hidden = false;
  images.checked = false;
  debug.checked = true;
  debug.listeners.change();
  assert.equal(debugLevel.disabled, false);

  CGO.setActiveConversationHistoryMode("paginated", "conversation-1");
  assert.equal(images.checked, false);
  assert.equal(debug.checked, true);
  assert.equal(rows.every((row) => row.hidden), true);

  assert.equal(await panel.__cgoSaveSettings(), true);
  assert.equal(savedSettings.htmlDownloadIncludeImages, false);
  assert.equal(savedSettings.debugEnabled, true);
});
