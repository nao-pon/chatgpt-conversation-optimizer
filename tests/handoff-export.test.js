const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createHash, webcrypto } = require("node:crypto");

function loadHandoffPromptCatalogFixture() {
  return Object.fromEntries(["en", "ja"].map((locale) => {
    const messages = JSON.parse(fs.readFileSync(
      path.join(__dirname, "..", "_locales", locale, "messages.json"),
      "utf8"
    ));
    return [locale, {
      title: messages.handoff_prompt_document_title.message,
      languageHeading: messages.handoff_prompt_language_heading.message,
      body: messages.handoff_prompt_body.message,
    }];
  }));
}

function loadExportHelpers(overrides = {}) {
  const window = {
    __CGO: {
      DETECTION_LANG: "en",
      HANDOFF_PROMPT_CATALOG: loadHandoffPromptCatalogFixture(),
    },
  };
  if (overrides.crypto) window.crypto = overrides.crypto;
  if (overrides.chrome) window.chrome = overrides.chrome;
  const document = overrides.document || {};
  const context = vm.createContext({
    window,
    globalThis: window,
    document,
    location: { origin: "https://chatgpt.com" },
    navigator: { language: "en" },
    URL,
    Blob,
    TextEncoder,
    Headers,
    AbortController,
    fetch: overrides.fetch || fetch,
    setTimeout: overrides.setTimeout || setTimeout,
    clearTimeout,
    console,
    JSZip: overrides.JSZip,
  });
  const exportPath = path.join(__dirname, "..", "content", "export.js");
  vm.runInContext(fs.readFileSync(exportPath, "utf8"), context, {
    filename: exportPath,
  });
  return window.__CGO;
}

test("handoff files split at message boundaries and preserve oversized messages", () => {
  const CGO = loadExportHelpers();
  const messages = [
    { id: "user-1", role: "user", text: "あ".repeat(800) },
    { id: "assistant-1", role: "assistant", text: "い".repeat(800) },
    { id: "user-2", role: "user", text: "う".repeat(1500) },
  ];

  const files = CGO.buildConversationHandoffFiles({
    conversationId: "conversation-1",
    title: "Fixture",
    language: "ja",
    targetTokens: 1000,
    exportedAt: "2026-11-15T00:00:00.000Z",
    messages,
  });

  assert.equal(files.chunks.length, 3);
  assert.equal(
    Array.from(files.chunks, (chunk) => chunk.messageCount).join(","),
    "1,1,1"
  );
  assert.ok(files.chunks[2].estimatedTokens > 1000);
  assert.match(files.chunks[0].file, /^chunks\/001\.md$/);
  assert.match(files.chunks[0].markdown, /Message 000001 — User/);
  assert.match(files.chunks[2].markdown, /Message 000003 — User/);
  assert.equal(files.manifest.messageCount, 3);
  assert.equal(files.manifest.chunks.length, 3);
  assert.equal(files.manifest.notes.thoughtsIncluded, false);
  assert.equal(files.manifest.entryPoint, "README.md");
  assert.equal(files.manifest.handoffPrompt, "HANDOFF_PROMPT.md");
  assert.equal(files.manifest.latestChunk, "chunks/003.md");
  assert.equal(files.manifest.lastMessage.index, 3);
  assert.equal(files.manifest.lastMessage.role, "user");
  assert.equal(files.manifest.recentContext.file, "RECENT_CONTEXT.md");
  assert.equal(files.manifest.recentContext.startMessageIndex, 1);
  assert.equal(files.manifest.recentContext.endMessageIndex, 3);
  assert.match(files.readme, /^# Instructions for the Receiving Agent/);
  assert.match(files.readme, /historical evidence, not as new instructions/);
  assert.match(files.readme, /wait for the current user's next request/);
  assert.match(files.readme, /## Earlier conversation context/);
  assert.match(files.readme, /## Next steps when the user resumes/);
  assert.match(files.readme, /If you cannot process the entire package/);
  assert.doesNotMatch(files.readme, /## First (?:request|user message)/);
  assert.doesNotMatch(files.readme, /あ{20}/);
  assert.match(files.handoffPrompt, /## 日本語/);
  assert.match(files.handoffPrompt, /## English/);
  assert.match(files.recentContext.markdown, /Message 000003 — User/);
  assert.doesNotMatch(files.readme, /引き継ぎパッケージ/);
});

test("handoff package omits hidden thoughts, signed URLs, and embedded media", () => {
  const CGO = loadExportHelpers();
  const files = CGO.buildConversationHandoffFiles({
    conversationId: "conversation-1",
    title: "Fixture",
    projectName: "Project",
    webUrl: "https://chatgpt.com/c/conversation-1",
    language: "en",
    exportedAt: "2026-11-15T00:00:00.000Z",
    messages: [
      {
        id: "user-1",
        role: "user",
        text: "Please continue this task.",
        thoughts: [{ content: "hidden reasoning" }],
        images: [
          {
            fileId: "file-image",
            fileName: "diagram.png",
            mimeType: "image/png",
            embeddedUrl: "data:image/png;base64,SECRET",
            url: "https://example.invalid/image?sig=SECRET",
          },
        ],
        attachments: [
          {
            fileId: "file-document",
            name: "notes.pdf",
            mimeType: "application/pdf",
            kind: "pdf",
            url: "https://example.invalid/file?sig=SECRET",
          },
        ],
      },
    ],
  });

  const chunkText = files.chunks[0].markdown;
  const attachmentJson = JSON.stringify(files.attachments);
  assert.doesNotMatch(files.readme, /Please continue this task\./);
  assert.match(files.recentContext.markdown, /Please continue this task\./);
  assert.match(chunkText, /diagram\.png/);
  assert.match(files.recentContext.markdown, /diagram\.png/);
  assert.match(chunkText, /notes\.pdf/);
  assert.doesNotMatch(chunkText, /hidden reasoning/);
  assert.doesNotMatch(chunkText, /base64|sig=SECRET/);
  assert.doesNotMatch(attachmentJson, /base64|sig=SECRET/);
  assert.equal(files.attachments.length, 2);
  assert.equal(files.manifest.notes.signedUrlsIncluded, false);
});

test("handoff summary detection uses the newest assistant attachment and accepts numbered names", () => {
  const CGO = loadExportHelpers();
  const messages = [
    {
      id: "user-1",
      role: "user",
      attachments: [{ name: "handoff-summary.md" }],
    },
    {
      id: "assistant-1",
      role: "assistant",
      attachments: [{ name: "handoff-summary.md" }],
    },
    {
      id: "assistant-2",
      role: "assistant",
      attachments: [{ name: "handoff-summary（2）.md" }],
    },
  ];

  assert.equal(CGO.isHandoffSummaryFileName("handoff-summary (1).md"), true);
  assert.equal(CGO.isHandoffSummaryFileName("handoff-summary（2）.md"), true);
  assert.equal(CGO.isHandoffSummaryFileName("handoff-summary.txt"), false);
  const match = CGO.findLatestHandoffSummaryAttachment(messages);
  assert.equal(match.message.id, "assistant-2");
  assert.equal(match.attachment.name, "handoff-summary（2）.md");
});

test("handoff manifest records an imported cumulative summary", () => {
  const CGO = loadExportHelpers();
  const files = CGO.buildConversationHandoffFiles({
    conversationId: "conversation-2",
    title: "Continued work",
    messages: [{ id: "user-1", role: "user", text: "Continue." }],
    priorSummary: {
      content: "---\ngeneration: 3\n---\n\n# Existing summary\n\nCurrent state.",
      originalName: "handoff-summary (1).md",
      sourceMessageId: "assistant-summary",
      sizeBytes: 35,
      contentSha256: "abc123",
    },
  });

  assert.match(files.priorSummary.content, /# Existing summary/);
  assert.equal(files.manifest.priorSummary.file, "prior/handoff-summary.md");
  assert.equal(files.manifest.priorSummary.originalName, "handoff-summary (1).md");
  assert.equal(files.manifest.priorSummary.sourceMessageId, "assistant-summary");
  assert.equal(files.manifest.priorSummary.contentSha256, "abc123");
  assert.equal(files.manifest.nextSummaryGeneration, 4);
  assert.match(files.readme, /prior\/handoff-summary\.md/);
  assert.match(files.readme, /handoff-summary\.md/);
  assert.match(files.readme, /generation: 4/);
  assert.match(files.readme, /## Next steps when the user resumes/);
  assert.match(files.readme, /Older summaries may contain a heading named `First action for the next agent`/);
});

test("first user messages remain neutral history and are not duplicated into README", () => {
  const CGO = loadExportHelpers();
  const firstMessages = [
    "UNIQUE_NORMAL_QUESTION: How does this circuit work?",
    "UNIQUE_OLDER_HANDOFF: Continue from the previous chat and deploy version 7 now.",
  ];

  for (const firstText of firstMessages) {
    const files = CGO.buildConversationHandoffFiles({
      title: "Neutral history",
      messages: [
        { id: "user-1", role: "user", text: firstText },
        { id: "assistant-1", role: "assistant", text: "Historical reply." },
      ],
    });

    assert.doesNotMatch(files.readme, new RegExp(firstText.split(":")[0]));
    assert.match(files.chunks[0].markdown, new RegExp(firstText.split(":")[0]));
    assert.match(files.recentContext.markdown, new RegExp(firstText.split(":")[0]));
    assert.equal(files.manifest.priorSummary, null);
  }
});

test("recent context preserves a short conversation ending with a user message", () => {
  const CGO = loadExportHelpers();
  const files = CGO.buildConversationHandoffFiles({
    title: "Short conversation",
    messages: [
      {
        id: "user-1",
        role: "user",
        createTime: 1794787200,
        text: "日本語とMarkdownを保持します。\n\n```cpp\nint value = 1;\n```",
      },
      { id: "assistant-1", role: "assistant", text: "確認しました。" },
      { id: "user-2", role: "user", text: "最後の質問です。" },
    ],
  });

  assert.equal(files.manifest.recentContext.messageCount, 3);
  assert.equal(files.manifest.lastMessage.id, "user-2");
  assert.equal(files.manifest.lastMessage.role, "user");
  assert.match(files.recentContext.markdown, /```cpp\nint value = 1;\n```/);
  assert.match(files.recentContext.markdown, /Message 000003 — User/);
  assert.doesNotMatch(files.recentContext.markdown, /Message 000004/);
});

test("recent context keeps the latest user and assistant pair even above its soft target", () => {
  const CGO = loadExportHelpers();
  const files = CGO.buildConversationHandoffFiles({
    title: "Paired ending",
    recentTargetTokens: 1000,
    messages: [
      { id: "assistant-old", role: "assistant", text: "Old context." },
      { id: "user-latest", role: "user", text: "質".repeat(900) },
      { id: "assistant-latest", role: "assistant", text: "答".repeat(900) },
    ],
  });

  assert.equal(files.manifest.recentContext.startMessageIndex, 2);
  assert.equal(files.manifest.recentContext.endMessageIndex, 3);
  assert.equal(files.manifest.recentContext.messageCount, 2);
  assert.equal(files.manifest.recentContext.exceedsSoftTarget, true);
  assert.match(files.recentContext.markdown, /Message 000002 — User/);
  assert.match(files.recentContext.markdown, /Message 000003 — Assistant/);
  assert.doesNotMatch(files.recentContext.markdown, /Old context/);
});

test("recent context retains an extremely long latest message without truncation", () => {
  const CGO = loadExportHelpers();
  const latestText = "長".repeat(12000);
  const files = CGO.buildConversationHandoffFiles({
    title: "Oversized latest message",
    messages: [{ id: "user-long", role: "user", text: latestText }],
  });

  assert.equal(files.manifest.recentContext.messageCount, 1);
  assert.equal(files.manifest.recentContext.exceedsSoftTarget, true);
  assert.equal((files.recentContext.markdown.match(/長/g) || []).length, 12000);
  assert.doesNotMatch(files.recentContext.markdown, /truncated|omitted/i);
});

test("bilingual handoff prompt generation is reusable and honors preferred ordering", () => {
  const CGO = loadExportHelpers();
  const japaneseFirst = CGO.buildHandoffPromptMarkdown("ja");
  const englishFirst = CGO.buildHandoffPromptMarkdown("en-US");
  const japaneseOnly = CGO.buildHandoffPromptMarkdown("ja", { bilingual: false });
  const englishOnly = CGO.buildHandoffPromptMarkdown("en", { bilingual: false });

  assert.ok(japaneseFirst.indexOf("## 日本語") < japaneseFirst.indexOf("## English"));
  assert.ok(englishFirst.indexOf("## English") < englishFirst.indexOf("## 日本語"));
  assert.match(japaneseFirst, /私の次の依頼を待ってください/);
  assert.match(englishFirst, /wait for my next request/);
  assert.match(japaneseFirst, /すべてのファイルまたはパッケージ全体を処理できない場合/);
  assert.match(englishFirst, /If you cannot process every file or the entire package/);
  assert.match(japaneseOnly, /^# 会話引き継ぎ依頼/);
  assert.doesNotMatch(japaneseOnly, /## English/);
  assert.match(englishOnly, /^# Conversation Handoff Request/);
  assert.doesNotMatch(englishOnly, /## 日本語/);
});

test("handoff prompt catalog loads both packaged locale resources", async () => {
  const calls = [];
  const localeMessages = {
    en: {
      handoff_prompt_document_title: { message: "English title" },
      handoff_prompt_language_heading: { message: "English" },
      handoff_prompt_body: { message: "English body" },
    },
    ja: {
      handoff_prompt_document_title: { message: "日本語タイトル" },
      handoff_prompt_language_heading: { message: "日本語" },
      handoff_prompt_body: { message: "日本語本文" },
    },
  };
  const CGO = loadExportHelpers({
    chrome: {
      runtime: {
        getURL(resource) {
          return `chrome-extension://fixture/${resource}`;
        },
      },
    },
    async fetch(url) {
      calls.push(url);
      const locale = url.includes("/ja/") ? "ja" : "en";
      return {
        ok: true,
        async json() { return localeMessages[locale]; },
      };
    },
  });
  delete CGO.HANDOFF_PROMPT_CATALOG;

  const catalog = await CGO.loadHandoffPromptCatalog();

  assert.equal(catalog.en.body, "English body");
  assert.equal(catalog.ja.body, "日本語本文");
  assert.equal(calls.length, 2);
  assert.match(
    CGO.buildHandoffPromptMarkdown("ja", { catalog }),
    /## 日本語\n\n日本語本文/
  );
});

test("hundreds of messages keep exact chunk coverage and a ten-message recent window", () => {
  const CGO = loadExportHelpers();
  const messages = Array.from({ length: 305 }, (_value, index) => ({
    id: `message-${index + 1}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text: `UNIQUE_MESSAGE_${String(index + 1).padStart(3, "0")}`,
  }));
  const files = CGO.buildConversationHandoffFiles({
    title: "Long conversation",
    targetTokens: 1000,
    messages,
  });

  assert.equal(
    files.chunks.reduce((sum, chunk) => sum + chunk.messageCount, 0),
    305
  );
  assert.equal(files.chunks[0].startMessageIndex, 1);
  assert.equal(files.chunks.at(-1).endMessageIndex, 305);
  for (let index = 1; index < files.chunks.length; index += 1) {
    assert.equal(
      files.chunks[index].startMessageIndex,
      files.chunks[index - 1].endMessageIndex + 1
    );
  }
  const allChunkMarkdown = files.chunks.map((chunk) => chunk.markdown).join("\n");
  assert.equal((allChunkMarkdown.match(/^## Message /gm) || []).length, 305);
  assert.equal(files.manifest.recentContext.startMessageIndex, 296);
  assert.equal(files.manifest.recentContext.endMessageIndex, 305);
  assert.equal(files.manifest.recentContext.messageCount, 10);
  assert.match(files.recentContext.markdown, /UNIQUE_MESSAGE_296/);
  assert.match(files.recentContext.markdown, /UNIQUE_MESSAGE_305/);
  assert.doesNotMatch(files.recentContext.markdown, /UNIQUE_MESSAGE_295/);
  assert.equal(files.manifest.latestChunk, files.chunks.at(-1).file);
});

test("SHA-256 uses the exact final Blob bytes and formats a sidecar", async () => {
  const CGO = loadExportHelpers({ crypto: webcrypto });
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10]);
  const blob = new Blob([bytes], { type: "application/zip" });
  const expected = createHash("sha256").update(bytes).digest("hex");

  const actual = await CGO.sha256Blob(blob);

  assert.equal(actual, expected);
  assert.equal(
    CGO.buildSha256Sidecar(actual, "handoff.zip"),
    `${expected}  handoff.zip\n`
  );
});

test("handoff ZIP export writes the package files and triggers a download", async () => {
  let latestZip = null;
  const downloads = [];
  let appendedCount = 0;
  class FakeZip {
    constructor() {
      this.files = new Map();
      latestZip = this;
    }
    file(name, value) {
      this.files.set(name, value);
      return this;
    }
    async generateAsync() {
      return new Blob(["fake zip"], { type: "application/zip" });
    }
  }
  const document = {
    title: "Fixture - ChatGPT",
    body: {
      appendChild(node) {
        if (node) appendedCount += 1;
      },
    },
    createElement(tagName) {
      assert.equal(tagName, "a");
      return {
        href: "",
        download: "",
        click() { downloads.push(this.download); },
        remove() {},
      };
    },
  };
  const CGO = loadExportHelpers({
    document,
    JSZip: FakeZip,
    crypto: webcrypto,
    setTimeout(callback, delay) {
      if (delay <= 5000) callback();
      return 1;
    },
  });
  const message = {
    id: "user-1",
    role: "user",
    text: "Continue the task.",
    images: [],
    attachments: [],
  };
  const summaryMessage = {
    id: "assistant-summary",
    role: "assistant",
    text: "I created the summary.",
    images: [],
    attachments: [
      {
        name: "handoff-summary (1).md",
        url: "data:text/markdown,%23%20Prior%20summary%0A%0AState.",
      },
    ],
  };
  CGO.getConversationIdFromLocation = () => "conversation-1";
  CGO.getConversationForExport = async () => ({
    conversation_id: "conversation-1",
    title: "Fixture",
    current_node: "user-1",
    mapping: { "user-1": { message } },
  });
  CGO.buildExportChain = () => [message, summaryMessage];
  CGO.normalizeMessagesForExport = () => [message, summaryMessage];
  CGO.buildDomAssetMap = () => [];
  CGO.mergeMessagesWithDomAssets = (messages) => messages;
  CGO.getLastAuthorizationFromPage = async () => "";
  CGO.resolveAttachmentUrlsWithDownloadApi = async () => {};
  CGO.buildChatgptWebConversationUrl = () =>
    "https://chatgpt.com/c/conversation-1";
  CGO.buildSafeFilename = (name, extension) => `${name}.${extension}`;
  CGO.setToolbarButtonText = () => {};
  CGO.t = (key) => key;
  CGO.log = () => {};

  await CGO.exportCurrentConversationAsHandoffZip(null);

  assert.ok(latestZip);
  assert.equal(latestZip.files.has("README.md"), true);
  assert.equal(latestZip.files.has("HANDOFF_PROMPT.md"), true);
  assert.equal(latestZip.files.has("RECENT_CONTEXT.md"), true);
  assert.equal(latestZip.files.has("manifest.json"), true);
  assert.equal(latestZip.files.has("attachments.json"), true);
  assert.equal(latestZip.files.has("chunks/001.md"), true);
  assert.equal(latestZip.files.has("prior/handoff-summary.md"), true);
  assert.match(latestZip.files.get("prior/handoff-summary.md"), /Prior summary/);
  const manifest = JSON.parse(latestZip.files.get("manifest.json"));
  assert.equal(manifest.entryPoint, "README.md");
  assert.equal(manifest.recentContext.file, "RECENT_CONTEXT.md");
  assert.equal(manifest.latestChunk, "chunks/001.md");
  assert.equal(manifest.lastMessage.id, "assistant-summary");
  assert.equal(manifest.integrity.algorithm, "SHA-256");
  assert.equal(manifest.integrity.scope, "final ZIP byte sequence");
  assert.equal(manifest.integrity.digestEmbedded, false);
  assert.equal(latestZip.files.has(manifest.integrity.sidecarFile), false);
  assert.equal(appendedCount, 2);
  assert.equal(downloads.length, 2);
  assert.match(downloads[0], /handoff\.zip$/);
  assert.equal(downloads[1], `${downloads[0]}.sha256`);
});
