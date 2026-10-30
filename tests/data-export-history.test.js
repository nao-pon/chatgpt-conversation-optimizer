const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function makeConversation(messageIds, historyComplete) {
  const mapping = {};
  let parent = null;

  for (const id of messageIds) {
    mapping[id] = {
      id,
      parent,
      children: [],
      message: {
        id,
        author: { role: "user" },
        content: { content_type: "text", parts: [id] },
        metadata: {},
      },
    };

    if (parent) mapping[parent].children.push(id);
    parent = id;
  }

  const conversation = {
    conversation_id: "conversation-1",
    current_node: parent,
    mapping,
  };

  if (historyComplete !== undefined) {
    conversation.__cgo_paginated_history = true;
    conversation.__cgo_history_complete = historyComplete;
  }

  return conversation;
}

function loadDataModule() {
  const window = {
    __CGO: {
      getConversationIdFromLocation() {
        return "conversation-1";
      },
      log() {},
    },
  };
  const context = vm.createContext({
    window,
    globalThis: window,
    location: {
      origin: "https://chatgpt.com",
      pathname: "/c/conversation-1",
    },
    URL,
    URLSearchParams,
    Headers,
    Response,
    Request,
    fetch: async () => new Response("unavailable", { status: 503 }),
    structuredClone,
    setTimeout,
    clearTimeout,
    console,
  });

  const dataPath = path.join(__dirname, "..", "content", "data.js");
  vm.runInContext(fs.readFileSync(dataPath, "utf8"), context, {
    filename: dataPath,
  });

  return window.__CGO;
}

test("export completes history when a stream-only cache has no completion marker", async () => {
  const CGO = loadDataModule();
  const partial = makeConversation(["latest"], undefined);
  const complete = makeConversation(["oldest", "latest"], true);
  const requests = [];

  CGO.getConversationFromCache = async (_conversationId, options = {}) => {
    requests.push(options);
    return options.complete === true ? complete : partial;
  };

  const exported = await CGO.getConversationForExport("conversation-1");

  assert.equal(exported.__cgo_history_complete, true);
  assert.deepEqual(Object.keys(exported.mapping), ["oldest", "latest"]);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].complete, true);
});

test("export fails instead of silently using a markerless partial cache", async () => {
  const CGO = loadDataModule();
  const partial = makeConversation(["latest"], undefined);

  CGO.getConversationFromCache = async (_conversationId, options = {}) => {
    if (options.complete === true) {
      throw new Error("History completion unavailable");
    }
    return partial;
  };

  await assert.rejects(
    () => CGO.getConversationForExport("conversation-1"),
    /History completion unavailable/
  );
});
