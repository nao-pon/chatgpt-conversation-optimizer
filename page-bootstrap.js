(() => {
  if (window.__CGO_PAGE_BOOTSTRAP_READY__) return;

  const VERSION = "2";
  window.__CGO_PAGE_BOOTSTRAP_READY__ = true;
  window.__CGO_PAGE_BOOTSTRAP_VERSION__ = VERSION;

  const bootstrapOriginalFetch = window.fetch;

  if (!window.__CGO_ORIGINAL_FETCH__) {
    window.__CGO_ORIGINAL_FETCH__ = bootstrapOriginalFetch;
  }

  let mainHookReady = false;

  /**
   * Extracts the request URL from a fetch-style input.
   *
   * @param {*} input - A fetch input: a URL string or an object (e.g., Request-like) with a string `url` property.
   * @returns {string} The request URL if available, otherwise an empty string.
   */
  function getRequestUrl(input) {
    if (typeof input === "string") return input;
    if (input && typeof input.url === "string") return input.url;
    return "";
  }

  /**
   * Waits for the embedded runtime's main hook to signal readiness, or times out.
   *
   * If the main hook is already marked ready, resolves immediately. When a
   * `CGO_MAIN_HOOK_READY` message is received from the page before the timeout,
   * marks the local `mainHookReady` flag and resolves accordingly.
   *
   * @param {number} [timeoutMs=500] - Maximum time to wait in milliseconds before giving up.
   * @returns {boolean} `true` if the main hook became ready before the timeout, `false` otherwise.
   */
  function waitForMainHookReady(timeoutMs = 500) {
    if (mainHookReady || window.__CGO_MAIN_HOOK_READY__) {
      mainHookReady = true;
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      let done = false;

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        window.removeEventListener("message", onMessage);
        resolve(false);
      }, timeoutMs);

      function onMessage(event) {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== "CGO_PAGE") return;

        if (data.type === "CGO_MAIN_HOOK_READY") {
          mainHookReady = true;
          if (done) return;
          done = true;
          clearTimeout(timer);
          window.removeEventListener("message", onMessage);
          resolve(true);
        }
      }

      window.addEventListener("message", onMessage);
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "CGO_CONTENT") return;

    if (data.type === "CGO_PING") {
      window.postMessage(
        {
          source: "CGO_PAGE",
          type: "CGO_PONG",
          version: VERSION,
          bootstrap: true,
        },
        "*"
      );
    }
  });

  /**
   * Performs a fetch using the preserved original fetch, optionally waits for the runtime main hook, and lets the runtime handle or observe the response.
   *
   * If the runtime main hook is not ready, waits up to 1200ms for readiness before performing the request. After the original fetch completes, forwards the call to `window.__CGO_MAIN_HOOK_API__.handleFetchResponse` when available; if that handler throws, posts an error message to window and falls back to returning the original response.
   * @param {...any} args - Arguments forwarded to the original `fetch` (request input and optional init).
   * @returns {Response} The `Response` produced by the runtime handler when present, otherwise the original fetch `Response`.
   */
  async function cgoBootstrapFetch(...args) {
    if (!mainHookReady && !window.__CGO_MAIN_HOOK_READY__) {
      await waitForMainHookReady(1200);
    }

    const url = getRequestUrl(args[0]);
    const orgResponse = await bootstrapOriginalFetch.apply(this, args);

    const api = window.__CGO_MAIN_HOOK_API__;
    if (api && typeof api.handleFetchResponse === "function") {
      try {
        return await api.handleFetchResponse({
          args,
          response: orgResponse,
          url,
        });
      } catch (error) {
        window.postMessage(
          {
            source: "cgo-prune-runtime",
            type: "error",
            error: String(error),
          },
          "*"
        );
        return orgResponse;
      }
    }

    return orgResponse;
  }

  cgoBootstrapFetch.__CGO_BOOTSTRAP_PATCHED__ = true;
  window.__CGO_BOOTSTRAP_FETCH__ = cgoBootstrapFetch;

  if (!window.__CGO_FETCH_PATCHED_BY_BOOTSTRAP__) {
    window.__CGO_FETCH_PATCHED_BY_BOOTSTRAP__ = true;
    window.fetch = cgoBootstrapFetch;
  }

  window.postMessage(
    {
      source: "CGO_PAGE",
      type: "CGO_READY",
      version: VERSION,
      bootstrap: true,
    },
    "*"
  );
})();
