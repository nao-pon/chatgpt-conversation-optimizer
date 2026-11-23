const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadRenderModule() {
  const clickedDownloads = [];
  const document = {
    title: "Fixture - ChatGPT",
    createElement(tagName) {
      assert.equal(tagName, "a");
      return {
        href: "",
        download: "",
        click() {
          clickedDownloads.push(this.download);
        },
      };
    },
  };
  const window = { __CGO: {} };
  const context = vm.createContext({
    window,
    globalThis: window,
    document,
    location: {
      origin: "https://chatgpt.com",
      pathname: "/c/conversation-1",
    },
    navigator: { language: "en" },
    URL,
    Blob,
    Date,
    console,
    setTimeout(callback) {
      callback();
      return 1;
    },
    clearTimeout,
    alert(message) {
      throw new Error(String(message));
    },
  });

  const renderPath = path.join(__dirname, "..", "content", "render.js");
  vm.runInContext(fs.readFileSync(renderPath, "utf8"), context, {
    filename: renderPath,
  });

  return { CGO: window.__CGO, clickedDownloads };
}

test("HTML download resolves and embeds images without resolving attachments", async () => {
  const { CGO, clickedDownloads } = loadRenderModule();
  const message = {
    id: "user-1",
    role: "user",
    text: "Fixture",
    images: [],
    attachments: [{
      name: "example.zip",
      fileId: "file_example",
      kind: "archive",
    }],
  };
  let imageResolutionCalls = 0;
  let imageEmbeddingCalls = 0;
  let attachmentResolutionCalls = 0;

  CGO.getConversationIdFromLocation = () => "conversation-1";
  CGO.getConversationForExport = async () => ({
    title: "Fixture",
    current_node: "user-1",
    mapping: { "user-1": { message } },
  });
  CGO.buildExportChain = () => [message];
  CGO.normalizeMessagesForExport = () => [message];
  CGO.buildDomAssetMap = () => [];
  CGO.mergeMessagesWithDomAssets = (messages) => messages;
  CGO.getLastAuthorizationFromPage = async () => "";
  CGO.resolveImageUrlsWithDownloadApi = async () => {
    imageResolutionCalls += 1;
  };
  CGO.resolveAttachmentUrlsWithDownloadApi = async () => {
    attachmentResolutionCalls += 1;
  };
  CGO.embedImagesInMessages = async () => {
    imageEmbeddingCalls += 1;
  };
  CGO.prepareInlineImageData = () => {};
  CGO.extractProjectNameFromDocumentTitle = () => "";
  CGO.getProjectGizmoIdFromLocation = () => "";
  CGO.buildChatgptWebConversationUrl = () => "https://chatgpt.com/c/conversation-1";
  CGO.loadExtensionTextFile = async () => "";
  CGO.getSharedExportAssets = async () => ({ css: "", uiJs: "" });
  CGO.buildConversationExportHtml = () => "<!doctype html><title>Fixture</title>";
  CGO.setToolbarButtonText = () => {};
  CGO.t = (key) => key;
  CGO.log = () => {};

  await CGO.exportCurrentConversationAsHtml(null, "download");

  assert.equal(imageResolutionCalls, 1);
  assert.equal(imageEmbeddingCalls, 1);
  assert.equal(attachmentResolutionCalls, 0);
  assert.equal(clickedDownloads.length, 1);
  assert.match(clickedDownloads[0], /\.html$/);
});
