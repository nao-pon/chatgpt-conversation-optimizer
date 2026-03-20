(() => {
  if (window.__CGO_PAGE_BOOTSTRAP_READY__) return;

  const VERSION = "2";
  window.__CGO_PAGE_BOOTSTRAP_READY__ = true;
  window.__CGO_PAGE_BOOTSTRAP_VERSION__ = VERSION;

  const originalFetch = window.fetch;

  if (!window.__CGO_ORIGINAL_FETCH__) {
    window.__CGO_ORIGINAL_FETCH__ = originalFetch;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "CGO_CONTENT") return;

    if (data.type === "CGO_PING") {
      window.postMessage({
        source: "CGO_PAGE",
        type: "CGO_PONG",
        version: VERSION,
        bootstrap: true,
      }, "*");
    }
  });

  if (!window.__CGO_FETCH_PATCHED_BY_BOOTSTRAP__) {
    window.__CGO_FETCH_PATCHED_BY_BOOTSTRAP__ = true;

    window.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);

      try {
        const input = args[0];
        const url =
          typeof input === "string"
            ? input
            : (input && input.url) || "";

        if (
          url.includes("/backend-api/conversation/") ||
          url.includes("/backend-api/f/conversation")
        ) {
          window.postMessage({
            source: "CGO_PAGE",
            type: "CGO_FETCH_SEEN",
            url,
          }, "*");
        }
      } catch (_) {}

      return response;
    };
  }

  window.postMessage({
    source: "CGO_PAGE",
    type: "CGO_READY",
    version: VERSION,
    bootstrap: true,
  }, "*");
})();