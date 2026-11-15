const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { createHash, webcrypto } = require("node:crypto");

function loadExportHelpers(overrides = {}) {
  const window = {
    __CGO: {
      DETECTION_LANG: "en",
    },
  };
  if (overrides.crypto) window.crypto = overrides.crypto;
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
    fetch,
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
  assert.match(files.readme, /^# Instructions for the Receiving Agent/);
  assert.match(files.readme, /Respond in the language the user normally uses/);
  assert.match(files.readme, /ask focused questions/);
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
  assert.match(files.readme, /Please continue this task\./);
  assert.match(chunkText, /diagram\.png/);
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
  assert.equal(latestZip.files.has("manifest.json"), true);
  assert.equal(latestZip.files.has("attachments.json"), true);
  assert.equal(latestZip.files.has("chunks/001.md"), true);
  assert.equal(latestZip.files.has("prior/handoff-summary.md"), true);
  assert.match(latestZip.files.get("prior/handoff-summary.md"), /Prior summary/);
  const manifest = JSON.parse(latestZip.files.get("manifest.json"));
  assert.equal(manifest.integrity.algorithm, "SHA-256");
  assert.equal(manifest.integrity.scope, "final ZIP byte sequence");
  assert.equal(manifest.integrity.digestEmbedded, false);
  assert.equal(latestZip.files.has(manifest.integrity.sidecarFile), false);
  assert.equal(appendedCount, 2);
  assert.equal(downloads.length, 2);
  assert.match(downloads[0], /handoff\.zip$/);
  assert.equal(downloads[1], `${downloads[0]}.sha256`);
});
