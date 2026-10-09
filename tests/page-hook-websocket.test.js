const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function createPageHookHarness() {
  const windowListeners = new Map();

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances = [];

    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = FakeWebSocket.OPEN;
      this.sent = [];
      this.listeners = new Map();
      FakeWebSocket.instances.push(this);
    }

    send(data) {
      this.sent.push(data);
      if (this.readyState === FakeWebSocket.CONNECTING) {
        throw new DOMException("Still connecting", "InvalidStateError");
      }
    }

    addEventListener(type, listener) {
      const current = this.listeners.get(type) || [];
      current.push(listener);
      this.listeners.set(type, current);
    }
  }

  const fetchImpl = async () =>
    new Response("{}", {
      headers: { "content-type": "application/json" },
    });

  const window = {
    __CGO_ORIGINAL_FETCH__: fetchImpl,
    fetch: fetchImpl,
    WebSocket: FakeWebSocket,
    addEventListener(type, listener) {
      const current = windowListeners.get(type) || [];
      current.push(listener);
      windowListeners.set(type, current);
    },
    removeEventListener(type, listener) {
      windowListeners.set(
        type,
        (windowListeners.get(type) || []).filter(
          (candidate) => candidate !== listener
        )
      );
    },
    postMessage() {},
    requestIdleCallback() {
      return 1;
    },
  };

  const context = vm.createContext({
    window,
    globalThis: window,
    location: {
      origin: "https://chatgpt.com",
      pathname: "/c/conversation-1",
    },
    navigator: {},
    URL,
    URLSearchParams,
    Headers,
    Response,
    Request,
    Blob,
    DOMException,
    TextDecoder,
    structuredClone,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    console,
  });

  const hookPath = path.join(__dirname, "..", "page-hook.js");
  vm.runInContext(fs.readFileSync(hookPath, "utf8"), context, {
    filename: hookPath,
  });

  return { FakeWebSocket, window };
}

function createTrackedBlob() {
  let textCalls = 0;
  const blob = new Blob([JSON.stringify({ type: "subscribe" })]);
  blob.text = async () => {
    textCalls += 1;
    return JSON.stringify({ type: "subscribe" });
  };

  return {
    blob,
    get textCalls() {
      return textCalls;
    },
  };
}

test("WebSocket send is parsed only while the socket is open", async () => {
  const { FakeWebSocket, window } = createPageHookHarness();
  const socket = new window.WebSocket("wss://example.test/socket");
  const nativeSocket = FakeWebSocket.instances[0];

  const openPayload = createTrackedBlob();
  socket.send(openPayload.blob);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(nativeSocket.sent.length, 1);
  assert.equal(openPayload.textCalls, 1);

  for (const readyState of [FakeWebSocket.CLOSING, FakeWebSocket.CLOSED]) {
    socket.readyState = readyState;
    const inactivePayload = createTrackedBlob();

    assert.doesNotThrow(() => socket.send(inactivePayload.blob));
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(nativeSocket.sent.length, 1);
    assert.equal(inactivePayload.textCalls, 0);
  }
});

test("WebSocket send preserves the native CONNECTING error", () => {
  const { FakeWebSocket, window } = createPageHookHarness();
  const socket = new window.WebSocket("wss://example.test/socket");
  const nativeSocket = FakeWebSocket.instances[0];
  socket.readyState = FakeWebSocket.CONNECTING;

  assert.throws(
    () => socket.send("pending"),
    (error) => error?.name === "InvalidStateError"
  );
  assert.deepEqual(nativeSocket.sent, ["pending"]);
});
