importScripts("viewer-storage.js");

const LEGACY_CONVERSATION_OVERRIDE_STORAGE_KEY = "cgo_conversation_overrides";

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== "update") return;

  chrome.storage.local.remove(LEGACY_CONVERSATION_OVERRIDE_STORAGE_KEY);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.source !== globalThis.CGOViewerStorage?.MESSAGE_SOURCE) {
    return false;
  }

  (async () => {
    try {
      const result = await globalThis.CGOViewerStorage._handleStorageMessage(message);
      sendResponse({ ok: true, result });
    } catch (error) {
      sendResponse({
        ok: false,
        error: globalThis.CGOViewerStorage._serializeError(error),
      });
    }
  })();

  return true;
});
