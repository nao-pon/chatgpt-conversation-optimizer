(() => {
  function i18nGetMessage(key, substitutions) {
    try {
      if (globalThis.chrome?.i18n?.getMessage) {
        const value = chrome.i18n.getMessage(key, substitutions);
        if (value) return value;
      }
    } catch (_) {}
    return "";
  }

  function t(key, substitutions) {
    const value = i18nGetMessage(key, substitutions);
    if (value) return value;
    if (key === "thought_item_fallback") {
      const n = Array.isArray(substitutions) ? substitutions[0] : substitutions;
      return `Thought ${n ?? ""}`.trim();
    }
    return key;
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function unescapeHtml(html) {
    const el = document.createElement("textarea");
    el.innerHTML = String(html || "");
    return el.value;
  }

  function stripChatgptUiArtifacts(text) {
    return String(text || "")
      .replace(/\uE200(?:filecite|cite)\uE202[\s\S]*?\uE201/g, "")
      .replace(/\uE200(?:filenavlist|navlist|schedule|forecast|standing|finance)\uE202[\s\S]*?\uE201/g, "")
      .replace(/[\uE200\uE201\uE202]/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function getMarkedTextValue(value) {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      if (typeof value.text === "string") return value.text;
      if (typeof value.raw === "string") return value.raw;
      if (typeof value.lang === "string") return value.lang;
    }
    return String(value ?? "");
  }

  function createMarkedRenderer() {
    const renderer = new marked.Renderer();

    renderer.code = function (codeOrToken, maybeLang) {
      let codeText = "";
      let langText = "";

      if (codeOrToken && typeof codeOrToken === "object") {
        codeText =
          typeof codeOrToken.text === "string" ? codeOrToken.text :
            typeof codeOrToken.raw === "string" ? codeOrToken.raw :
              "";
        langText =
          typeof codeOrToken.lang === "string" ? codeOrToken.lang :
            "";
      } else {
        codeText = getMarkedTextValue(codeOrToken);
        langText = getMarkedTextValue(maybeLang).trim();
      }

      const unescaped = unescapeHtml(codeText);
      const safe = escapeHtml(unescaped);
      const cls = langText ? ` language-${escapeHtml(langText)}` : "";

      return `
<div class="cgo-code-block">
  <div class="cgo-code-toolbar">
    <span class="cgo-code-lang">${escapeHtml(langText || "text")}</span>
    <div class="cgo-code-actions">
      <button type="button" class="cgo-code-copy-btn">${escapeHtml(t("copy_button"))}</button>
    </div>
  </div>
  <pre class="cgo-code-pre"><code class="cgo-code${cls}">${safe}</code></pre>
</div>`;
    };

    renderer.codespan = function (codeOrToken) {
      const codeText = getMarkedTextValue(codeOrToken);
      return `<code>${escapeHtml(unescapeHtml(codeText))}</code>`;
    };

    return renderer;
  }

  function renderMessageTextToHtml(text) {
    const source = typeof text === "string" ? text : "";
    if (!source.trim()) return "";

    const escapedSrc = escapeHtml(stripChatgptUiArtifacts(source));

    if (typeof marked === "undefined") {
      return `<div class="cgo-markdown"><p>${escapedSrc.replace(/\n/g, "<br>")}</p></div>`;
    }

    const rawHtml = marked.parse(escapedSrc, {
      breaks: true,
      gfm: true,
      renderer: createMarkedRenderer(),
    });

    const safeHtml =
      typeof DOMPurify !== "undefined"
        ? DOMPurify.sanitize(rawHtml, {
          USE_PROFILES: { html: true },
          FORBID_TAGS: ["style", "script", "iframe", "object", "embed"],
          FORBID_ATTR: ["style", "onerror", "onclick", "onload"],
        })
        : rawHtml;

    const wrapper = document.createElement("div");
    wrapper.innerHTML = safeHtml;

    for (const a of wrapper.querySelectorAll("a")) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    }

    return `<div class="cgo-markdown">${wrapper.innerHTML}</div>`;
  }

  function getThoughtIconSvg() {
    return `
<svg viewBox="0 0 24 24" aria-hidden="true" class="cgo-thought-icon">
  <path fill="currentColor" d="M12 4c-4.42 0-8 2.91-8 6.5 0 1.94 1.05 3.68 2.74 4.87-.12.92-.52 1.89-1.34 2.77 1.64-.15 3.08-.74 4.23-1.72.73.18 1.52.28 2.37.28 4.42 0 8-2.91 8-6.5S16.42 4 12 4zm-3 6.5a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm3 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm3 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z"/>
</svg>`;
  }

  function getMarkdownCopyIconSvg() {
    return `
<svg viewBox="0 0 24 24" aria-hidden="true" class="cgo-markdown-copy-icon">
  <path d="M8.5 3.75h6.6l3.15 3.15v9.85a2.25 2.25 0 0 1-2.25 2.25H8.5a2.25 2.25 0 0 1-2.25-2.25V6A2.25 2.25 0 0 1 8.5 3.75Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
  <path d="M15 3.9v3.1h3.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M9.35 10.2h5.3M9.35 13h5.3M9.35 15.8h3.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  <path d="M4.6 7.75v9.9a2.25 2.25 0 0 0 2.25 2.25h7.9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.72"/>
</svg>`;
  }

  function formatExportDate(value) {
    if (!value) return "";
    try {
      return new Date(value * 1000).toLocaleString();
    } catch {
      return "";
    }
  }

  function renderThoughts(thoughts, messageId) {
    if (!Array.isArray(thoughts) || thoughts.length === 0) return "";

    const safeMessageId = String(messageId || "thoughts")
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "thoughts";

    const buttonsHtml = [];
    const panelsHtml = [];

    thoughts.forEach((item, index) => {
      const summaryText = item?.summary || t("thought_item_fallback", [String(index + 1)]);
      const summary = escapeHtml(summaryText);
      const contentHtml = item?.content ? renderMessageTextToHtml(item.content) : "";
      const finishedHtml = item?.finished
        ? `<span class="cgo-thought-finished">${escapeHtml(t("thought_finished_label"))}</span>`
        : "";
      const panelId = `cgo-thought-${safeMessageId}-${index + 1}`;

      buttonsHtml.push(`
<button type="button" class="cgo-thought-toggle" data-target="${panelId}" title="${summary}" aria-label="${summary}" aria-expanded="false">${getThoughtIconSvg()}</button>`);

      panelsHtml.push(`
<div class="cgo-thought-panel" data-thought-panel-id="${panelId}" hidden>
  <div class="cgo-thought-panel-header">
    <span class="cgo-thought-summary">${summary}</span>
    ${finishedHtml}
  </div>
  <div class="cgo-thought-body">${contentHtml}</div>
</div>`);
    });

    return `<div class="cgo-thoughts cgo-markdown" aria-label="${escapeHtml(t("thoughts_toggle_label"))}">
  <hr>
  <div class="cgo-thoughts-toolbar">${buttonsHtml.join("\n")}</div>
  <div class="cgo-thoughts-panels">${panelsHtml.join("\n")}</div>
</div>`;
  }

  function renderImageMeta(image) {
    const parts = [];

    if (image?.width && image?.height) {
      parts.push(`${image.width}×${image.height}`);
    }
    if (image?.fileSizeBytes) {
      const bytes = Number(image.fileSizeBytes || 0);
      if (bytes > 0) {
        const units = ["B", "KB", "MB", "GB"];
        let value = bytes;
        let unitIndex = 0;
        while (value >= 1024 && unitIndex < units.length - 1) {
          value /= 1024;
          unitIndex += 1;
        }
        parts.push(`${value.toFixed(value < 10 && unitIndex > 0 ? 1 : 0)} ${units[unitIndex]}`);
      }
    }
    if (image?.mimeType) {
      parts.push(String(image.mimeType));
    }

    if (!parts.length) return "";
    return `<div class="cgo-image-meta">${escapeHtml(parts.join(" · "))}</div>`;
  }

  function renderImages(images) {
    if (!Array.isArray(images) || images.length === 0) return "";

    const internalItems = [];
    const externalItems = [];

    for (const image of images) {
      const src = image?.embeddedUrl || image?.url || "";
      const alt = escapeHtml(image?.alt || "");
      const caption = escapeHtml(image?.alt || image?.title || "");

      const figureHtml = src
        ? `<figure class="cgo-image${/^https?:\/\//i.test(src) ? " cgo-image-external" : ""}">
            <img src="${escapeHtml(src)}" alt="${alt}"${/^https?:\/\//i.test(src) ? ' loading="lazy" referrerpolicy="no-referrer"' : ""}>
            ${caption ? `<figcaption>${caption}</figcaption>` : ""}
            ${renderImageMeta(image)}
          </figure>`
        : `<figure class="cgo-image cgo-image-missing">
            <div class="cgo-image-missing-box">${escapeHtml(t("image_not_include_label"))}</div>
            ${caption ? `<figcaption>${caption}</figcaption>` : ""}
          </figure>`;

      if (/^https?:\/\//i.test(src)) {
        externalItems.push(figureHtml);
      } else {
        internalItems.push(figureHtml);
      }
    }

    return [
      internalItems.length ? `<div class="cgo-images cgo-images-internal">${internalItems.join("\n")}</div>` : "",
      externalItems.length ? `<div class="cgo-images cgo-images-external">${externalItems.join("\n")}</div>` : "",
    ].join("\n");
  }

  function renderAttachments(attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) return "";

    return `<div class="cgo-attachments">${attachments.map((attachment) => {
      const name = escapeHtml(attachment?.name || "attachment");
      const href = attachment?.localPath || attachment?.url || "";
      const meta = escapeHtml(t("attachment_not_embedded_label"));

      return `<div class="cgo-attachment">
        <div class="cgo-attachment-icon" aria-hidden="true">📎</div>
        <div class="cgo-attachment-main">
          <div class="cgo-attachment-name">${name}</div>
          <div class="cgo-attachment-meta">${meta}</div>
        </div>
        <div class="cgo-attachment-actions">
          ${href ? `<a target="_blank" rel="noopener noreferrer" href="${escapeHtml(href)}">${escapeHtml(t("attachment_open_link"))}</a>` : ""}
        </div>
      </div>`;
    }).join("\n")}</div>`;
  }

  function buildMessageHtml(message) {
    const roleLabel = message.role === "user" ? t("role_user") : t("role_assistant");
    const dateText = formatExportDate(message.createTime);
    const sourceText = typeof message.renderText === "string" ? message.renderText : (message.text || "");
    const rawMarkdownJson = JSON.stringify(typeof sourceText === "string" ? sourceText : "").replace(/<\//g, "<\/");

    return `<section class="message ${escapeHtml(message.role || "")}" id="mes-${escapeHtml(message.id || "")}">
  <script type="application/json" class="cgo-message-markdown">${rawMarkdownJson}</script>
  <div class="message-header">
    <div class="message-header-main">
      <span class="message-role">${escapeHtml(roleLabel)}</span>
      <span class="message-date">${escapeHtml(dateText)}</span>
    </div>
    <div class="message-header-actions">
      <button type="button" class="cgo-icon-btn cgo-markdown-copy-btn" title="${escapeHtml(t("copy_markdown_button"))}" aria-label="${escapeHtml(t("copy_markdown_button"))}">
        ${getMarkdownCopyIconSvg()}
        <span class="cgo-icon-tooltip">${escapeHtml(t("copy_markdown_button"))}</span>
      </button>
    </div>
  </div>
  <div class="message-body">
    ${renderMessageTextToHtml(sourceText)}
    ${renderThoughts(message.thoughts || [], message.id)}
    ${renderImages(message.visibleImages || message.images || [])}
    ${renderAttachments(message.visibleAttachments || message.attachments || [])}
  </div>
</section>`;
  }

  async function loadPayload() {
    const params = new URLSearchParams(location.search);
    const token = params.get("token");
    if (!token) throw new Error("viewer token not found");

    const key = `cgo_viewer_${token}`;
    const stored = await chrome.storage.local.get(key);
    const payload = stored?.[key];

    await chrome.storage.local.remove(key);

    if (!payload) throw new Error("viewer payload not found");
    return payload;
  }

  function installHandlers(payload) {
    window.CGOExportUI?.init({
      enableCodeActions: true,
      enableHighlight: false,
      getLabel: (key, fallback) => t(key) || fallback || key,
    });
  }

  async function main() {
    try {
      const payload = await loadPayload();

      document.documentElement.lang = chrome?.i18n?.getUILanguage?.() || document.documentElement.lang || "en";
      document.title = payload.title || t("untitled_conversation") || "CGO Viewer";
      document.getElementById("page-title").textContent = payload.title || t("untitled_conversation");
      document.getElementById("page-meta").innerHTML = `
        <span>${escapeHtml(t("conversation_id"))}: ${escapeHtml(payload.conversationId || "")}</span>
        <span>${escapeHtml(t("exported_at"))}: ${escapeHtml(new Date(payload.exportedAt || Date.now()).toLocaleString())}</span>`;

      const app = document.getElementById("app");
      app.innerHTML = (payload.messages || []).map(buildMessageHtml).join("\n");

      installHandlers(payload);

      if (payload.messageId && typeof CSS !== "undefined" && CSS.escape) {
        document.getElementById(`mes-${CSS.escape(payload.messageId)}`)?.scrollIntoView({ block: "start" });
      }
    } catch (error) {
      document.title = "CGO Viewer Error";
      document.getElementById("page-title").textContent = "CGO Viewer Error";
      document.getElementById("app").innerHTML = `<pre>${escapeHtml(String(error?.message || error))}</pre>`;
      console.error(error);
    }
  }

  main();
})();
