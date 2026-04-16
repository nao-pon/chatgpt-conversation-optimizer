(() => {
  if (globalThis.__CGO_SKIP__) return;
  const CGO = (globalThis.__CGO ||= {});

  /**
   * Initialize the content-script side of CGO and wire page hooks plus UI observers.
   *
   * @returns {Promise<void>}
   */
  async function main() {
    await CGO.loadSettings();
    CGO.observeWindowMessages();
    const ok = await CGO.ensurePageHooksInjected();
    if (!ok) {
      CGO.log("[warn] page-hook is unavailable");
    } else {
      await CGO.postSettingsToPageHook?.();
    }

    CGO.onDomReady(() => {
      CGO.injectExportButtonStyle();
      CGO.startHeaderButtonObserver();
      CGO.observeRouteChanges();
      document.addEventListener("click", () => {
        CGO.closeSettingsPanel?.();
      });
      CGO.log("content initialized");
    });
  }

  main();
})();
