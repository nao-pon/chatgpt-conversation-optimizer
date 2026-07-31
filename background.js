importScripts("viewer-storage.js");

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
