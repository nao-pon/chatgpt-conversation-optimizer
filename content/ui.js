(() => {
  if (globalThis.__CGO_SKIP__) return;
  const CGO = (globalThis.__CGO ||= {});
  with (CGO) {
    CGO.createHeaderButton = function createHeaderButton(html, text, callback) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cgo-btn";
      button.title = text
      button.ariaLabel = text
      button.innerHTML = html;
     
      button.addEventListener("click", callback);
     
      return button;
    }

    CGO.createSvgIcon = function createSvgIcon(pathD, viewBox = "0 0 24 24") {
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

    CGO.getButtonIconSvg = function getButtonIconSvg(kind) {
      switch (kind) {
        case "settings":
          return createSvgIcon("M19.14 12.94a7.49 7.49 0 0 0 .05-.94 7.49 7.49 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.28 7.28 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.49-.42h-3.84a.5.5 0 0 0-.49.42l-.36 2.54a7.28 7.28 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.49 7.49 0 0 0-.05.94 7.49 7.49 0 0 0 .05.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.39 1.05.71 1.63.94l.36 2.54a.5.5 0 0 0 .49.42h3.84a.5.5 0 0 0 .49-.42l.36-2.54c.58-.23 1.13-.55 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z");
        case "light":
          return createSvgIcon("M13 2L6 14h5l-1 8 8-12h-5l1-8z");
        case "html":
          return createSvgIcon("M6 2h9l5 5v15a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm8 1.5V8h4.5", "0 0 24 24");
        case "zip":
          return createSvgIcon("M12 3v10.17l3.59-3.58L17 11l-5 5-5-5 1.41-1.41L11 13.17V3h1zM5 19h14v2H5z");
        case "alert":
          return createSvgIcon("M12 3 2 21h20L12 3zm0 5.5a1 1 0 0 1 1 1V14a1 1 0 1 1-2 0V9.5a1 1 0 0 1 1-1zm0 9a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z");
        default:
          return createSvgIcon("M12 3v18M3 12h18");
      }
    }

    CGO.buildToolbarButton = function buildToolbarButton({ title, iconKind }) {
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

    CGO.setToolbarButtonText = function setToolbarButtonText(button, text = "") {
      const icon = button.querySelector(".cgo-btn-icon");
      const label = button.querySelector(".cgo-btn-label");
      if (!icon || !label) return;

      if (text) {
        //icon.hidden = true;
        label.hidden = false;
        label.textContent = text;
      } else {
        label.textContent = "";
        label.hidden = true;
        //icon.hidden = false;
      }
    }

    CGO.createOpenNewTabButton = function createOpenNewTabButton() {
      const button = buildToolbarButton({
        title: t("open_new_tab_button"),
        iconKind: "light",
      });

      button.addEventListener("click", async () => {
        try {
          setExportButtonState(button, "loading");
          await exportCurrentConversationAsHtml(button, getCurrentVisibleMessageId());
          setExportButtonState(button, "idle");
          setToolbarButtonText(button, "");
        } catch (error) {
          log("[error]", error);
          setExportButtonState(button, "export_retry");
        }
      });

      return button;
    }

    CGO.createExportButton = function createExportButton() {
      const button = buildToolbarButton({
        title: t("download_button"),
        iconKind: "html",
      });

      button.addEventListener("click", async () => {
        try {
          setExportButtonState(button, "loading");
          await exportCurrentConversationAsHtml(button);
          setExportButtonState(button, "idle");
          setToolbarButtonText(button, "");
        } catch (error) {
          log("[error]", error);
          setExportButtonState(button, "export_retry");
        }
      });

      return button;
    }

    CGO.createZipExportButton = function createZipExportButton() {
      const button = buildToolbarButton({
        title: t("zip_download_button"),
        iconKind: "zip",
      });

      button.addEventListener("click", async () => {
        try {
          setExportButtonState(button, "loading");
          await exportCurrentConversationAsZip(button);
          setExportButtonState(button, "idle");
          setToolbarButtonText(button, "");
        } catch (error) {
          log("[error]", error);
          setExportButtonState(button, "error");
        }
      });

      return button;
    }

    CGO.toggleSettingsPanel = function toggleSettingsPanel(button) {
      const panel = document.getElementById("cgo-settings-panel");
      if (!panel) return;
      if (panel.hidden) {
        openSettingsPanel(button);
      } else {
        panel.hidden = true;
      }
    }

    CGO.closeSettingsPanel = function closeSettingsPanel() {
      const panel = document.getElementById("cgo-settings-panel");
      if (!panel) return;
      panel.hidden = true;
    }

    CGO.createSettingsButton = function createSettingsButton() {
      const button = buildToolbarButton({
        title: t("settings_button") || "Settings",
        iconKind: "settings",
      });

      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleSettingsPanel(button);
        //openSettingsPanel(button);
      });

      return button;
    }

    CGO.createProjectGuideAlertButton = function createProjectGuideAlertButton() {
      const title =
        t("project_guide_alert_tooltip") ||
        t("project_guide_alert_button") ||
        "Very large conversation";

      const button = buildToolbarButton({
        title,
        iconKind: "alert",
      });

      button.id = "cgo-project-guide-alert";
      button.classList.add("cgo-project-guide-alert");
      button.hidden = true;
      button.dataset.pulsed = "0";

      button.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();

        try {
          const conversationId =
            STATE.projectGuide?.conversationId ||
            getConversationIdFromLocation?.() ||
            "";

          if (!conversationId) return;

          await clearProjectGuideDismissed(conversationId);

          button.dataset.pulsed = "1";

          await updateProjectGuideVisibility?.();
          await updateProjectGuideAlertVisibility?.();
        } catch (error) {
          log("[warn] reopen project guide failed", String(error));
        }
      });

      return button;
    }

    CGO.buildSettingsPanel = function buildSettingsPanel() {
      const panel = document.createElement("div");
      panel.id = "cgo-settings-panel";
      panel.className = "cgo-settings-panel";
      panel.hidden = true;

      panel.innerHTML = `
        <div class="cgo-settings-title">${escapeHtml(t("settings_button") || "Settings")}</div>

        <label class="cgo-settings-row">
          <span>${escapeHtml(t("keep_dom_messages_label"))}</span>
          <input id="cgo-setting-keep-dom-messages" type="number" min="5" max="200" step="1">
        </label>

        <label class="cgo-settings-row cgo-settings-check">
          <input id="cgo-setting-auto-adjust-enabled" type="checkbox">
          <span id="cgo-setting-auto-adjust-label">${escapeHtml(t("auto_adjust_disabled_label"))}</span>
        </label>

        <label class="cgo-settings-row cgo-settings-check">
          <input id="cgo-setting-html-include-images" type="checkbox">
          <span>${escapeHtml(t("html_include_images_label"))}</span>
        </label>

        <div class="cgo-settings-actions">
          <button type="button" class="cgo-settings-save-btn">${escapeHtml(t("save_button"))}</button>
          <button type="button" class="cgo-settings-cancel-btn">${escapeHtml(t("cancel_button"))}</button>
        </div>
      `;

      const keepInput = panel.querySelector("#cgo-setting-keep-dom-messages");
      const autoAdjustInput = panel.querySelector("#cgo-setting-auto-adjust-enabled");
      const autoAdjustLabel = panel.querySelector("#cgo-setting-auto-adjust-label");
      const htmlImagesInput = panel.querySelector("#cgo-setting-html-include-images");
      const saveBtn = panel.querySelector(".cgo-settings-save-btn");
      const cancelBtn = panel.querySelector(".cgo-settings-cancel-btn");

      /**
       * Update the auto-adjust label text to reflect the current effective keepDomMessages value.
       *
       * If the auto-adjust toggle is off, the label is set to the configured "disabled" text.
       * If the toggle is on, the function determines the effective value (conversation-specific override if available,
       * otherwise SETTINGS or CONFIG with a fallback of 40), clamps it to valid bounds, and sets the label to the
       * configured "enabled" text with that value. On error, a warning is logged and the label is set using the
       * fallback value.
       */
      async function updateAutoAdjustLabel() {
        if (!autoAdjustLabel) return;

        const disabledLabel = t("auto_adjust_disabled_label");

        if (!autoAdjustInput.checked) {
          autoAdjustLabel.textContent = disabledLabel;
          return;
        }

        try {
          const conversationId = getConversationIdFromLocation?.() || "";
          let effective = SETTINGS.keepDomMessages ?? CONFIG.keepDomMessages ?? 40;

          if (conversationId) {
            const override = await loadConversationOverride(conversationId);

            if (override?.keepDomMessages) {
              effective = clampKeepDomMessages(override.keepDomMessages);
            }
          }

          autoAdjustLabel.textContent = t("auto_adjust_enabled_label", String(effective));
        } catch (error) {
          log("[warn] updateAutoAdjustLabel failed", String(error));
          autoAdjustLabel.textContent =
            t("auto_adjust_enabled_label", String(SETTINGS.keepDomMessages ?? CONFIG.keepDomMessages ?? 40));
        }
      }

      /**
       * Populate the settings panel inputs from persisted configuration and refresh the auto-adjust label.
       *
       * Reads values from `SETTINGS` (falling back to `CONFIG` and defaults) to set the keep-dom-messages input,
       * the auto-adjust checkbox, and the HTML-images checkbox, then updates the auto-adjust descriptive label.
       */
      async function syncFromSettings() {
        keepInput.value = String(SETTINGS.keepDomMessages ?? CONFIG.keepDomMessages ?? 40);
        autoAdjustInput.checked = !!SETTINGS.autoAdjustEnabled;
        htmlImagesInput.checked = SETTINGS.htmlDownloadIncludeImages !== false;
        await updateAutoAdjustLabel();
      }

      saveBtn.addEventListener("click", async () => {
        try {
          const conversationId = getConversationIdFromLocation?.() || "";
          const wasAutoAdjustEnabled = !!SETTINGS.autoAdjustEnabled;
          const nextAutoAdjustEnabled = !!autoAdjustInput.checked;

          await saveSettings({
            keepDomMessages: keepInput.value,
            autoAdjustEnabled: nextAutoAdjustEnabled,
            htmlDownloadIncludeImages: htmlImagesInput.checked,
          });

          if (wasAutoAdjustEnabled && !nextAutoAdjustEnabled && conversationId) {
            await clearConversationOverride(conversationId);
            log("[autoAdjust] cleared conversation override", { conversationId });
          }

          await postSettingsToPageHook?.();
          await syncFromSettings();
          closeSettingsPanel();
          log("settings saved", { ...SETTINGS });
        } catch (error) {
          log("[error] saveSettings failed", String(error));
        }
      });

      autoAdjustInput.addEventListener("change", () => {
        void updateAutoAdjustLabel();
      });

      cancelBtn.addEventListener("click", () => {
        syncFromSettings();
        closeSettingsPanel();
      });

      panel.addEventListener("click", (event) => {
        event.stopPropagation();
      });
      panel.__cgoSyncFromSettings = syncFromSettings;

      syncFromSettings();
      return panel;
    }

    CGO.ensureSettingsPanel = function ensureSettingsPanel() {
      let panel = document.getElementById("cgo-settings-panel");
      if (panel) return panel;

      const headerActions = document.getElementById("conversation-header-actions");
      if (!headerActions) return null;

      panel = buildSettingsPanel();
      document.body.appendChild(panel);
      return panel;
    }

    CGO.openSettingsPanel = function openSettingsPanel(buttonEl) {
      const panel = ensureSettingsPanel();
      if (!panel) return;

      const rect = buttonEl.getBoundingClientRect();
      const panelWidth = 200;
      let left = rect.right - panelWidth;
      if (left < 8) left = 8;
      if (left + panelWidth > window.innerWidth - 8) {
        left = window.innerWidth - panelWidth - 8;
      }
      panel.style.position = "fixed";
      panel.style.top = `${rect.bottom + 8}px`;
      panel.style.left = `${left}px`; // 幅に応じて調整
      panel.hidden = false;
    }

    CGO.ensureProjectGuide = function ensureProjectGuide() {
      let guide = document.getElementById("cgo-project-guide");
      if (guide) return guide;

      const headerActions = document.getElementById("conversation-header-actions");
      if (!headerActions) return null;

      guide = document.createElement("div");
      guide.id = "cgo-project-guide";
      guide.className = "cgo-project-guide";
      guide.hidden = true;

      guide.innerHTML = `
        <div class="cgo-project-guide-main">
          <div class="cgo-project-guide-title"></div>
          <div class="cgo-project-guide-body"></div>
        </div>
        <div class="cgo-project-guide-actions">
          <button type="button" class="cgo-project-guide-zip"></button>
          <button type="button" class="cgo-project-guide-hide"></button>
        </div>
      `;

      const zipBtn = guide.querySelector(".cgo-project-guide-zip");
      const hideBtn = guide.querySelector(".cgo-project-guide-hide");

      zipBtn.textContent = t("zip_download_button") || "Save as ZIP";
      hideBtn.textContent = t("hide_button") || "Hide";

      zipBtn.addEventListener("click", async () => {
        try {
          zipBtn.disabled = true;
          await exportCurrentConversationAsZip();
        } catch (error) {
          log("[error] project guide zip export failed", String(error));
        } finally {
          zipBtn.disabled = false;
        }
      });

      hideBtn.addEventListener("click", async () => {
        try {
          const conversationId = STATE.projectGuide?.conversationId || getConversationIdFromLocation?.() || "";
          const level = Number(STATE.projectGuide?.level || 0);
          await dismissProjectGuide(conversationId, level);
          guide.hidden = true;
          await updateProjectGuideAlertVisibility?.();
        } catch (error) {
          log("[warn] dismissProjectGuide failed", String(error));
        }
      });

      headerActions.after(guide);
      return guide;
    }

    CGO.getProjectGuideTexts = function getProjectGuideTexts({ level = 0, projectName = "" } = {}) {
      const inProject = !!String(projectName || "").trim();

      if (level <= 0) {
        return { title: "", body: "" };
      }

      const lvl = level >= 3 ? 3 : level === 2 ? 2 : 1;

      if (inProject) {
        return {
          title: t(`project_guide_title_project_level${lvl}`),
          body: t(`project_guide_body_project_level${lvl}`, projectName),
        };
      }

      return {
        title: t(`project_guide_title_level${lvl}`),
        body: t(`project_guide_body_level${lvl}`),
      };
    }

    CGO.updateProjectGuideVisibility = async function updateProjectGuideVisibility() {
      const guide = ensureProjectGuide();
      if (!guide) return;

      const pathname = location.pathname || "";
      if (!/^(\/g\/[^/]+)?\/c\/([^/?#]+)/i.test(pathname)) {
        guide.hidden = true;
        return;
      }

      const conversationId = STATE.projectGuide?.conversationId || getConversationIdFromLocation?.() || "";
      const projectName = STATE.projectGuide?.projectName || "";
      const stats = STATE.projectGuide?.stats || null;
      const level = Number(STATE.projectGuide?.level || 0);

      if (!conversationId || !stats || level <= 0) {
        guide.hidden = true;
        return;
      }

      const dismissed = await isProjectGuideDismissed(conversationId, level);
      if (dismissed) {
        guide.hidden = true;
        return;
      }

      const titleEl = guide.querySelector(".cgo-project-guide-title");
      const bodyEl = guide.querySelector(".cgo-project-guide-body");

      const texts = getProjectGuideTexts({ level, projectName });
      titleEl.textContent = texts.title;
      bodyEl.textContent = texts.body;

      guide.dataset.level = String(level);
      guide.hidden = false;
      await updateProjectGuideAlertVisibility?.();
    }

    CGO.updateProjectGuideAlertVisibility = async function updateProjectGuideAlertVisibility() {
      const button = document.getElementById("cgo-project-guide-alert");
      if (!button) return;

      const pathname = location.pathname || "";
      if (!/^(\/g\/[^/]+)?\/c\/([^/?#]+)/i.test(pathname)) {
        button.hidden = true;
        button.classList.remove("cgo-pulse-once");
        return;
      }

      const conversationId =
        STATE.projectGuide?.conversationId ||
        getConversationIdFromLocation?.() ||
        "";

      const level = Number(STATE.projectGuide?.level || 0);

      if (!conversationId || level < 3) {
        button.hidden = true;
        button.classList.remove("cgo-pulse-once");
        return;
      }

      const dismissed = await isProjectGuideDismissed(conversationId, 3);

      button.title =
        t("project_guide_alert_tooltip") ||
        t("project_guide_alert_button") ||
        "Very large conversation";
      button.setAttribute("aria-label", button.title);

      const shouldShow = !!dismissed;
      const wasHidden = button.hidden;

      button.hidden = !shouldShow;

      if (shouldShow && wasHidden && button.dataset.pulsed !== "1") {
        button.classList.remove("cgo-pulse-once");
        void button.offsetWidth;
        button.classList.add("cgo-pulse-once");
        button.dataset.pulsed = "1";
      }

      if (!shouldShow) {
        button.classList.remove("cgo-pulse-once");
        button.dataset.pulsed = "0";
      }
    }

    CGO.injectExportButtonIntoHeader = function injectExportButtonIntoHeader() {
      if (!/^(\/g\/[^/]+)?\/c\/([a-z0-9-]+)/i.test(location.pathname)) return;

      if (document.querySelector("div.cgo-toolbar")) return;

      const headerActions = document.getElementById("conversation-header-actions");
      if (!headerActions) return;

      toolbarBase = document.createElement("div");
      toolbarBase.className = "cgo-toolbar";
      toolbarBase.hidden = true;

      const open_new_tab_button = createOpenNewTabButton();
      const download_button = createExportButton();
      const zip_download_button = createZipExportButton();
      const project_guide_alert_button = createProjectGuideAlertButton();
      const settings_button = createSettingsButton();

      toolbarBase.append(
        zip_download_button,
        download_button,
        open_new_tab_button,
        project_guide_alert_button,
        settings_button
      );

      headerActions.prepend(toolbarBase);
      ensureSettingsPanel();
      void updateProjectGuideAlertVisibility?.();
    }

    CGO.injectExportButtonStyle = function injectExportButtonStyle() {
      if (document.getElementById("cgo-export-style")) return;

      const style = document.createElement("style");
      style.id = "cgo-export-style";

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
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    min-width: 280px;
    padding: 12px;
    border-radius: 12px;
    border: 1px solid rgba(255,255,255,0.12);
    background: #1f1f1f;
    color: #f5f5f5;
    box-shadow: 0 10px 30px rgba(0,0,0,0.35);
    z-index: 10000;
  }

  .cgo-settings-title {
    font-size: 13px;
    font-weight: 700;
    margin-bottom: 10px;
  }

  .cgo-settings-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin: 8px 0;
    font-size: 13px;
  }

  .cgo-settings-row input[type="number"] {
    width: 78px;
    padding: 4px 6px;
    border-radius: 8px;
    border: 1px solid #555;
    background: #111;
    color: #f5f5f5;
  }

  .cgo-settings-check {
    justify-content: flex-start;
  }

  .cgo-settings-check input[type="checkbox"] {
    margin-right: 8px;
  }

  .cgo-settings-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
  }

  .cgo-settings-actions button {
    background: #2f2f2f;
    color: #f5f5f5;
    border: 1px solid #555;
    border-radius: 8px;
    padding: 6px 10px;
    cursor: pointer;
  }

  .cgo-settings-actions button:hover {
    background: #3b3b3b;
  }

  .cgo-project-guide {
    margin: 10px 16px 0 16px;
    padding: 10px 12px;
    border-radius: 12px;
    border: 1px solid rgba(255,255,255,0.14);
    background: rgba(255, 196, 0, 0.08);
    color: #f5f5f5;
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: space-between;
  }

  .cgo-project-guide[data-level="1"] {
    background: rgba(255, 196, 0, 0.06);
  }

  .cgo-project-guide[data-level="2"] {
    background: rgba(255, 166, 0, 0.09);
  }

  .cgo-project-guide[data-level="3"] {
    background: rgba(255, 120, 0, 0.12);
    border-color: rgba(255,255,255,0.22);
  }

  .cgo-project-guide-main {
    min-width: 0;
    flex: 1 1 auto;
  }

  .cgo-project-guide-title {
    font-size: 13px;
    font-weight: 700;
    line-height: 1.35;
    margin-bottom: 2px;
  }

  .cgo-project-guide-body {
    font-size: 12px;
    line-height: 1.45;
    color: rgba(245,245,245,0.86);
  }

  .cgo-project-guide-actions {
    display: flex;
    gap: 8px;
    flex: 0 0 auto;
    align-items: center;
  }

  .cgo-project-guide-actions button {
    background: rgba(255,255,255,0.06);
    color: #f5f5f5;
    border: 1px solid rgba(255,255,255,0.16);
    border-radius: 8px;
    padding: 6px 10px;
    cursor: pointer;
    font-size: 12px;
    white-space: nowrap;
  }

  .cgo-project-guide-actions button:hover {
    background: rgba(255,255,255,0.12);
  }

  .cgo-project-guide-alert {
    color: #f4c542;
  }

  .cgo-project-guide-alert:hover {
    color: #ffd666;
  }

  .cgo-project-guide-alert.cgo-pulse-once {
    animation: cgoPulseOnce 1.2s ease-out 1;
  }

  @keyframes cgoPulseOnce {
    0% {
      transform: scale(1);
      filter: drop-shadow(0 0 0 rgba(255, 214, 102, 0));
    }
    20% {
      transform: scale(1.12);
      filter: drop-shadow(0 0 6px rgba(255, 214, 102, 0.55));
    }
    45% {
      transform: scale(1);
      filter: drop-shadow(0 0 0 rgba(255, 214, 102, 0));
    }
    65% {
      transform: scale(1.08);
      filter: drop-shadow(0 0 4px rgba(255, 214, 102, 0.35));
    }
    100% {
      transform: scale(1);
      filter: drop-shadow(0 0 0 rgba(255, 214, 102, 0));
    }
  }
      `;

      document.head.appendChild(style);
    }

    CGO.setExportButtonState = function setExportButtonState(button, state) {
      if (!button) return;

      if (state === "idle") {
        button.disabled = false;
        button.setAttribute("aria-disabled", "false");
        button.classList.remove("cgo-btn-disabled");
        setToolbarButtonText(button, "");
      }

      if (state === "loading") {
        button.disabled = true;
        button.setAttribute("aria-disabled", "true");
        button.classList.add("cgo-btn-disabled");
        setToolbarButtonText(button, t("exporting"));
      }

      if (state === "error" || state === "export_retry") {
        button.disabled = false;
        button.setAttribute("aria-disabled", "false");
        button.classList.remove("cgo-btn-disabled");
        setToolbarButtonText(button, t("export_retry"));
      }
    }

    CGO.startHeaderButtonObserver = function startHeaderButtonObserver() {

      const observer = new MutationObserver(() => {
        injectExportButtonIntoHeader();
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true
      });

      injectExportButtonIntoHeader();
    }

    CGO.updateExportButtonVisibility = function updateExportButtonVisibility(state) {
      if (toolbarBase) {
        toolbarBase.hidden = !state;
      }
    }

    CGO.onDomReady = function onDomReady(callback) {
      if (
        document.readyState === "interactive" ||
        document.readyState === "complete"
      ) {
        callback();
        return;
      }

      window.addEventListener("DOMContentLoaded", callback, { once: true });
    }

    /*  window.addEventListener("keydown", (event) => {
        if (!location.pathname.startsWith("/c/")) return;
     
        if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "e") {
          event.preventDefault();
          event.stopPropagation();
          exportCurrentConversationAsHtml();
        }
      });*/
    // exporter end

  }
})();