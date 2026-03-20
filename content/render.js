(() => {
  const CGO = (globalThis.CGO = globalThis.CGO || {});
  const DETECTION_LANG = CGO.getDetectionLanguage();

  // =========================
  // Helpers
  // =========================
  function formatExportDate(value) {
    if (!value) return "";
    try {
      return new Date(value * 1000).toLocaleString();
    } catch {
      return "";
    }
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

  function getAttachmentIcon(kind, isSandboxArtifact = false) {
    if (isSandboxArtifact) return "🧪";

    switch (kind) {
      case "archive":
        return "🗜️";
      case "pdf":
        return "📄";
      case "image":
        return "🖼️";
      case "text":
        return "📝";
      case "code":
        return "💻";
      default:
        return "📎";
    }
  }

  function getAttachmentSkipLabel(attachment) {
    const rawSkipReason = attachment?.skipReason || "";
    const [skipReason, skipValue] = String(rawSkipReason).split(":");

    switch (skipReason) {
      case "too_large":
        return CGO.t("attachment_skip_too_large", [
          formatBytes(Number(skipValue || 0))
        ]);
      case "unresolved":
        return CGO.t("attachment_skip_unresolved");
      case "sandbox":
        return CGO.t("attachment_skip_sandbox");
      case "unsupported_media":
        return CGO.t("attachment_skip_unsupported_media");
      case "auth":
        return CGO.t("attachment_skip_auth");
      case "server":
        return CGO.t("attachment_skip_server");
      case "network":
        return CGO.t("attachment_skip_network");
      case "not_found":
        return CGO.t("attachment_skip_not_found");
      default:
        return "";
    }
  }

  function renderImagePrompts(imagePrompts) {
    if (!Array.isArray(imagePrompts) || imagePrompts.length === 0) return "";

    return imagePrompts
      .map((item) => {
        const text = CGO.escapeHtml(item?.text || "");
        if (!text) return "";

        return `<div class="cgo-image-hint">
        <div class="cgo-image-hint-label">${CGO.escapeHtml(CGO.t("image_prompt_label"))}</div>
        <div class="cgo-image-hint-text">${text}</div>
      </div>`;
      })
      .join("\n");
  }

  function renderAttachments(attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) return "";

    const items = attachments.map((attachment) => {
      const icon = getAttachmentIcon(attachment.kind, attachment.isSandboxArtifact);
      const name = CGO.escapeHtml(attachment.name || CGO.t("attachment_unknown_name"));
      const kindLabel = CGO.escapeHtml(
        CGO.t(`attachment_kind_${attachment.kind || "attachment"}`)
      );
      const sizeText = CGO.escapeHtml(CGO.formatBytes(attachment.fileSizeBytes));
      const meta = [kindLabel, sizeText].filter(Boolean).join(" · ");

      let actionHtml = "";

      const skipLabel = getAttachmentSkipLabel(attachment);

      if (skipLabel) {
        actionHtml = `<span class="cgo-attachment-skip">${CGO.escapeHtml(skipLabel)}</span>`;
      } else if (attachment.isSandboxArtifact) {
        actionHtml = `<span>${CGO.escapeHtml(CGO.t("attachment_sandbox_artifact_label"))}</span>`;
      } else if (attachment.url) {
        actionHtml = `<a href="${CGO.escapeHtml(attachment.url)}" target="_blank" rel="noopener noreferrer">
    ${CGO.escapeHtml(CGO.t("attachment_open_link"))}
  </a>`;
      } else {
        actionHtml = `<span>${CGO.escapeHtml(CGO.t("attachment_not_embedded_label"))}</span>`;
      }

      return `<div class="cgo-attachment cgo-attachment-${CGO.escapeHtml(attachment.kind || "attachment")}">
      <div class="cgo-attachment-icon" aria-hidden="true">${CGO.escapeHtml(icon)}</div>
      <div class="cgo-attachment-main">
        <div class="cgo-attachment-name">${name}</div>
        ${meta ? `<div class="cgo-attachment-meta">${meta}</div>` : ""}
      </div>
      <div class="cgo-attachment-actions">
        ${actionHtml}
      </div>
    </div>`;
    });

    return `<div class="cgo-attachments">${items.join("\n")}</div>`;
  }

  // =========================
  // Renderer
  // =========================
  function createMarkedRenderer(options = {}) {
    const interactiveCode = options.interactiveCode !== false;
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

      const unescaped = CGO.unescapeHtml(codeText);
      const safe = CGO.escapeHtml(unescaped);
      const cls = langText ? ` language-${CGO.escapeHtml(langText)}` : "";
      const lineCount = unescaped.split("\n").length;
      const collapsible = interactiveCode && lineCount > 18;

      if (!interactiveCode) {
        return `
<div class="cgo-code-block">
  <div class="cgo-code-toolbar">
    <span class="cgo-code-lang">${CGO.escapeHtml(langText || "text")}</span>
  </div>
  <pre class="cgo-code-pre"><code class="cgo-code${cls}">${safe}</code></pre>
</div>`;
      }

      return `
<div class="cgo-code-block${collapsible ? " is-collapsible is-collapsed" : ""}">
  <div class="cgo-code-toolbar">
    <span class="cgo-code-lang">${CGO.escapeHtml(langText || "text")}</span>
    <div class="cgo-code-actions">
      ${collapsible ? `<button type="button" class="cgo-code-toggle-btn">${CGO.escapeHtml(CGO.t("expand_code_button"))}</button>` : ""}
      <button type="button" class="cgo-code-copy-btn">${CGO.escapeHtml(CGO.t("copy_button"))}</button>
    </div>
  </div>
  <pre class="cgo-code-pre"><code class="cgo-code${cls}">${safe}</code></pre>
</div>`;
    };

    renderer.codespan = function (codeOrToken) {
      const codeText = getMarkedTextValue(codeOrToken);
      const unescaped = CGO.unescapeHtml(codeText);
      const safe = CGO.escapeHtml(unescaped);
      return `<code>${safe}</code>`;
    };

    return renderer;
  }

  // =========================
  // Markdown
  // =========================
  CGO.renderMessageTextToHtml = function (text, options = {}) {
    const source = typeof text === "string" ? text : "";
    if (!source.trim()) return "";

    const escapedSrc = CGO.escapeHtml(source);

    if (typeof marked !== "undefined") {
      const renderer = createMarkedRenderer(options);

      const rawHtml = marked.parse(escapedSrc, {
        breaks: true,
        gfm: true,
        renderer,
      });

      const safeHtml =
        typeof DOMPurify !== "undefined"
          ? DOMPurify.sanitize(rawHtml, {
            USE_PROFILES: { html: true },
            FORBID_TAGS: ["style", "script", "iframe", "object", "embed"],
            FORBID_ATTR: ["style", "onerror", "onclick", "onload"],
          })
          : rawHtml;

      return `<div class="cgo-markdown">${safeHtml}</div>`;
    }

    return `<div class="cgo-markdown"><p>${escapedSrc.replace(/\n/g, "<br>")}</p></div>`;
  };

  // =========================
  // Image meta
  // =========================
  CGO.renderImageMeta = function (image) {
    const parts = [];

    if (image.width && image.height) {
      parts.push(`${image.width}×${image.height}`);
    }

    if (image.fileSizeBytes) {
      parts.push(CGO.formatBytes(image.fileSizeBytes));
    }

    if (image.mimeType) {
      parts.push(image.mimeType);
    }

    if (parts.length === 0) return "";

    return `<div class="cgo-image-meta">${CGO.escapeHtml(parts.join(" · "))}</div>`;
  };
  function renderImages(images) {
    if (!Array.isArray(images) || images.length === 0) return "";

    const internalItems = [];
    const externalItems = [];

    for (const image of images) {
      const html = renderSingleImageFigure(image, { mode: "html" });

      if (isProbablyExternalImage(image)) {
        externalItems.push(html);
      } else {
        internalItems.push(html);
      }
    }

    return [
      internalItems.length
        ? `<div class="cgo-images cgo-images-internal">${internalItems.join("\n")}</div>`
        : "",
      externalItems.length
        ? `<div class="cgo-images cgo-images-external">${externalItems.join("\n")}</div>`
        : "",
    ].join("\n");
  }

  CGO.buildConversationExportHtml = function (title, conversationId, messages, options = {}) {
    const imageRenderer = options.imageRenderer || renderImages;
    const attachmentRenderer = options.attachmentRenderer || renderAttachments;
    const interactiveCode = options.interactiveCode !== false;
    const highlightAssets = options.highlightAssets || null;
    const highlightAttach = options.highlightAttach || false;

    const messageHtml = messages.map((message) => {
      const roleLabel = message.role === "user" ? CGO.t("role_user") : CGO.t("role_assistant");
      const dateText = formatExportDate(message.createTime);
      const bodyHtml = CGO.renderMessageTextToHtml(message.text, { interactiveCode });

      return `
<section class="message ${CGO.escapeHtml(message.role)}" id="mes-${CGO.escapeHtml(message.id)}">
  <div class="message-header">
    <span class="message-role">${CGO.escapeHtml(roleLabel)}</span>
    <span class="message-date">${CGO.escapeHtml(dateText)}</span>
  </div>
  <div class="message-body">
    ${bodyHtml}
    ${imageRenderer(message.images || [])}
    ${renderImagePrompts(message.imagePrompts || [])}
    ${attachmentRenderer(message.attachments || [])}
  </div>
</section>`;
    }).join("\n");

    return `<!doctype html>
<html lang="${CGO.escapeHtml(DETECTION_LANG)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${CGO.escapeHtml(title)}</title>
  <style>
    ${buildExportCss()}
    ${highlightAssets?.css || ""}
  </style>
  <link rel="icon" type="image/vnd.microsoft.icon" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAdklEQVR4nGPkFxT9z0ABYKJEMwMDAwMLjKFrYEaSxssXThHngsMTf+OVp9gLeA0gZDvRLjg88TdOw3AagK7BNp+VNANs81nhmnBpxmsANleQbAAh2/EacHjib4KaGRgYGBhx5QVdAzN4aiPLBcQCnC4gFlDsAgAEZB4LCldHoQAAAABJRU5ErkJggg==">
</head>
<body>
  <header class="page-header">
    <h1 class="page-title">${CGO.escapeHtml(title || CGO.t("untitled_conversation"))}</h1>
    <div class="page-meta">
      <span>${CGO.escapeHtml(CGO.t("conversation_id"))}: ${CGO.escapeHtml(conversationId || "")}</span>
      <span>${CGO.escapeHtml(CGO.t("exported_at"))}: ${CGO.escapeHtml(new Date().toLocaleString())}</span>
    </div>
    ${highlightAttach ? `
    <link rel="stylesheet" href="assets/github-dark.min.css">
    <script src="assets/highlight.min.js"></script>` : ""}
  </header>
  ${messageHtml}
  ${interactiveCode ? getCodeEnhancementScript() : ""}
  ${interactiveCode && highlightAssets?.js
        ? `<script>${highlightAssets.js}</script>`
        : ""}
</body>
</html>`;
  }

  function buildExportCss() {
    return `
:root {
  color-scheme: light dark;
}
body {
  font-family:
    ui-sans-serif,
    system-ui,
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    "Helvetica Neue",
    Arial,
    sans-serif,
    "Apple Color Emoji",
    "Segoe UI Emoji",
    "Segoe UI Symbol",
    "Noto Color Emoji";
  max-width: 980px;
  margin: 0 auto;
  padding: 32px 20px 64px;
  line-height: 1.65;
  background: #ffffff;
  color: #111827;
}
.page-header {
  margin-bottom: 28px;
  padding-bottom: 16px;
  border-bottom: 1px solid #d1d5db;
}
.page-title {
  margin: 0 0 8px;
  font-size: 1.8rem;
  line-height: 1.25;
}
.page-meta {
  font-size: 0.95rem;
  color: #6b7280;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.message {
  margin: 0 0 28px;
  padding: 16px 18px;
  border-radius: 14px;
  border: 1px solid #e5e7eb;
  background: #fafafa;
}
.message.user {
  background: #eff6ff;
  border-color: #bfdbfe;
}
.message.assistant {
  background: #f0fdf4;
  border-color: #bbf7d0;
}
.message-header {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  font-size: 0.95rem;
}
.message-role {
  font-weight: 700;
  text-transform: capitalize;
}
.message-date {
  color: #6b7280;
  white-space: nowrap;
}
.message-body {
  overflow-wrap: anywhere;
}
.code-block {
  margin: 12px 0;
}
.code-lang {
  font-size: 0.85rem;
  color: #6b7280;
  margin-bottom: 6px;
}
pre {
  margin: 0;
  padding: 14px 16px;
  overflow: auto;
  border-radius: 10px;
  background: #111827;
  color: #f9fafb;
  line-height: 1.5;
}
code {
  font-family:
    ui-monospace,
    SFMono-Regular,
    Menlo,
    Consolas,
    "Liberation Mono",
    monospace;
  font-size: 0.92rem;
}
.cgo-images {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cgo-image img {
  display: block;
  max-width: min(100%, 560px);
  height: auto;
  border-radius: 10px;
  border: 1px solid #d1d5db;
}
.cgo-image figcaption {
  margin-top: 6px;
  font-size: 0.9rem;
  color: #6b7280;
}
.cgo-image-hint {
  margin-top: 10px;
  padding: 12px 14px;
  border: 1px dashed #9ca3af;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.03);
}
.cgo-image-hint-label {
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 4px;
  color: #6b7280;
}
.cgo-image-hint-text {
  font-size: 0.95rem;
}
.cgo-attachments {
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px dashed #d1d5db;
  font-size: 0.95rem;
}
.cgo-attachments-title {
  font-weight: 600;
  margin-bottom: 6px;
}
.cgo-attachments ul {
  margin: 0;
  padding-left: 20px;
}
.cgo-markdown > :first-child {
  margin-top: 0;
}
.cgo-markdown > :last-child {
  margin-bottom: 0;
}
.cgo-markdown p {
  margin: 0 0 1em;
}
.cgo-markdown h1,
.cgo-markdown h2,
.cgo-markdown h3,
.cgo-markdown h4,
.cgo-markdown h5,
.cgo-markdown h6 {
  margin: 1.2em 0 0.6em;
  line-height: 1.3;
}
.cgo-markdown ul,
.cgo-markdown ol {
  margin: 0 0 1em 1.4em;
}
.cgo-markdown li + li {
  margin-top: 0.25em;
}
.cgo-markdown blockquote {
  margin: 1em 0;
  padding: 0.1em 0 0.1em 1em;
  border-left: 4px solid #9ca3af;
  color: #4b5563;
}
.cgo-markdown pre {
  margin: 1em 0;
}
.cgo-markdown code {
  font-family:
    ui-monospace,
    SFMono-Regular,
    Menlo,
    Consolas,
    "Liberation Mono",
    monospace;
}
.cgo-markdown :not(pre) > code {
  padding: 0.15em 0.4em;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.08);
  font-size: 0.92em;
}
.cgo-markdown a {
  color: #2563eb;
  text-decoration: underline;
}
.cgo-markdown hr {
  border: 0;
  border-top: 1px solid #d1d5db;
  margin: 1.25em 0;
}
.cgo-image-missing-box {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 120px;
  max-width: min(100%, 560px);
  padding: 16px;
  border: 1px dashed #9ca3af;
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.03);
  color: #6b7280;
  font-size: 0.95rem;
}
.cgo-image-source {
  margin-top: 6px;
  font-size: 0.9rem;
  opacity: 0.9;
}
.cgo-image-source a {
  color: inherit;
  text-decoration: underline;
}
.cgo-image-external img {
  cursor: zoom-in;
}
.cgo-attachments {
  margin-top: 12px;
  display: grid;
  gap: 10px;
}
.cgo-attachment {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 10px;
}
.cgo-attachment-name {
  font-weight: 600;
  word-break: break-word;
}
.cgo-attachment-meta {
  margin-top: 4px;
  font-size: 0.9rem;
  opacity: 0.8;
}
.cgo-attachment-actions {
  flex: 0 0 auto;
  font-size: 0.95rem;
}
.cgo-attachments {
  margin-top: 12px;
  display: grid;
  gap: 10px;
}
.cgo-attachment {
  display: grid;
  grid-template-columns: 32px 1fr auto;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 10px;
}
.cgo-attachment-icon {
  font-size: 1.2rem;
  line-height: 1;
  text-align: center;
}
.cgo-attachment-name {
  font-weight: 600;
  word-break: break-word;
}
.cgo-attachment-meta {
  margin-top: 4px;
  font-size: 0.9rem;
  opacity: 0.8;
}
.cgo-attachment-actions {
  flex: 0 0 auto;
  font-size: 0.95rem;
  white-space: nowrap;
}
.cgo-image-skip {
  margin-top: 6px;
  color: #ffb020;
  font-size: 0.9rem;
  font-weight: 500;
}
.cgo-code-block {
  margin: 16px 0;
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 12px;
  overflow: hidden;
  background: rgba(0,0,0,0.18);
}

.cgo-code-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  font-size: 12px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  background: rgba(255,255,255,0.04);
}

.cgo-code-lang {
  opacity: 0.85;
  font-weight: 600;
}

.cgo-code-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.cgo-code-copy-btn,
.cgo-code-toggle-btn {
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 8px;
  font: inherit;
}

.cgo-code-copy-btn:hover,
.cgo-code-toggle-btn:hover {
  background: rgba(255,255,255,0.08);
}

.cgo-code-pre {
  margin: 0;
  padding: 12px 14px;
  overflow: auto;
}

.cgo-code-pre code {
  white-space: pre;
  display: block;
}

.cgo-code-block.is-collapsed .cgo-code-pre {
  max-height: 280px;
  overflow: hidden;
  position: relative;
}

.cgo-code-block.is-collapsed .cgo-code-pre::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 56px;
  background: linear-gradient(to bottom, rgba(0,0,0,0), rgba(0,0,0,0.45));
  pointer-events: none;
}
.cgo-images {
  margin-top: 12px;
}

.cgo-images-internal {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
}

.cgo-images-external {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin-top: 12px;
}

@media (min-width: 900px) {
  .cgo-images-external {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

.cgo-image {
  margin: 0;
}

.cgo-images-external .cgo-image-external img {
  aspect-ratio: 1 / 1;
  object-fit: contain;
  background: rgba(255,255,255,0.04);
}

.cgo-image figcaption {
  margin-top: 6px;
  font-size: 0.9rem;
  line-height: 1.4;
}

.cgo-image-source {
  margin-top: 4px;
  font-size: 0.85rem;
}

.cgo-image-meta {
  margin-top: 6px;
  font-size: 0.8rem;
  line-height: 1.3;
  opacity: 0.72;
  word-break: break-all;
}

@media (prefers-color-scheme: dark) {
  body {
    background: #0b1020;
    color: #e5e7eb;
  }
  .page-header {
    border-bottom-color: #374151;
  }
  .page-meta,
  .message-date,
  .code-lang,
  .cgo-image figcaption,
  .cgo-image-hint-label {
    color: #9ca3af;
  }
  .message {
    background: #111827;
    border-color: #374151;
  }
  .message.user {
    background: #0f172a;
    border-color: #1d4ed8;
  }
  .message.assistant {
    background: #052e16;
    border-color: #15803d;
  }
  .cgo-image img {
    border-color: #374151;
  }
  .cgo-image-hint {
    border-color: #4b5563;
    background: rgba(255, 255, 255, 0.04);
  }
  .cgo-attachments {
    border-top-color: #4b5563;
  }
  .cgo-markdown blockquote {
    border-left-color: #4b5563;
    color: #9ca3af;
  }

  .cgo-markdown :not(pre) > code {
    background: rgba(255, 255, 255, 0.08);
  }

  .cgo-markdown a {
    color: #60a5fa;
  }

  .cgo-markdown hr {
    border-top-color: #374151;
  }
  .cgo-image-missing-box {
    border-color: #4b5563;
    background: rgba(255, 255, 255, 0.04);
    color: #9ca3af;
  }
}
    `
  }

  function getCodeEnhancementScript() {
    return `
<script>
(function () {
  document.addEventListener("click", async function (event) {
    const copyBtn = event.target.closest(".cgo-code-copy-btn");
    if (copyBtn) {
      const block = copyBtn.closest(".cgo-code-block");
      const codeEl = block?.querySelector("code");
      if (!codeEl) return;

      const text = codeEl.textContent || "";
      const oldText = copyBtn.textContent;

      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = "Copied";
      } catch (_) {
        copyBtn.textContent = "Failed";
      }

      setTimeout(() => {
        copyBtn.textContent = oldText;
      }, 1200);

      return;
    }

    const toggleBtn = event.target.closest(".cgo-code-toggle-btn");
    if (toggleBtn) {
      const block = toggleBtn.closest(".cgo-code-block");
      if (!block) return;

      const collapsed = block.classList.toggle("is-collapsed");
      toggleBtn.textContent = collapsed ? "${CGO.t('expand_code_button')}" : "${CGO.t('collapse_code_button')}";
    }
  });

  // ===== lazy highlight =====
  function initLazyHighlight() {
    if (!window.hljs) return;

    const blocks = document.querySelectorAll("pre code");

    // IntersectionObserver 非対応なら即実行
    if (!("IntersectionObserver" in window)) {
      blocks.forEach(el => {
        try { window.hljs.highlightElement(el); } catch(_) {}
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
    }, {
      rootMargin: "200px 0px", // 先読み
      threshold: 0.01,
    });

    blocks.forEach(el => observer.observe(el));
  }

  // ===== hljsロード待ち =====
  function waitForHljs() {
    if (window.hljs) {
      initLazyHighlight();
      return;
    }
    setTimeout(waitForHljs, 50);
  }

  waitForHljs();
})();
</script>`;
  }

})();
