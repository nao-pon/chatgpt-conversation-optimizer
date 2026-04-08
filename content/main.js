(() => {
  if (globalThis.__CGO_SKIP__) return;
  const CGO = (globalThis.__CGO ||= {});
  with (CGO) {
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
      await loadSettings();
      observeWindowMessages();
      //observeConversationStats();
      const ok = await ensurePageHooksInjected();
      if (!ok) {
        log("[warn] page-hook is unavailable");
      } else {
        await postSettingsToPageHook?.();
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
    }

    //injectPageBootstrapScript();
    main();
  }
})();
