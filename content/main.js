(() => {
  const CGO = (globalThis.CGO = globalThis.CGO || {});

  let bootstrapInjected = false;
  let mainHookInjected = false;
  let runtimeMessageObserved = false;
  let initStarted = false;

  function injectScriptFileOnce(srcUrl, markerAttr) {
    if (!srcUrl) return false;

    const existing = document.querySelector(`script[${markerAttr}="1"]`);
    if (existing) return true;

    const script = document.createElement("script");
    script.src = srcUrl;
    script.async = false;
    script.setAttribute(markerAttr, "1");

    (document.head || document.documentElement).prepend(script);
    return true;
  }

  function injectPageBootstrapScript() {
    if (bootstrapInjected) return true;

    const url = chrome.runtime.getURL("page-bootstrap.js");
    bootstrapInjected = injectScriptFileOnce(url, "data-cgo-page-bootstrap");
    return bootstrapInjected;
  }

  function injectMainPageHookScript() {
    if (mainHookInjected) return true;

    const url = chrome.runtime.getURL("page-hook.js");
    mainHookInjected = injectScriptFileOnce(url, "data-cgo-page-hook");
    return mainHookInjected;
  }

  function waitForCgoPong(timeoutMs = 2000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve(false);
      }, timeoutMs);

      function onMessage(event) {
        if (event.source !== window) return;

        const data = event.data;
        if (!data || data.source !== "CGO_PAGE") return;
        if (data.type !== "CGO_PONG") return;

        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(true);
      }

      window.addEventListener("message", onMessage);

      window.postMessage(
        {
          source: "CGO_CONTENT",
          type: "CGO_PING",
        },
        "*"
      );
    });
  }

  async function ensurePageHooksInjected() {
    injectPageBootstrapScript();
    await CGO.sleep(50);

    const bootstrapReady = await waitForCgoPong(2000);
    if (!bootstrapReady) {
      CGO.log("[warn] page-bootstrap pong timeout");
    }

    injectMainPageHookScript();
    await CGO.sleep(50);

    const hookReady = await waitForCgoPong(2000);
    if (!hookReady) {
      CGO.log("[warn] page-hook pong timeout");
    }

    return bootstrapReady || hookReady;
  }

  function handleCacheCaptured(data) {
    window.postMessage(
      {
        type: "CGO_EXPORT_CACHE_CAPTURED",
        url: data.url || "",
        data: data.data || data.json || null,
      },
      "*"
    );
  }

  function handleFileDownloadCaptured(data) {
    window.postMessage(
      {
        type: "CGO_FILE_DOWNLOAD_CACHE_CAPTURED",
        url: data.url || "",
        data: data.data || data.json || null,
      },
      "*"
    );
  }

  let toolbarInitialized = false;

  function handleRuntimeMessage(data) {
    if (!data || typeof data !== "object") return;

    switch (data.type) {
      case "analysis": {
        if (!toolbarInitialized) {
          CGO.injectExportButtonIntoHeader?.();
          toolbarInitialized = true;
        }

        CGO.updateExportButtonVisibility?.(true);

        CGO.log("[analysis]", {
          url: data.url,
          summary: data.summary,
        });
        return;
      }

      case "log": {
        CGO.log(...(data.args || []));
        return;
      }

      case "error": {
        CGO.log("[error]", data.error);
        return;
      }

      case "network-auth": {
        window.postMessage(
          {
            type: "CGO_LAST_AUTHORIZATION_CAPTURED",
            authorization: data.authorization || "",
            url: data.url || "",
          },
          "*"
        );
        return;
      }

      case "network-response": {
        const url = data.url || "";
        const json = data.json || null;

        if (
          /\/backend-api\/conversation\//i.test(url) &&
          json &&
          typeof json === "object" &&
          json.mapping &&
          json.current_node
        ) {
          handleCacheCaptured(data);
          return;
        }

        if (
          /\/backend-api\/files\/download\//i.test(url) &&
          json &&
          typeof json === "object" &&
          typeof json.download_url === "string"
        ) {
          handleFileDownloadCaptured(data);
          return;
        }

        return;
      }

      case "network-response-meta": {
        return;
      }

      default:
        return;
    }
  }

  function observeWindowMessages() {
    if (runtimeMessageObserved) return;
    runtimeMessageObserved = true;

    window.addEventListener("message", (event) => {
      if (event.source !== window) return;

      const data = event.data;
      if (!data || data.source !== "cgo-prune-runtime") return;

      handleRuntimeMessage(data);
    });
  }

  async function initContentMain() {
    if (initStarted) return;
    initStarted = true;

    try {
      observeWindowMessages();

      if (CGO.loadSettings) {
        await CGO.loadSettings();
      }

      await ensurePageHooksInjected();

      CGO.onDomReady(() => {
        if (CGO.ensureToolbarStyles) {
          CGO.ensureToolbarStyles();
        }

        if (CGO.observeRouteChanges) {
          CGO.observeRouteChanges();
        }

        if (CGO.observeStreamCompletion) {
          CGO.observeStreamCompletion();
        }

        if (CGO.scheduleDomTrim) {
          CGO.scheduleDomTrim();
        }
      });

      CGO.log("content-main initialized");
    } catch (error) {
      CGO.log("[error] content-main init failed", error);
    }
  }

  CGO.injectPageBootstrapScript = injectPageBootstrapScript;
  CGO.injectMainPageHookScript = injectMainPageHookScript;
  CGO.ensurePageHooksInjected = ensurePageHooksInjected;
  CGO.observeWindowMessages = observeWindowMessages;
  CGO.handleRuntimeMessage = handleRuntimeMessage;
  CGO.initContentMain = initContentMain;

  initContentMain();
})();