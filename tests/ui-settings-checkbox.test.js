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
      textContent: "",
      title: "",
      dataset: {},
      style: {},
      listeners: {},
      addEventListener(type, listener) {
        this.listeners[type] = listener;
      },
      setAttribute() {},
      classList: { add() {}, remove() {} },
      querySelector() { return null; },
    };
    controls.set(selector, element);
    return element;
  }

  control("#cgo-setting-keep-dom-messages");
  control("#cgo-setting-auto-adjust-enabled");
  control("#cgo-setting-auto-adjust-label");
  const contextLimit = control("#cgo-setting-context-token-limit");
  const customContextLimit = control("#cgo-setting-context-token-limit-custom");
  const customContextRow = control(".cgo-context-token-limit-custom-row");
  const images = control("#cgo-setting-html-include-images");
  const debug = control("#cgo-setting-debug-enabled");
  const debugLevel = control("#cgo-setting-debug-level");
  const handoff = control(".cgo-settings-handoff-btn");
  const copyHandoffPrompt = control(".cgo-settings-copy-handoff-prompt-btn");
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
  let copiedText = "";
  const navigator = {
    language: "ja",
    clipboard: {
      async writeText(value) {
        copiedText = value;
      },
    },
  };
  const window = { __CGO: {}, navigator };
  const context = vm.createContext({
    window,
    globalThis: window,
    document,
    navigator,
    Date,
    console,
    setTimeout() { return 1; },
    clearTimeout,
  });
  const CGO = window.__CGO;
  CGO.CONFIG = { keepDomMessages: 40, debugLevel: "BASIC" };
  CGO.SETTINGS = {
    keepDomMessages: 40,
    autoAdjustEnabled: true,
    contextTokenLimit: 0,
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
  CGO.DETECTION_LANG = "ja";
  let promptGeneration = null;
  CGO.buildHandoffPromptMarkdown = (language, options) => {
    promptGeneration = { language, options };
    return "日本語の引き継ぎ指示";
  };
  let exportedHandoff = false;
  CGO.exportCurrentConversationAsHandoffZip = async (button) => {
    exportedHandoff = button === handoff;
  };
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
  assert.equal(handoff.disabled, false);

  await handoff.listeners.click();
  assert.equal(exportedHandoff, true);
  assert.equal(handoff.disabled, false);

  await copyHandoffPrompt.listeners.click();
  assert.equal(copiedText, "日本語の引き継ぎ指示");
  assert.equal(promptGeneration.language, "ja");
  assert.equal(promptGeneration.options.bilingual, false);
  assert.equal(copyHandoffPrompt.textContent, "copied_button");

  panel.hidden = false;
  images.checked = false;
  debug.checked = true;
  debug.listeners.change();
  assert.equal(debugLevel.disabled, false);
  contextLimit.value = "custom";
  customContextLimit.value = "200000";
  contextLimit.listeners.change();
  assert.equal(customContextRow.hidden, false);

  CGO.setActiveConversationHistoryMode("paginated", "conversation-1");
  assert.equal(images.checked, false);
  assert.equal(debug.checked, true);
  assert.equal(rows.every((row) => row.hidden), true);

  assert.equal(await panel.__cgoSaveSettings(), true);
  assert.equal(savedSettings.htmlDownloadIncludeImages, false);
  assert.equal(savedSettings.debugEnabled, true);
  assert.equal(savedSettings.contextTokenLimit, "200000");
});
