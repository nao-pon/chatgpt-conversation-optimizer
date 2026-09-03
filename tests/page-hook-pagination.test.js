const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function makeMessage(id, role, text) {
  return {
    id,
    author: { role },
    content: { content_type: "text", parts: [text] },
    metadata: {},
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createPageHookHarness(fetchImpl) {
  const listeners = new Map();
  const idleCallbacks = [];
  const postedMessages = [];

  const window = {
    __CGO_ORIGINAL_FETCH__: fetchImpl,
    addEventListener(type, listener) {
      const current = listeners.get(type) || [];
      current.push(listener);
      listeners.set(type, current);
    },
    removeEventListener(type, listener) {
      listeners.set(
        type,
        (listeners.get(type) || []).filter((candidate) => candidate !== listener)
      );
    },
    postMessage(data) {
      postedMessages.push(data);
      queueMicrotask(() => {
        for (const listener of listeners.get("message") || []) {
          listener({ source: window, data });
        }
      });
    },
    requestIdleCallback(callback) {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
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

  async function requestCache({ complete = false } = {}) {
    const requestId = `test-${Date.now()}-${Math.random()}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("cache response timed out")),
        2000
      );
      const listener = (event) => {
        if (
          event.data?.type !== "CGO_EXPORT_CACHE_RESPONSE" ||
          event.data?.requestId !== requestId
        ) {
          return;
        }
        clearTimeout(timeout);
        window.removeEventListener("message", listener);
        if (event.data.error) {
          reject(new Error(event.data.error));
        } else {
          resolve(event.data.data);
        }
      };
      window.addEventListener("message", listener);
      window.postMessage({
        type: "CGO_EXPORT_CACHE_REQUEST",
        requestId,
        conversationId: "conversation-1",
        complete,
        secret: window.__CGO_BRIDGE_SECRET__,
      });
    });
  }

  return { context, window, postedMessages, idleCallbacks, requestCache };
}

test("paginated ChatGPT history is accumulated for export without rewriting responses", async () => {
  const initialUrl =
    "/backend-api/conversations/conversation-1?include_has_versions=true&num_turns=10";
  const middlePage = {
    messages: [
      makeMessage("user-middle", "user", "Middle question"),
      makeMessage("assistant-middle", "assistant", "Middle answer"),
    ],
    page_info: {
      start_cursor: "user-middle",
      end_cursor: "assistant-middle",
      has_previous_page: true,
      has_next_page: true,
    },
  };
  const oldestPage = {
    messages: [
      makeMessage("system-oldest", "system", "Hidden context"),
      makeMessage("user-oldest", "user", "Oldest question"),
      makeMessage("assistant-oldest", "assistant", "Oldest answer"),
    ],
    page_info: {
      start_cursor: "system-oldest",
      end_cursor: "assistant-oldest",
      has_previous_page: false,
      has_next_page: true,
    },
  };
  const fetchUrls = [];
  const harness = createPageHookHarness(async (url) => {
    fetchUrls.push(String(url));
    const before = new URL(String(url), "https://chatgpt.com").searchParams.get(
      "before"
    );
    if (before === "user-newest") return jsonResponse(middlePage);
    if (before === "user-middle") return jsonResponse(oldestPage);
    return jsonResponse({ error: "unexpected request" }, 404);
  });

  const initialPayload = {
    title: "Paginated fixture",
    conversation_id: "conversation-1",
    current_node: "assistant-newest",
    messages: [
      makeMessage("user-newest", "user", "Newest question"),
      makeMessage("assistant-newest", "assistant", "Newest answer"),
    ],
    page_info: {
      start_cursor: "user-newest",
      end_cursor: "assistant-newest",
      has_previous_page: true,
      has_next_page: false,
    },
  };
  initialPayload.messages[0].metadata.attachments = [
    {
      id: "file_fixture",
      name: "fixture.pdf",
      mime_type: "application/pdf",
    },
  ];
  const originalResponse = jsonResponse(initialPayload);

  const returnedResponse = await harness.window.__CGO_MAIN_HOOK_API__.handleFetchResponse({
    args: [initialUrl],
    response: originalResponse,
    url: initialUrl,
  });
  const returnedPayload = await returnedResponse.json();
  assert.deepEqual(returnedPayload, initialPayload);

  const partial = await harness.requestCache();
  assert.equal(partial.__cgo_paginated_history, true);
  assert.equal(partial.__cgo_history_complete, false);
  assert.deepEqual(Object.keys(partial.mapping), [
    "user-newest",
    "assistant-newest",
  ]);
  assert.ok(
    harness.postedMessages.some((message) => message.type === "analysis"),
    "the initial response should reveal the export UI"
  );
  assert.equal(
    harness.postedMessages.find((message) => message.type === "analysis")
      ?.summary?.historyMode,
    "paginated"
  );
  assert.equal(
    harness.postedMessages.find((message) => message.type === "autoAdjustResult")
      ?.historyMode,
    "paginated"
  );

  harness.window.__CGO = {
    log() {},
  };
  const contentDataPath = path.join(__dirname, "..", "content", "data.js");
  vm.runInContext(fs.readFileSync(contentDataPath, "utf8"), harness.context, {
    filename: contentDataPath,
  });

  const progressMessageCounts = [];
  const complete = await harness.window.__CGO.getConversationForExport(
    "conversation-1",
    {
      onHistoryProgress({ messageCount }) {
        progressMessageCounts.push(messageCount);
      },
    }
  );
  assert.equal(complete.__cgo_history_complete, true);
  assert.equal(complete.__cgo_history_page_count, 3);
  assert.equal(complete.current_node, "assistant-newest");
  assert.deepEqual(Object.keys(complete.mapping), [
    "system-oldest",
    "user-oldest",
    "assistant-oldest",
    "user-middle",
    "assistant-middle",
    "user-newest",
    "assistant-newest",
  ]);
  assert.deepEqual(progressMessageCounts, [2, 4, 7]);
  assert.equal(complete.mapping["system-oldest"].parent, null);
  assert.deepEqual(complete.mapping["system-oldest"].children, ["user-oldest"]);
  assert.equal(complete.mapping["assistant-middle"].children[0], "user-newest");
  assert.deepEqual(
    complete.mapping["user-newest"].message.metadata.attachments,
    initialPayload.messages[0].metadata.attachments
  );
  assert.deepEqual(
    fetchUrls.map((url) =>
      new URL(url, "https://chatgpt.com").searchParams.get("before")
    ),
    ["user-newest", "user-middle"]
  );
  assert.equal(
    harness.postedMessages.some((message) => message.type === "conversationHeadMeta"),
    false,
    "paginated history should not publish legacy head restoration metadata"
  );

  const pruneMetaCount = harness.postedMessages.filter(
    (message) => message.type === "initialPruneMeta"
  ).length;
  harness.window.postMessage({
    type: "CGO_TRIM_META_REQUEST",
    conversationId: "conversation-1",
    secret: harness.window.__CGO_BRIDGE_SECRET__,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    harness.postedMessages.filter((message) => message.type === "initialPruneMeta")
      .length,
    pruneMetaCount,
    "paginated history should not restore legacy omission metadata"
  );

  const refreshedMiddlePage = structuredClone(middlePage);
  refreshedMiddlePage.messages[0].content.parts = ["Middle question refreshed"];
  const repeatedMiddleUrl =
    "/backend-api/conversations/conversation-1/messages?before=user-newest&include_has_versions=true&num_turns=10";
  const repeatedMiddleResponse =
    await harness.window.__CGO_MAIN_HOOK_API__.handleFetchResponse({
      args: [repeatedMiddleUrl],
      response: jsonResponse(refreshedMiddlePage),
      url: repeatedMiddleUrl,
    });
  assert.deepEqual(await repeatedMiddleResponse.json(), refreshedMiddlePage);

  const afterRepeatedMiddle = await harness.requestCache();
  assert.equal(
    afterRepeatedMiddle.__cgo_history_complete,
    true,
    "an interior browser page must not roll completed history back"
  );
  assert.equal(afterRepeatedMiddle.__cgo_history_next_before, "");
  assert.equal(afterRepeatedMiddle.__cgo_history_page_count, 3);
  assert.deepEqual(Object.keys(afterRepeatedMiddle.mapping), [
    "system-oldest",
    "user-oldest",
    "assistant-oldest",
    "user-middle",
    "assistant-middle",
    "user-newest",
    "assistant-newest",
  ]);
  assert.equal(
    afterRepeatedMiddle.mapping["user-middle"].message.content.parts[0],
    "Middle question refreshed",
    "a repeated page may refresh message data without moving its ids"
  );

  const repeatProgressCounts = [];
  await harness.window.__CGO.getConversationForExport("conversation-1", {
    onHistoryProgress({ messageCount }) {
      repeatProgressCounts.push(messageCount);
    },
  });
  assert.deepEqual(repeatProgressCounts, []);
  assert.equal(
    fetchUrls.length,
    2,
    "export must not refetch history after an interior browser request"
  );

  const refreshedPayload = {
    ...initialPayload,
    current_node: "assistant-added",
    messages: [
      ...initialPayload.messages,
      makeMessage("user-added", "user", "A new question"),
      makeMessage("assistant-added", "assistant", "A new answer"),
    ],
    page_info: {
      start_cursor: "user-newest",
      end_cursor: "assistant-added",
      has_previous_page: true,
      has_next_page: false,
    },
  };
  await harness.window.__CGO_MAIN_HOOK_API__.handleFetchResponse({
    args: [initialUrl],
    response: jsonResponse(refreshedPayload),
    url: initialUrl,
  });

  const refreshed = await harness.requestCache();
  assert.equal(refreshed.__cgo_history_complete, true);
  assert.equal(refreshed.current_node, "assistant-added");
  assert.equal(Object.keys(refreshed.mapping).length, 9);
  assert.equal(fetchUrls.length, 2, "known older pages should not be fetched again");
});

test("an interior browser page does not move an incomplete history frontier backward", async () => {
  const harness = createPageHookHarness(async () => {
    throw new Error("the test should not issue its own history request");
  });
  const initialUrl =
    "/backend-api/conversations/conversation-1?include_has_versions=true&num_turns=10";
  const middleUrl =
    "/backend-api/conversations/conversation-1/messages?before=user-newest&include_has_versions=true&num_turns=10";
  const oldestUrl =
    "/backend-api/conversations/conversation-1/messages?before=user-middle&include_has_versions=true&num_turns=10";
  const initialPayload = {
    conversation_id: "conversation-1",
    current_node: "assistant-newest",
    messages: [
      makeMessage("user-newest", "user", "Newest question"),
      makeMessage("assistant-newest", "assistant", "Newest answer"),
    ],
    page_info: {
      start_cursor: "user-newest",
      end_cursor: "assistant-newest",
      has_previous_page: true,
      has_next_page: false,
    },
  };
  const middlePayload = {
    messages: [
      makeMessage("user-middle", "user", "Middle question"),
      makeMessage("assistant-middle", "assistant", "Middle answer"),
    ],
    page_info: {
      start_cursor: "user-middle",
      end_cursor: "assistant-middle",
      has_previous_page: true,
      has_next_page: true,
    },
  };
  const oldestPayload = {
    messages: [
      makeMessage("user-oldest", "user", "Oldest question"),
      makeMessage("assistant-oldest", "assistant", "Oldest answer"),
    ],
    page_info: {
      start_cursor: "user-oldest",
      end_cursor: "assistant-oldest",
      has_previous_page: false,
      has_next_page: true,
    },
  };

  for (const [url, payload] of [
    [initialUrl, initialPayload],
    [middleUrl, middlePayload],
    [middleUrl, middlePayload],
  ]) {
    await harness.window.__CGO_MAIN_HOOK_API__.handleFetchResponse({
      args: [url],
      response: jsonResponse(payload),
      url,
    });
  }

  const afterRepeatedMiddle = await harness.requestCache();
  assert.equal(afterRepeatedMiddle.__cgo_history_complete, false);
  assert.equal(afterRepeatedMiddle.__cgo_history_next_before, "user-middle");
  assert.equal(afterRepeatedMiddle.__cgo_history_page_count, 2);
  assert.deepEqual(Object.keys(afterRepeatedMiddle.mapping), [
    "user-middle",
    "assistant-middle",
    "user-newest",
    "assistant-newest",
  ]);

  await harness.window.__CGO_MAIN_HOOK_API__.handleFetchResponse({
    args: [oldestUrl],
    response: jsonResponse(oldestPayload),
    url: oldestUrl,
  });
  const complete = await harness.requestCache();
  assert.equal(complete.__cgo_history_complete, true);
  assert.equal(complete.__cgo_history_next_before, "");
  assert.deepEqual(Object.keys(complete.mapping), [
    "user-oldest",
    "assistant-oldest",
    "user-middle",
    "assistant-middle",
    "user-newest",
    "assistant-newest",
  ]);
});
