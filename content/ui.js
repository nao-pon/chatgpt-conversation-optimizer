(() => {
  const CGO = (globalThis.CGO = globalThis.CGO || {});

  let toolbarRoot = null;

  function getToolbarHost() {
    // まず既存の thread header / action 領域を探す
    const candidates = [
      document.querySelector("main"),
      document.querySelector("[data-testid='conversation-view']"),
      document.querySelector("body"),
    ];

    return candidates.find(Boolean) || document.body;
  }

  function getToolbarHost() {
    return (
      document.querySelector("main") ||
      document.body ||
      document.documentElement ||
      null
    );
  }

  function ensureToolbarRoot() {
    if (toolbarRoot && toolbarRoot.isConnected) {
      return toolbarRoot;
    }

    const host = getToolbarHost();
    if (!host) {
      return null;
    }

    const root = document.createElement("div");
    root.className = "cgo-toolbar-root";
    root.dataset.cgoToolbar = "1";

    host.appendChild(root);
    toolbarRoot = root;

    return root;
  }

  function removeToolbarRoot() {
    if (toolbarRoot && toolbarRoot.isConnected) {
      toolbarRoot.remove();
    }
    toolbarRoot = null;
  }

  function ensureToolbarStyles() {
    if (document.getElementById("cgo-toolbar-style")) return;

    const style = document.createElement("style");
    style.id = "cgo-toolbar-style";
    style.textContent = `
      .cgo-toolbar {
        display: flex;
        gap: 6px;
        align-items: center;
      }

      .cgo-btn {
        position: relative;
        background: transparent;
        border: none;
        color: #d8d8d8;
        cursor: pointer;
        padding: 6px;
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .cgo-btn svg {
        width: 18px;
        height: 18px;
        display: block;
        flex: 0 0 auto;
      }

      .cgo-btn:hover {
        background: rgba(255, 255, 255, 0.08);
        color: #ffffff;
      }

      .cgo-btn:active {
        transform: scale(0.95);
      }

      .cgo-settings-panel {
        position: fixed;
        min-width: 280px;
        max-width: min(360px, calc(100vw - 24px));
        background: #1f1f1f;
        color: #fff;
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.35);
        padding: 12px;
        z-index: 2147483001;
      }

      .cgo-settings-title {
        font-weight: 700;
        margin-bottom: 10px;
      }

      .cgo-settings-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
      }

      .cgo-settings-number {
        width: 88px;
      }

      .cgo-settings-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 12px;
      }
    `;

    document.head.appendChild(style);
  }

  function buildToolbarButton({ title, iconKind }) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cgo-btn";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.dataset.iconKind = iconKind;

    const iconWrap = document.createElement("span");
    iconWrap.className = "cgo-btn-icon";
    iconWrap.appendChild(getButtonIconSvg(iconKind));

    const labelWrap = document.createElement("span");
    labelWrap.className = "cgo-btn-label";
    labelWrap.hidden = true;

    button.appendChild(iconWrap);
    button.appendChild(labelWrap);

    return button;
  }


  function getButtonIconSvg(kind) {
    switch (kind) {
      case "light":
        return createSvgIcon("M13 2L6 14h5l-1 8 8-12h-5l1-8z");
      case "html":
        return createSvgIcon("M6 2h9l5 5v15a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm8 1.5V8h4.5", "0 0 24 24");
      case "zip":
        return createSvgIcon("M12 3v10.17l3.59-3.58L17 11l-5 5-5-5 1.41-1.41L11 13.17V3h1zM5 19h14v2H5z");
      default:
        return createSvgIcon("M12 3v18M3 12h18");
    }
  }
  /*  function buildToolbarButton({ title, iconKind }) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cgo-btn";
      button.title = title || "";
      button.setAttribute("aria-label", title || "");
  
      const icon = document.createElement("span");
      icon.className = "cgo-btn-icon";
      icon.textContent = getToolbarIconText(iconKind);
  
      const label = document.createElement("span");
      label.className = "cgo-btn-label";
      label.textContent = "";
  
      button.dataset.iconKind = iconKind || "";
      button.appendChild(icon);
      button.appendChild(label);
  
      return button;
    }*/

  function createSvgIcon(pathD, viewBox = "0 0 24 24") {
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", viewBox);
    svg.setAttribute("aria-hidden", "true");

    const path = document.createElementNS(svgNS, "path");
    path.setAttribute("d", pathD);
    path.setAttribute("fill", "currentColor");

    svg.appendChild(path);
    return svg;
  }

  function setToolbarButtonText(button, text) {
    if (!button) return;
    const label = button.querySelector(".cgo-btn-label");
    if (label) {
      label.textContent = text || "";
    }
  }

  /*  function setToolbarButtonIcon(button, iconText) {
      if (!button) return;
      const icon = button.querySelector(".cgo-btn-icon");
      if (icon) {
        icon.textContent = iconText || "";
      }
    }*/

  function setExportButtonState(button, state) {
    if (!button) return;

    if (state === "idle") {
      button.disabled = false;
      setToolbarButtonText(button, CGO.t("download"))
    }

    if (state === "loading") {
      button.disabled = true;
      setToolbarButtonText(button, CGO.t("exporting"));
    }

    if (state === "error") {
      button.disabled = false;
      setToolbarButtonText(button, CGO.t("retry"));
    }
  }

  /*  function setExportButtonState(button, state) {
      if (!button) return;
  
      button.classList.remove("is-loading", "is-error", "is-success");
      button.disabled = false;
  
      const iconKind = button.dataset.iconKind || "";
      const defaultIcon = getToolbarIconText(iconKind);
  
      switch (state) {
        case "loading":
          button.classList.add("is-loading");
          button.disabled = true;
          setToolbarButtonIcon(button, "⟳");
          break;
  
        case "idle":
          setToolbarButtonIcon(button, defaultIcon);
          break;
  
        case "success":
          button.classList.add("is-success");
          setToolbarButtonIcon(button, "✓");
          break;
  
        case "export_retry":
        case "error":
          button.classList.add("is-error");
          setToolbarButtonIcon(button, "!");
          break;
  
        default:
          setToolbarButtonIcon(button, defaultIcon);
          break;
      }
    }*/

  function createToolbarActionButton({ titleKey, iconKind, action, errorState = "error" }) {
    const button = buildToolbarButton({
      title: CGO.t(titleKey),
      iconKind,
    });

    button.addEventListener("click", async () => {
      try {
        setExportButtonState(button, "loading");
        await action(button);
        setExportButtonState(button, "idle");
        setToolbarButtonText(button, "");
      } catch (error) {
        CGO.log("[error]", error);
        setExportButtonState(button, errorState);
      }
    });

    return button;
  }

  function createOpenNewTabButton() {
    return createToolbarActionButton({
      titleKey: "open_new_tab_button",
      iconKind: "light",
      errorState: "export_retry",
      action: (button) =>
        CGO.exportCurrentConversationAsHtml(
          button,
          CGO.getCurrentVisibleMessageId()
        ),
    });
  }

  function createExportButton() {
    return createToolbarActionButton({
      titleKey: "download_button",
      iconKind: "html",
      errorState: "export_retry",
      action: (button) =>
        CGO.exportCurrentConversationAsHtml(button),
    });
  }

  function createZipExportButton() {
    return createToolbarActionButton({
      titleKey: "zip_download_button",
      iconKind: "zip",
      errorState: "error",
      action: (button) =>
        CGO.exportCurrentConversationAsZip(button),
    });
  }

  function createSettingsButton() {
    return createToolbarActionButton({
      titleKey: "settings_button",
      iconKind: "settings",
      errorState: "error",
      action: async (button) => {
        toggleSettingsPanel(button);
      },
    });
  }

  let settingsPanelEl = null;

  function closeSettingsPanel() {
    if (settingsPanelEl && settingsPanelEl.isConnected) {
      settingsPanelEl.remove();
    }
    settingsPanelEl = null;
  }

  function buildSettingsPanel() {
    const panel = document.createElement("div");
    panel.className = "cgo-settings-panel";

    panel.innerHTML = `
      <div class="cgo-settings-title">${CGO.escapeHtml(CGO.t("settings_title"))}</div>

      <label class="cgo-settings-row">
        <span>${CGO.escapeHtml(CGO.t("settings_keep_dom_messages"))}</span>
        <input
          class="cgo-settings-number"
          type="number"
          min="10"
          max="300"
          step="1"
          value="${CGO.escapeHtml(String(CGO.SETTINGS?.keepDomMessages ?? CGO.CONFIG.keepDomMessages))}"
        >
      </label>

      <label class="cgo-settings-row">
        <span>${CGO.escapeHtml(CGO.t("settings_html_include_images"))}</span>
        <input
          class="cgo-settings-checkbox"
          type="checkbox"
          ${(CGO.SETTINGS?.htmlDownloadIncludeImages ?? true) ? "checked" : ""}
        >
      </label>

      <div class="cgo-settings-actions">
        <button type="button" class="cgo-settings-save">${CGO.escapeHtml(CGO.t("save_button"))}</button>
        <button type="button" class="cgo-settings-cancel">${CGO.escapeHtml(CGO.t("cancel_button"))}</button>
      </div>
    `;

    const numberInput = panel.querySelector(".cgo-settings-number");
    const imageCheckbox = panel.querySelector(".cgo-settings-checkbox");
    const saveButton = panel.querySelector(".cgo-settings-save");
    const cancelButton = panel.querySelector(".cgo-settings-cancel");

    saveButton.addEventListener("click", async () => {
      if (!CGO.saveSettings) {
        closeSettingsPanel();
        return;
      }

      const nextKeep = CGO.normalizeKeepDomMessages
        ? CGO.normalizeKeepDomMessages(numberInput.value)
        : Number(numberInput.value || 40);

      const nextIncludeImages = !!imageCheckbox.checked;

      await CGO.saveSettings({
        keepDomMessages: nextKeep,
        htmlDownloadIncludeImages: nextIncludeImages,
      });

      if (CGO.trimOldDomTurns) {
        CGO.trimOldDomTurns();
      }

      closeSettingsPanel();
    });

    cancelButton.addEventListener("click", () => {
      closeSettingsPanel();
    });

    return panel;
  }

  function toggleSettingsPanel(anchorButton) {
    if (settingsPanelEl) {
      closeSettingsPanel();
      return;
    }

    settingsPanelEl = buildSettingsPanel();
    document.body.appendChild(settingsPanelEl);

    const rect = anchorButton.getBoundingClientRect();
    settingsPanelEl.style.top = `${rect.top - 12}px`;
    settingsPanelEl.style.left = `${Math.max(8, rect.left - 240)}px`;

    requestAnimationFrame(() => {
      const onDocClick = (event) => {
        if (!settingsPanelEl) return;
        if (settingsPanelEl.contains(event.target)) return;
        if (anchorButton.contains(event.target)) return;

        document.removeEventListener("mousedown", onDocClick, true);
        closeSettingsPanel();
      };

      document.addEventListener("mousedown", onDocClick, true);
    });
  }

  function updateExportButtonVisibility(visible) {
    const root = ensureToolbarRoot();
    if (!root) return;
    root.classList.toggle("is-hidden", !visible);
  }


  function injectExportButtonIntoHeader() {
    if (!location.pathname.startsWith("/c/")) return;

    if (document.querySelector("div.cgo-toolbar")) return;

    const headerActions = document.getElementById("conversation-header-actions");
    if (!headerActions) return;

    toolbarBase = document.createElement("div");
    toolbarBase.className = "cgo-toolbar";

    const open_new_tab_button = createOpenNewTabButton();
    const download_button = createExportButton();
    const zip_download_button = createZipExportButton()
    const settingsBtn = createSettingsButton();
    toolbarBase.append(zip_download_button, download_button, open_new_tab_button, settingsBtn)
    headerActions.prepend(toolbarBase)
  }
  /*  function injectExportButtonIntoHeader() {
      ensureToolbarStyles();
  
      const root = ensureToolbarRoot();
      if (!root) {
        return null;
      }
  
      if (root.dataset.cgoInitialized === "1") return root;
  
      const openBtn = createOpenNewTabButton();
      const exportBtn = createExportButton();
      const zipBtn = createZipExportButton();
      const settingsBtn = createSettingsButton();
  
      root.appendChild(openBtn);
      root.appendChild(exportBtn);
      root.appendChild(zipBtn);
      root.appendChild(settingsBtn);
  
      root.dataset.cgoInitialized = "1";
      return root;
    }*/

  CGO.buildToolbarButton = buildToolbarButton;
  CGO.setToolbarButtonText = setToolbarButtonText;
  CGO.setExportButtonState = setExportButtonState;

  CGO.createToolbarActionButton = createToolbarActionButton;
  CGO.createOpenNewTabButton = createOpenNewTabButton;
  CGO.createExportButton = createExportButton;
  CGO.createZipExportButton = createZipExportButton;
  CGO.createSettingsButton = createSettingsButton;

  CGO.closeSettingsPanel = closeSettingsPanel;
  CGO.toggleSettingsPanel = toggleSettingsPanel;
  CGO.buildSettingsPanel = buildSettingsPanel;

  CGO.ensureToolbarStyles = ensureToolbarStyles;
  CGO.ensureToolbarRoot = ensureToolbarRoot;
  CGO.removeToolbarRoot = removeToolbarRoot;
  CGO.updateExportButtonVisibility = updateExportButtonVisibility;
  CGO.injectExportButtonIntoHeader = injectExportButtonIntoHeader;
})();