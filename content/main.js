(() => {
  if (globalThis.__CGO_SKIP__) return;
  const CGO = (globalThis.__CGO ||= {});

  /*    CGO.main = async function main() {
        await loadSettings();
        observeWindowMessages();
        const ok = await ensurePageHooksInjected();
        if (!ok) {
          log("[warn] page-hook is unavailable");
        }
        onDomReady(() => {
          injectExportButtonStyle();
          startHeaderButtonObserver();
          observeRouteChanges();
          observeStreamCompletion();
          document.addEventListener("click", () => {
            closeSettingsPanel?.();
          });
          log("content initialized");
        });
      }*/
  CGO.main = async function main() {
    await CGO.loadSettings();
    CGO.observeWindowMessages();
    //observeConversationStats();
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
      CGO.observeStreamCompletion();
      document.addEventListener("click", () => {
        CGO.closeSettingsPanel?.();
      });
      CGO.log("content initialized");
    });
  }

  //injectPageBootstrapScript();
  CGO.main();
})();