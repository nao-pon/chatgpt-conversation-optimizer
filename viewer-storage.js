(() => {
  const root = globalThis;
  const namespace = (root.CGOViewerStorage ||= {});

  const DB_NAME = "cgo_viewer_db";
  const DB_VERSION = 1;
  const STORE_NAME = "viewer_payloads";
  const CREATED_AT_INDEX = "createdAt";
  const LEGACY_STORAGE_PREFIX = "cgo_viewer_";
  const PAYLOAD_TTL_MS = 24 * 60 * 60 * 1000;
  const MESSAGE_SOURCE = "CGOViewerStorage";

  const isServiceWorker =
    typeof ServiceWorkerGlobalScope !== "undefined" &&
    root instanceof ServiceWorkerGlobalScope;
  const isExtensionPage = root.location?.protocol === "chrome-extension:";
  const hasRuntimeMessaging = !!root.chrome?.runtime?.sendMessage;
  const shouldProxyToBackground =
    hasRuntimeMessaging && !isServiceWorker && !isExtensionPage;

  /**
   * Log viewer storage diagnostics without including conversation payload data.
   *
   * @param {...any} args - Log arguments safe for diagnostics.
   */
  function log(...args) {
    const cgoLog = root.__CGO?.log || root.CGO?.log;
    if (typeof cgoLog === "function") {
      cgoLog(...args);
      return;
    }
    console.log(...args);
  }

  /**
   * Log a warning without including conversation payload data.
   *
   * @param {...any} args - Warning arguments safe for diagnostics.
   */
  function warn(...args) {
    const cgoLog = root.__CGO?.log || root.CGO?.log;
    if (typeof cgoLog === "function") {
      if (typeof args[0] === "string") {
        cgoLog(`[warn] ${args[0]}`, ...args.slice(1));
      } else {
        cgoLog("[warn]", ...args);
      }
      return;
    }
    console.warn(...args);
  }

  /**
   * Convert an error to a compact serializable diagnostic object.
   *
   * @param {*} error - Error thrown by IndexedDB or Chrome storage.
   * @returns {{name: string, message: string, stack: string, details: any}}
   */
  function serializeError(error) {
    return {
      name: String(error?.name || "Error"),
      message: String(error?.message || error || "unknown error"),
      stack: String(error?.stack || ""),
      details: error?.cgoViewerStorage || null,
    };
  }

  /**
   * Recreate an Error from a serialized background response.
   *
   * @param {{name: string, message: string, stack: string, details: any}} data - Serialized error data.
   * @returns {Error}
   */
  function deserializeError(data) {
    const error = new Error(data?.message || "viewer storage operation failed");
    error.name = data?.name || "Error";
    if (data?.stack) error.stack = data.stack;
    if (data?.details) error.cgoViewerStorage = data.details;
    return error;
  }

  /**
   * Return true when an IndexedDB error represents quota exhaustion.
   *
   * @param {*} error - Error thrown by IndexedDB.
   * @returns {boolean} True for QuotaExceededError and Chrome quota-equivalent failures.
   */
  function isQuotaExceededError(error) {
    const name = String(error?.name || "");
    const message = String(error?.message || error || "");
    return (
      name === "QuotaExceededError" ||
      error?.code === 22 ||
      /QuotaExceededError|quota exceeded|kQuotaBytes|QuotaBytes|storage quota/i.test(message)
    );
  }

  /**
   * Wrap an IndexedDB request in a Promise.
   *
   * @param {IDBRequest} request - IndexedDB request.
   * @returns {Promise<any>} Request result.
   */
  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
  }

  /**
   * Resolve when an IndexedDB transaction completes.
   *
   * @param {IDBTransaction} transaction - IndexedDB transaction.
   * @returns {Promise<void>}
   */
  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
    });
  }

  /**
   * Open the extension-scoped IndexedDB database used for temporary lightweight viewer payloads.
   *
   * Viewer payloads are temporary handoff records. They are deleted when they become older than
   * 24 hours, or after successful display only when delete-after-render is enabled.
   *
   * @returns {Promise<IDBDatabase>} Open database connection.
   */
  function openViewerDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        const store = db.objectStoreNames.contains(STORE_NAME)
          ? request.transaction.objectStore(STORE_NAME)
          : db.createObjectStore(STORE_NAME, { keyPath: "token" });

        if (!store.indexNames.contains(CREATED_AT_INDEX)) {
          store.createIndex(CREATED_AT_INDEX, "createdAt", { unique: false });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
    });
  }

  /**
   * Save one viewer payload record into IndexedDB.
   *
   * @param {{token: string, createdAt: number, payload: Object}} record - Temporary viewer record.
   * @returns {Promise<void>}
   */
  async function putViewerRecord(record) {
    const db = await openViewerDatabase();
    try {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore(STORE_NAME).put(record);
      await done;
    } finally {
      db.close();
    }
  }

  /**
   * Send a viewer storage operation from a content script to the extension service worker.
   *
   * @param {string} operation - Operation name.
   * @param {Array} args - Operation arguments.
   * @returns {Promise<any>} Operation result.
   */
  async function sendStorageMessage(operation, args) {
    const response = await chrome.runtime.sendMessage({
      source: MESSAGE_SOURCE,
      operation,
      args,
    });

    if (response?.ok) return response.result;

    const error = deserializeError(response?.error);
    logProxyFailure(operation, error);
    throw error;
  }

  /**
   * Log background failure details visible to content-script diagnostics.
   *
   * @param {string} operation - Failed operation name.
   * @param {Error} error - Deserialized operation error.
   */
  function logProxyFailure(operation, error) {
    if (operation !== "saveViewerPayload") return;
    const details = error?.cgoViewerStorage;
    if (!details?.quota) return;

    warn("[viewer-storage] quota exceeded while saving viewer payload", {
      token: details.token,
    });
    if (details.deletedOldest) {
      warn("[viewer-storage] deleted oldest viewer payload for quota recovery", details.deletedOldest);
    }
    warn("[viewer-storage] quota recovery retry failed", {
      token: details.token,
      deletedOldest: details.deletedOldest || null,
      error: String(error?.message || error),
    });
  }

  /**
   * Save a temporary payload for viewer.html and retry once after quota recovery.
   *
   * Viewer payloads are temporary handoff records. They are deleted when they become older than
   * 24 hours, or after successful display only when delete-after-render is enabled.
   *
   * @param {string} token - Viewer token used as the IndexedDB key.
   * @param {Object} payload - Serializable lightweight viewer payload.
   * @returns {Promise<{token: string, createdAt: number, quotaRecovered: boolean, deletedOldest: Object|null}>}
   */
  async function saveViewerPayload(token, payload) {
    if (shouldProxyToBackground) {
      const result = await sendStorageMessage("saveViewerPayload", [token, payload]);
      logSaveResult(result);
      return result;
    }

    const now = Date.now();
    const record = {
      token,
      createdAt: now,
      payload: {
        ...payload,
        exportedAt: now,
      },
    };

    try {
      await putViewerRecord(record);
      return { token, createdAt: now, quotaRecovered: false, deletedOldest: null };
    } catch (error) {
      if (!isQuotaExceededError(error)) throw error;

      warn("[viewer-storage] quota exceeded while saving viewer payload", {
        token,
        error: String(error?.message || error),
      });

      const deletedOldest = await deleteOldestViewerPayload(token);
      if (deletedOldest) {
        warn("[viewer-storage] deleted oldest viewer payload for quota recovery", deletedOldest);
      } else {
        warn("[viewer-storage] quota recovery found no older viewer payload to delete", { token });
      }

      try {
        await putViewerRecord(record);
        log("[viewer-storage] quota recovery retry succeeded", {
          token,
          deletedOldest,
        });
        return { token, createdAt: now, quotaRecovered: true, deletedOldest };
      } catch (retryError) {
        retryError.cgoViewerStorage = {
          quota: true,
          token,
          deletedOldest,
        };
        warn("[viewer-storage] quota recovery retry failed", {
          token,
          deletedOldest,
          error: String(retryError?.message || retryError),
        });
        throw retryError;
      }
    }
  }

  /**
   * Log save result details returned from the background service worker.
   *
   * @param {{token: string, quotaRecovered: boolean, deletedOldest: Object|null}} result - Save result.
   */
  function logSaveResult(result) {
    if (!result?.quotaRecovered) return;
    warn("[viewer-storage] quota exceeded while saving viewer payload", {
      token: result.token,
    });
    if (result.deletedOldest) {
      warn("[viewer-storage] deleted oldest viewer payload for quota recovery", result.deletedOldest);
    }
    log("[viewer-storage] quota recovery retry succeeded", {
      token: result.token,
      deletedOldest: result.deletedOldest || null,
    });
  }

  /**
   * Load a temporary viewer payload from IndexedDB.
   *
   * @param {string} token - Viewer token.
   * @returns {Promise<Object|null>} Stored payload, or null when missing.
   */
  async function loadViewerPayload(token) {
    if (shouldProxyToBackground) {
      return sendStorageMessage("loadViewerPayload", [token]);
    }

    const db = await openViewerDatabase();
    try {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const done = transactionDone(transaction);
      const record = await requestToPromise(transaction.objectStore(STORE_NAME).get(token));
      await done;
      return record?.payload || null;
    } finally {
      db.close();
    }
  }

  /**
   * Delete one temporary viewer payload from IndexedDB.
   *
   * @param {string} token - Viewer token.
   * @returns {Promise<void>}
   */
  async function deleteViewerPayload(token) {
    if (shouldProxyToBackground) {
      return sendStorageMessage("deleteViewerPayload", [token]);
    }

    const db = await openViewerDatabase();
    try {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore(STORE_NAME).delete(token);
      await done;
    } finally {
      db.close();
    }
  }

  /**
   * Delete temporary viewer payloads older than or equal to the 24-hour retention boundary.
   *
   * Uses the createdAt index and an upperBound key range so payload bodies are not loaded into
   * memory. Viewer payloads are temporary and should disappear after expiry, or after successful
   * display only when delete-after-render is enabled.
   *
   * @param {number} [now=Date.now()] - Current timestamp.
   * @returns {Promise<{deletedCount: number, cutoff: number}>} Cleanup result.
   */
  async function cleanupExpiredViewerPayloads(now = Date.now()) {
    if (shouldProxyToBackground) {
      const result = await sendStorageMessage("cleanupExpiredViewerPayloads", [now]);
      log("[viewer-storage] expired viewer payload cleanup", result);
      return result;
    }

    const cutoff = now - PAYLOAD_TTL_MS;
    const db = await openViewerDatabase();
    let deletedCount = 0;

    try {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const done = transactionDone(transaction);
      const index = transaction.objectStore(STORE_NAME).index(CREATED_AT_INDEX);
      const range = IDBKeyRange.upperBound(cutoff);

      await new Promise((resolve, reject) => {
        const request = index.openCursor(range);

        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }

          cursor.delete();
          deletedCount += 1;
          cursor.continue();
        };

        request.onerror = () => reject(request.error || new Error("IndexedDB cursor failed"));
      });

      await done;
      log("[viewer-storage] expired viewer payload cleanup", {
        deletedCount,
        cutoff,
      });
      return { deletedCount, cutoff };
    } finally {
      db.close();
    }
  }

  /**
   * Delete the oldest viewer payload except a protected token.
   *
   * Uses the createdAt index in ascending order and does not load payload bodies into memory.
   *
   * @param {string} [excludeToken=""] - Token that must not be deleted.
   * @returns {Promise<{token: string, createdAt: number}|null>} Deleted record metadata, if any.
   */
  async function deleteOldestViewerPayload(excludeToken = "") {
    if (shouldProxyToBackground) {
      return sendStorageMessage("deleteOldestViewerPayload", [excludeToken]);
    }

    const db = await openViewerDatabase();
    let deleted = null;

    try {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const done = transactionDone(transaction);
      const index = transaction.objectStore(STORE_NAME).index(CREATED_AT_INDEX);

      await new Promise((resolve, reject) => {
        const request = index.openCursor(null, "next");

        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }

          const record = cursor.value;
          if (record?.token === excludeToken) {
            cursor.continue();
            return;
          }

          deleted = {
            token: String(record?.token || ""),
            createdAt: Number(record?.createdAt || 0),
          };
          cursor.delete();
          resolve();
        };

        request.onerror = () => reject(request.error || new Error("IndexedDB cursor failed"));
      });

      await done;
      return deleted;
    } finally {
      db.close();
    }
  }

  /**
   * Remove legacy lightweight viewer payloads left in chrome.storage.local.
   *
   * Legacy records used keys beginning with cgo_viewer_. This cleanup removes only matching keys
   * and does not keep payload values after extracting their keys.
   *
   * @returns {Promise<{deletedCount: number}>} Cleanup result.
   */
  async function cleanupLegacyViewerStoragePayloads() {
    if (shouldProxyToBackground) {
      const result = await sendStorageMessage("cleanupLegacyViewerStoragePayloads", []);
      log("[viewer-storage] legacy chrome.storage.local viewer payload cleanup", result);
      return result;
    }

    if (!chrome?.storage?.local) return { deletedCount: 0 };

    let keys = [];
    if (typeof chrome.storage.local.getKeys === "function") {
      keys = await chrome.storage.local.getKeys();
    } else {
      let stored = await chrome.storage.local.get(null);
      keys = Object.keys(stored || {});
      stored = null;
    }

    const legacyKeys = keys.filter((key) => key.startsWith(LEGACY_STORAGE_PREFIX));
    if (legacyKeys.length) {
      await chrome.storage.local.remove(legacyKeys);
    }

    log("[viewer-storage] legacy chrome.storage.local viewer payload cleanup", {
      deletedCount: legacyKeys.length,
    });
    return { deletedCount: legacyKeys.length };
  }

  /**
   * Execute a storage command sent by a content script.
   *
   * @param {{operation: string, args: Array}} message - Runtime message.
   * @returns {Promise<any>} Operation result.
   */
  async function handleStorageMessage(message) {
    const args = Array.isArray(message?.args) ? message.args : [];
    switch (message?.operation) {
      case "saveViewerPayload":
        return saveViewerPayload(...args);
      case "loadViewerPayload":
        return loadViewerPayload(...args);
      case "deleteViewerPayload":
        return deleteViewerPayload(...args);
      case "cleanupExpiredViewerPayloads":
        return cleanupExpiredViewerPayloads(...args);
      case "deleteOldestViewerPayload":
        return deleteOldestViewerPayload(...args);
      case "cleanupLegacyViewerStoragePayloads":
        return cleanupLegacyViewerStoragePayloads(...args);
      default:
        throw new Error(`unknown viewer storage operation: ${message?.operation}`);
    }
  }

  namespace.DB_NAME = DB_NAME;
  namespace.DB_VERSION = DB_VERSION;
  namespace.STORE_NAME = STORE_NAME;
  namespace.CREATED_AT_INDEX = CREATED_AT_INDEX;
  namespace.LEGACY_STORAGE_PREFIX = LEGACY_STORAGE_PREFIX;
  namespace.PAYLOAD_TTL_MS = PAYLOAD_TTL_MS;
  namespace.MESSAGE_SOURCE = MESSAGE_SOURCE;
  namespace.cleanupExpiredViewerPayloads = cleanupExpiredViewerPayloads;
  namespace.cleanupLegacyViewerStoragePayloads = cleanupLegacyViewerStoragePayloads;
  namespace.deleteOldestViewerPayload = deleteOldestViewerPayload;
  namespace.deleteViewerPayload = deleteViewerPayload;
  namespace.isQuotaExceededError = isQuotaExceededError;
  namespace.loadViewerPayload = loadViewerPayload;
  namespace.openViewerDatabase = openViewerDatabase;
  namespace.saveViewerPayload = saveViewerPayload;
  namespace._handleStorageMessage = handleStorageMessage;
  namespace._serializeError = serializeError;
})();
