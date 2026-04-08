(() => {
  function getMessageMarkdown(section) {
    const scriptEl = section?.querySelector(".cgo-message-markdown");
    if (!scriptEl) return "";
    try {
      return JSON.parse(scriptEl.textContent || '""');
    } catch (_) {
      return "";
    }
  }

  function setMarkdownCopyState(button, state) {
    if (!button) return;
    button.setAttribute("data-state", state || "");
  }

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

  function waitForHljs() {
    if (window.hljs) {
      initLazyHighlight();
      return;
    }
    setTimeout(waitForHljs, 50);
  }

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
