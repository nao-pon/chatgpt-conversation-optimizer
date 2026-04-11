(() => {
  /**
   * Extracts Markdown text from a `.cgo-message-markdown` child of a message section.
   *
   * @param {Element|null|undefined} section - Parent element that may contain a `.cgo-message-markdown` element.
   * @returns {string} The parsed Markdown string from the element's textContent, or an empty string if the element is missing or its content cannot be parsed.
   */
  function getMessageMarkdown(section) {
    const scriptEl = section?.querySelector(".cgo-message-markdown");
    if (!scriptEl) return "";
    try {
      return JSON.parse(scriptEl.textContent || '""');
    } catch (_) {
      return "";
    }
  }

  /**
   * Set a button's markdown-copy status by updating its `data-state` attribute.
   *
   * If `button` is falsy, the function does nothing. When `state` is falsy, the
   * attribute is set to an empty string.
   * @param {HTMLElement|null|undefined} button - The button element to update.
   * @param {string|undefined} state - The state value to apply (e.g., "working", "done", "error").
   */
  function setMarkdownCopyState(button, state) {
    if (!button) return;
    button.setAttribute("data-state", state || "");
  }

  /**
   * Create (or return an existing) modal backdrop used for copying Markdown and attach its close handlers.
   *
   * @param {Function} [getLabel] - Optional function (key, fallback) => string used to obtain localized labels for the dialog title and close button; when omitted or not a function, falls back to Japanese title "Markdownをコピー" and English close label "Close".
   * @returns {HTMLElement} The backdrop element with id "cgo-md-modal-backdrop"; the element is created and appended to document.body if it did not already exist.
   */
  function ensureMarkdownModal(getLabel) {
    let backdrop = document.getElementById("cgo-md-modal-backdrop");
    if (backdrop) return backdrop;

    const label = typeof getLabel === "function" ? getLabel("copy_markdown_button", "Markdownをコピー") : "Markdownをコピー";
    const closeLabel = typeof getLabel === "function" ? getLabel("close_button", "Close") : "Close";

    backdrop = document.createElement("div");
    backdrop.id = "cgo-md-modal-backdrop";
    backdrop.className = "cgo-md-modal-backdrop";
    backdrop.hidden = true;
    backdrop.innerHTML = `
      <div class="cgo-md-modal" role="dialog" aria-modal="true" aria-labelledby="cgo-md-modal-title">
        <div class="cgo-md-modal-header">
          <div class="cgo-md-modal-title" id="cgo-md-modal-title">${label}</div>
          <button type="button" class="cgo-md-modal-close" aria-label="${closeLabel}">×</button>
        </div>
        <div class="cgo-md-modal-body">
          <textarea class="cgo-md-modal-textarea" spellcheck="false"></textarea>
        </div>
      </div>`;
    document.body.appendChild(backdrop);

    const closeModal = () => { backdrop.hidden = true; };
    backdrop.querySelector(".cgo-md-modal-close")?.addEventListener("click", closeModal);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeModal();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !backdrop.hidden) closeModal();
    });

    return backdrop;
  }

  /**
   * Open the Markdown copy modal, populate it with the provided text, and focus/select the textarea content.
   * @param {string} text - The Markdown text to display in the modal; if falsy, the textarea is cleared.
   * @param {function(string, string): string} [getLabel] - Optional label resolver used when creating the modal; receives (key, fallback).
   */
  function showMarkdownModal(text, getLabel) {
    const backdrop = ensureMarkdownModal(getLabel);
    const textarea = backdrop.querySelector(".cgo-md-modal-textarea");
    textarea.value = text || "";
    backdrop.hidden = false;
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
    });
  }

  /**
   * Copy the provided text to the clipboard using the Clipboard API with an off-screen textarea fallback.
   * @param {string} text - The text to copy.
   * @returns {boolean} `true` if the text was copied to the clipboard; `false` if copying failed or `text` is empty.
   */
  async function copyTextRobust(text) {
    if (!text) return false;

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {}

    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.left = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const ok = document.execCommand("copy");
      ta.remove();
      return !!ok;
    } catch (_) {
      return false;
    }
  }

  /**
   * Initialize syntax highlighting for all `pre code` blocks using `window.hljs`.
   *
   * If `window.hljs` is not present this function does nothing. When `IntersectionObserver`
   * is available it lazily highlights blocks as they enter the viewport (with a 200px
   * root margin) and marks processed blocks to avoid re-highlighting; otherwise it
   * highlights all blocks immediately.
   */
  function initLazyHighlight() {
    if (!window.hljs) return;
    const blocks = document.querySelectorAll("pre code");
    if (!("IntersectionObserver" in window)) {
      blocks.forEach((el) => {
        try { window.hljs.highlightElement(el); } catch (_) {}
      });
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        if (el.dataset.hl === "1") {
          observer.unobserve(el);
          continue;
        }
        try {
          window.hljs.highlightElement(el);
          el.dataset.hl = "1";
        } catch (_) {}
        observer.unobserve(el);
      }
    }, { rootMargin: "200px 0px", threshold: 0.01 });
    blocks.forEach((el) => observer.observe(el));
  }

  /**
   * Waits for the global `hljs` library to become available and then initializes lazy highlighting.
   *
   * Polls for `window.hljs` every 50ms until present, then calls `initLazyHighlight`.
   */
  function waitForHljs() {
    if (window.hljs) {
      initLazyHighlight();
      return;
    }
    setTimeout(waitForHljs, 50);
  }

  /**
   * Initialize CGO export UI behavior and event handlers.
   *
   * Registers document-level handlers for markdown copying (with modal fallback), code copying, code collapse/expand, and thought-panel toggles, and optionally starts lazy syntax highlighting.
   *
   * @param {Object} [options] - Configuration options.
   * @param {boolean} [options.enableCodeActions=true] - When false, disables code-related copy and toggle actions.
   * @param {boolean} [options.enableHighlight=true] - When false, prevents initializing syntax highlighting.
   * @param {function(string, string): string} [options.getLabel] - Function to resolve UI labels; called as (key, fallback) and should return the label string.
   */
  function init(options = {}) {
    const enableCodeActions = options.enableCodeActions !== false;
    const enableHighlight = options.enableHighlight !== false;
    const getLabel = options.getLabel || ((key, fallback) => fallback || key);

    document.addEventListener("click", async (event) => {
      const markdownCopyBtn = event.target.closest(".cgo-markdown-copy-btn");
      if (markdownCopyBtn) {
        const section = markdownCopyBtn.closest(".message");
        const text = getMessageMarkdown(section);
        if (!text) return;

        setMarkdownCopyState(markdownCopyBtn, "working");
        const ok = await copyTextRobust(text);

        if (ok) {
          setMarkdownCopyState(markdownCopyBtn, "done");
        } else {
          showMarkdownModal(text, getLabel);
          setMarkdownCopyState(markdownCopyBtn, "error");
        }

        setTimeout(() => setMarkdownCopyState(markdownCopyBtn, ""), 1200);
        return;
      }

      const copyBtn = event.target.closest(".cgo-code-copy-btn");
      if (copyBtn && enableCodeActions) {
        const codeEl = copyBtn.closest(".cgo-code-block")?.querySelector("code");
        if (!codeEl) return;

        const oldText = copyBtn.textContent;
        const ok = await copyTextRobust(codeEl.textContent || "");
        copyBtn.textContent = ok
          ? getLabel("copied_button", "Copied")
          : getLabel("copy_failed_button", "Copy failed");

        setTimeout(() => { copyBtn.textContent = oldText; }, 1200);
        return;
      }

      const toggleBtn = event.target.closest(".cgo-code-toggle-btn");
      if (toggleBtn && enableCodeActions) {
        const block = toggleBtn.closest(".cgo-code-block");
        if (!block) return;
        const collapsed = block.classList.toggle("is-collapsed");
        toggleBtn.textContent = collapsed
          ? getLabel("expand_code_button", "Expand")
          : getLabel("collapse_code_button", "Collapse");
        return;
      }

      const thoughtBtn = event.target.closest(".cgo-thought-toggle");
      if (thoughtBtn) {
        const wrap = thoughtBtn.closest(".cgo-thoughts");
        if (!wrap) return;

        const targetId = thoughtBtn.getAttribute("data-target") || "";
        const target = Array.from(wrap.querySelectorAll(".cgo-thought-panel"))
          .find((el) => el.getAttribute("data-thought-panel-id") === targetId) || null;
        if (!target) return;

        const willOpen = target.hasAttribute("hidden");
        for (const btn of wrap.querySelectorAll(".cgo-thought-toggle")) {
          btn.setAttribute("aria-expanded", "false");
        }
        for (const panel of wrap.querySelectorAll(".cgo-thought-panel")) {
          panel.hidden = true;
        }
        if (willOpen) {
          target.hidden = false;
          thoughtBtn.setAttribute("aria-expanded", "true");
        }
      }
    }, { passive: false });

    if (enableHighlight) waitForHljs();
  }

  window.CGOExportUI = { init };
})();
