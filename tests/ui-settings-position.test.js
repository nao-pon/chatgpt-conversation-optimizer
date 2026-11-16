const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadUi({ width, height, visualViewport } = {}) {
  const document = {
    documentElement: {
      clientWidth: width,
      clientHeight: height,
    },
  };
  const window = {
    __CGO: {},
    innerWidth: width,
    innerHeight: height,
    visualViewport,
  };
  const context = vm.createContext({
    window,
    globalThis: window,
    document,
    console,
    setTimeout,
    clearTimeout,
  });
  const filePath = path.join(__dirname, "..", "content", "ui.js");
  vm.runInContext(fs.readFileSync(filePath, "utf8"), context, {
    filename: filePath,
  });
  return window.__CGO;
}

function elementWithRect(rect) {
  return {
    style: {},
    getBoundingClientRect() {
      return { ...rect };
    },
  };
}

test("settings panel stays inside a narrow viewport", () => {
  const CGO = loadUi({ width: 302, height: 500 });
  const panel = elementWithRect({ width: 286, height: 300 });
  const button = elementWithRect({ left: 240, right: 280, top: 120, bottom: 160 });

  const position = CGO.positionSettingsPanel(panel, button);

  assert.equal(panel.style.left, "16px");
  assert.equal(panel.style.top, "168px");
  assert.equal(panel.style.right, "auto");
  assert.equal(panel.style.maxWidth, "286px");
  assert.equal(panel.style.maxHeight, "484px");
  assert.equal(position.left + 286, 302);
});

test("settings panel moves above its anchor when there is not enough room below", () => {
  const CGO = loadUi({ width: 1000, height: 600 });
  const panel = elementWithRect({ width: 320, height: 300 });
  const button = elementWithRect({ left: 820, right: 860, top: 520, bottom: 560 });

  CGO.positionSettingsPanel(panel, button);

  assert.equal(panel.style.left, "680px");
  assert.equal(panel.style.top, "212px");
});

test("settings panel honors visual viewport offsets used during zoom", () => {
  const visualViewport = {
    offsetLeft: 40,
    offsetTop: 25,
    width: 240,
    height: 360,
  };
  const CGO = loadUi({ width: 1000, height: 800, visualViewport });
  const panel = elementWithRect({ width: 224, height: 344 });
  const button = elementWithRect({ left: 235, right: 275, top: 60, bottom: 100 });

  const position = CGO.positionSettingsPanel(panel, button);

  assert.equal(panel.style.left, "56px");
  assert.equal(panel.style.top, "33px");
  assert.equal(panel.style.maxWidth, "224px");
  assert.equal(panel.style.maxHeight, "344px");
  assert.equal(position.left, 56);
  assert.equal(position.top, 33);
});
