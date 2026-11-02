const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function makeMessage(id, role, text, metadata = {}) {
  return {
    id,
    author: { role },
    content: { content_type: "text", parts: [text] },
    metadata,
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
    fetch: fetchImpl,
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

test("export adapts history page size and keeps the last successful size", async () => {
  const initialUrl =
    "/backend-api/conversations/conversation-1?include_has_versions=true&num_turns=10";
  const requestedTurns = [];
  let hundredAttemptCount = 0;
  const harness = createPageHookHarness(async (url) => {
    const parsed = new URL(String(url), "https://chatgpt.com");
    const before = parsed.searchParams.get("before");
    const numTurns = Number(parsed.searchParams.get("num_turns"));
    requestedTurns.push(numTurns);

    if (before === "user-newest") {
      if (numTurns === 100 && hundredAttemptCount++ === 0) {
        throw new TypeError("temporary network failure");
      }
      if (numTurns === 100) return jsonResponse({ error: "too large" }, 413);
      if (numTurns === 50) return jsonResponse({ error: "too large" }, 422);
      if (numTurns === 20) return jsonResponse({ error: "invalid payload" });
      if (numTurns === 10) {
        return jsonResponse({
          messages: [makeMessage("user-middle", "user", "Middle question")],
          page_info: {
            start_cursor: "user-middle",
            end_cursor: "user-middle",
            has_previous_page: true,
            has_next_page: true,
          },
        });
      }
    }

    if (before === "user-middle" && numTurns === 10) {
      return jsonResponse({
        messages: [makeMessage("user-oldest", "user", "Oldest question")],
        page_info: {
          start_cursor: "user-oldest",
          end_cursor: "user-oldest",
          has_previous_page: false,
          has_next_page: true,
        },
      });
    }

    return jsonResponse({ error: "unexpected request" }, 404);
  });

  const initialPayload = {
    conversation_id: "conversation-1",
    current_node: "user-newest",
    messages: [makeMessage("user-newest", "user", "Newest question")],
    page_info: {
      start_cursor: "user-newest",
      end_cursor: "user-newest",
      has_previous_page: true,
      has_next_page: false,
    },
  };

  await harness.window.__CGO_MAIN_HOOK_API__.handleFetchResponse({
    args: [initialUrl],
    response: jsonResponse(initialPayload),
    url: initialUrl,
  });

  const complete = await harness.requestCache({ complete: true });
  assert.equal(complete.__cgo_history_complete, true);
  assert.deepEqual(Object.keys(complete.mapping), [
    "user-oldest",
    "user-middle",
    "user-newest",
  ]);
  assert.deepEqual(requestedTurns, [100, 100, 50, 20, 10, 10]);
});

test("export does not reduce page size after authentication failure", async () => {
  const initialUrl =
    "/backend-api/conversations/conversation-1?include_has_versions=true&num_turns=10";
  const requestedTurns = [];
  const harness = createPageHookHarness(async (url) => {
    const parsed = new URL(String(url), "https://chatgpt.com");
    requestedTurns.push(Number(parsed.searchParams.get("num_turns")));
    return jsonResponse({ error: "unauthorized" }, 401);
  });
  const initialPayload = {
    conversation_id: "conversation-1",
    current_node: "user-newest",
    messages: [makeMessage("user-newest", "user", "Newest question")],
    page_info: {
      start_cursor: "user-newest",
      end_cursor: "user-newest",
      has_previous_page: true,
      has_next_page: false,
    },
  };

  await harness.window.__CGO_MAIN_HOOK_API__.handleFetchResponse({
    args: [initialUrl],
    response: jsonResponse(initialPayload),
    url: initialUrl,
  });

  await assert.rejects(
    () => harness.requestCache({ complete: true }),
    /Conversation history request failed \(401\)/
  );
  assert.deepEqual(requestedTurns, [100]);
});

test("a legacy response cannot prune or replace a conversation using the paginated API", async () => {
  let resolvePaginatedFetch;
  const harness = createPageHookHarness(() => new Promise((resolve) => {
    resolvePaginatedFetch = resolve;
  }));
  const paginatedUrl = "/backend-api/conversations/conversation-1?num_turns=10";
  const legacyUrl = "/backend-api/conversation/conversation-1";
  const legacyPayload = {
    conversation_id: "conversation-1",
    current_node: "legacy-user",
    mapping: {
      "legacy-user": {
        id: "legacy-user",
        parent: null,
        children: [],
        message: makeMessage("legacy-user", "user", "Legacy question"),
      },
    },
  };
  const api = harness.window.__CGO_MAIN_HOOK_API__;
  const bootstrapPath = path.join(__dirname, "..", "page-bootstrap.js");
  vm.runInContext(fs.readFileSync(bootstrapPath, "utf8"), harness.context, {
    filename: bootstrapPath,
  });

  const pendingPaginatedResponse = harness.window.fetch(paginatedUrl);
  assert.ok(harness.postedMessages.some((message) =>
    message.type === "historyMode" && message.historyMode === "paginated"
  ));

  const pendingLegacy = await api.handleFetchResponse({
    args: [legacyUrl],
    response: jsonResponse(legacyPayload),
    url: legacyUrl,
  });
  assert.deepEqual(await pendingLegacy.json(), legacyPayload);
  assert.equal(
    harness.postedMessages.filter((message) => message.type === "analysis").length,
    0,
    "the older response must not publish legacy pruning mode"
  );

  const paginatedPayload = {
    conversation_id: "conversation-1",
    current_node: "paginated-user",
    messages: [makeMessage("paginated-user", "user", "Current question")],
    page_info: {
      start_cursor: "paginated-user",
      end_cursor: "paginated-user",
      has_previous_page: false,
      has_next_page: false,
    },
  };
  resolvePaginatedFetch(jsonResponse(paginatedPayload));
  assert.deepEqual(await (await pendingPaginatedResponse).json(), paginatedPayload);
  const analysisCount = harness.postedMessages.filter(
    (message) => message.type === "analysis"
  ).length;

  const lateLegacy = await api.handleFetchResponse({
    args: [legacyUrl],
    response: jsonResponse(legacyPayload),
    url: legacyUrl,
  });
  assert.deepEqual(await lateLegacy.json(), legacyPayload);
  assert.equal(
    harness.postedMessages.filter((message) => message.type === "analysis").length,
    analysisCount
  );

  const cached = await harness.requestCache();
  assert.equal(cached.__cgo_paginated_history, true);
  assert.ok(cached.mapping["paginated-user"]);
  assert.equal(cached.mapping["legacy-user"], undefined);

  harness.window.postMessage({
    type: "CGO_TRIM_META_REQUEST",
    conversationId: "conversation-1",
    secret: harness.window.__CGO_BRIDGE_SECRET__,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    harness.postedMessages.some((message) =>
      message.type === "initialPruneMeta" || message.type === "conversationHeadMeta"
    ),
    false
  );
});

test("a legacy full conversation is marked as history-complete", async () => {
  const harness = createPageHookHarness(async () => {
    throw new Error("the test should not issue its own history request");
  });
  const legacyUrl = "/backend-api/conversation/conversation-1";
  const legacyPayload = {
    conversation_id: "conversation-1",
    current_node: "legacy-user",
    mapping: {
      "legacy-user": {
        id: "legacy-user",
        parent: null,
        children: [],
        message: makeMessage("legacy-user", "user", "Legacy question"),
      },
    },
  };

  await harness.window.__CGO_MAIN_HOOK_API__.handleFetchResponse({
    args: [legacyUrl],
    response: jsonResponse(legacyPayload),
    url: legacyUrl,
  });

  const cached = await harness.requestCache();
  assert.equal(cached.__cgo_history_complete, true);
});

test("token statistics use plausible reported counts only for calibration", async () => {
  const harness = createPageHookHarness(async () => {
    throw new Error("the test should not issue its own history request");
  });
  const legacyUrl = "/backend-api/conversation/conversation-1";
  const user = makeMessage(
    "user-current",
    "user",
    "日本語の質問を含む現在の会話です"
  );
  const assistant = makeMessage(
    "assistant-current",
    "assistant",
    "Current answer",
    { token_count: 120, model_slug: "gpt-5-chat-latest" }
  );
  const offBranch = makeMessage(
    "assistant-old-branch",
    "assistant",
    "x".repeat(200000),
    { token_count: 50000 }
  );
  const payload = {
    conversation_id: "conversation-1",
    current_node: "assistant-current",
    mapping: {
      "user-current": {
        id: "user-current",
        parent: null,
        children: ["assistant-current", "assistant-old-branch"],
        message: user,
      },
      "assistant-current": {
        id: "assistant-current",
        parent: "user-current",
        children: [],
        message: assistant,
      },
      "assistant-old-branch": {
        id: "assistant-old-branch",
        parent: "user-current",
        children: [],
        message: offBranch,
      },
    },
  };

  await harness.window.__CGO_MAIN_HOOK_API__.handleFetchResponse({
    args: [legacyUrl],
    response: jsonResponse(payload),
    url: legacyUrl,
  });

  const result = harness.postedMessages
    .filter((message) => message.type === "autoAdjustResult")
    .at(-1);
  assert.ok(result);
  assert.equal(result.stats.activeTokenMessageCount, 2);
  assert.equal(result.stats.reportedMessageCount, 1);
  assert.equal(result.stats.reportedTokenCount, 120);
  assert.equal(result.stats.ignoredReportedMessageCount, 0);
  assert.ok(result.stats.estimatedTokenCount > 0);
  assert.ok(result.stats.tokenCount < 1000, "off-branch tokens must be excluded");
  assert.ok(result.stats.safeTokenCount > result.stats.tokenCount);
  assert.equal(result.stats.modelSlug, "gpt-5-chat-latest");
  assert.equal(result.stats.contextLimit, 128000);
  assert.equal(result.stats.contextLimitSource, "model");
  assert.equal(result.stats.historyComplete, true);
  assert.equal(result.stats.tokenConfidence, "medium");
  assert.ok(result.stats.autoAdjustScore > 0);
  assert.equal(result.stats.currentNodeRole, "assistant");
  assert.equal(result.stats.latestAssistantMessageId, "assistant-current");
  assert.equal(result.stats.streamDone, null);
  assert.equal(result.stats.latestAssistantPersisted, null);
});

test("token statistics ignore implausible reported counts instead of summing them", async () => {
  const harness = createPageHookHarness(async () => {
    throw new Error("the test should not issue its own history request");
  });
  const legacyUrl = "/backend-api/conversation/conversation-1";
  const payload = {
    conversation_id: "conversation-1",
    current_node: "assistant-current",
    mapping: {
      "user-current": {
        id: "user-current",
        parent: null,
        children: ["assistant-current"],
        message: makeMessage("user-current", "user", "Short question"),
      },
      "assistant-current": {
        id: "assistant-current",
        parent: "user-current",
        children: [],
        message: makeMessage(
          "assistant-current",
          "assistant",
          "Short answer",
          { token_count: 250000, model_slug: "unknown-model" }
        ),
      },
    },
  };

  await harness.window.__CGO_MAIN_HOOK_API__.handleFetchResponse({
    args: [legacyUrl],
    response: jsonResponse(payload),
    url: legacyUrl,
  });

  const result = harness.postedMessages
    .filter((message) => message.type === "autoAdjustResult")
    .at(-1);
  assert.ok(result);
  assert.equal(result.stats.reportedMessageCount, 0);
  assert.equal(result.stats.reportedTokenCount, 0);
  assert.equal(result.stats.ignoredReportedMessageCount, 1);
  assert.ok(result.stats.tokenCount < 1000);
  assert.equal(result.stats.contextLimitSource, "fallback");
  assert.equal(result.stats.tokenConfidence, "low");
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
