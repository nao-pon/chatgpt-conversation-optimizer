(() => {
  /**
   * Retrieve a localized message for the given key using chrome.i18n when available.
   *
   * Suppresses any errors and returns an empty string if the translation is missing or retrieval fails.
   * @param {string} key - The i18n message key.
   * @param {Array|Object} [substitutions] - Optional substitutions passed to chrome.i18n.getMessage (array or mapping).
   * @returns {string} The localized message if found and truthy, otherwise an empty string.
   */
  function i18nGetMessage(key, substitutions) {
    try {
      if (globalThis.chrome?.i18n?.getMessage) {
        const value = chrome.i18n.getMessage(key, substitutions);
        if (value) return value;
      }
    } catch (_) {}
    return "";
  }

  /**
   * Resolve a localized message for a given key with optional substitutions and sensible fallbacks.
   *
   * @param {string} key - The message key to resolve.
   * @param {string|Array<string|number>|undefined} [substitutions] - Optional substitution(s) for the message; when an array is provided, the first element is used for fallback formatting.
   * @returns {string} The localized message if available; if the key is `"thought_item_fallback"`, returns `Thought <n>` where `n` is taken from `substitutions`; otherwise returns the original `key`.
   */
  function t(key, substitutions) {
    const value = i18nGetMessage(key, substitutions);
    if (value) return value;
    if (key === "thought_item_fallback") {
      const n = Array.isArray(substitutions) ? substitutions[0] : substitutions;
      return `Thought ${n ?? ""}`.trim();
    }
    return key;
  }

  /**
   * Escape special HTML characters in a value so it can be safely inserted into HTML.
   *
   * Converts the input to a string and replaces &, <, >, " and ' with their corresponding HTML entities.
   * @param {*} text - Value to escape; non-string values will be converted to a string.
   * @returns {string} The escaped string with `&`, `<`, `>`, `"` and `'` replaced by HTML entities.
   */
  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * Decode HTML entities in a value and return the resulting plain text.
   *
   * @param {*} html - The value containing HTML-escaped text; falsy values are treated as an empty string.
   * @returns {string} The decoded string with HTML entities converted to their corresponding characters.
   */
  function unescapeHtml(html) {
    const el = document.createElement("textarea");
    el.innerHTML = String(html || "");
    return el.value;
  }

  /**
   * Remove proprietary ChatGPT UI artifact markers, collapse excessive blank lines, and trim the result.
   * 
   * @param {*} text - Input value to be normalized; will be converted to a string.
   * @returns {string} The cleaned string with artifact sequences removed, runs of three or more newlines collapsed to two, and surrounding whitespace trimmed.
   */
  function stripChatgptUiArtifacts(text) {
    return String(text || "")
      .replace(/\uE200(?:filecite|cite)\uE202[\s\S]*?\uE201/g, "")
      .replace(/\uE200(?:filenavlist|navlist|schedule|forecast|standing|finance)\uE202[\s\S]*?\uE201/g, "")
      .replace(/[\uE200\uE201\uE202]/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /**
   * Extracts a plain string from a marked token, string, or other value.
   *
   * If `value` is a string it is returned unchanged. If `value` is an object, the first present string among
   * its `text`, `raw`, or `lang` properties is returned. For any other input, returns `String(value ?? "")`.
   *
   * @param {*} value - A string, a token-like object (with `text`, `raw`, or `lang`), or any other value.
   * @returns {string} The extracted or converted string.
   */
  function getMarkedTextValue(value) {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      if (typeof value.text === "string") return value.text;
      if (typeof value.raw === "string") return value.raw;
      if (typeof value.lang === "string") return value.lang;
    }
    return String(value ?? "");
  }

  /**
   * Generate a consistent DOM id for a message element.
   *
   * Takes a raw message ID and returns the exact string used for the element's id attribute,
   * ensuring lookups and template generation use the same normalization.
   *
   * @param {string} messageId - The raw message identifier.
   * @returns {string} The normalized id string prefixed with "mes-".
   */
  function makeMessageDomId(messageId) {
    return `mes-${escapeHtml(messageId || "")}`;
  }

  /**
   * Create a customized marked renderer that produces application-styled HTML for code blocks and inline code.
   *
   * The returned renderer renders fenced/code blocks as a code panel that includes a language label and a copy button,
   * and renders inline code spans with escaped content suitable for safe insertion into the document.
   *
   * @returns {marked.Renderer} A configured marked renderer with custom `code` and `codespan` handlers.
   */
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

  /**
   * Select the safest and most appropriate text source from a message object.
   *
   * ChatGPT export data may contain multiple text representations:
   * - `message.text`       : raw/original text (may include HTML-like content)
   * - `message.renderText` : processed/render-ready text (may already be formatted)
   *
   * This function prioritizes **safety and predictability**:
   * 1. Prefer `text` when available
   *    竊・preserves original content and avoids unintended HTML execution
   * 2. Fallback to `renderText` when `text` is empty
   *
   * Rationale:
   * - `renderText` may contain partially rendered HTML or structures that
   *   can break when passed through `innerHTML` again.
   * - Using `text` helps avoid issues like:
   *     - accidental `<script>` execution
   *     - DOM structure corruption
   *     - double-rendering artifacts
   *
   * This function is intentionally simple. Any advanced heuristics
   * (e.g. detecting HTML-heavy content or switching modes) should be added
   * carefully to avoid inconsistent rendering.
   *
   * @param {Object} message - Message object from payload.messages
   * @param {string} [message.text] - Raw/original message text
   * @param {string} [message.renderText] - Alternative/rendered text
   *
   * @returns {string} Selected source text (never null/undefined, may be empty string)
   *
   * @example
   * const source = pickMessageSourceText(message);
   * const html = renderMessageTextToHtml(source);
   *
   * @note
   * This function does NOT perform sanitization or escaping.
   * Always pass the result through `renderMessageTextToHtml()`.
   */
  function pickMessageSourceText(message) {
    const rawText = typeof message?.text === "string" ? message.text : "";
    const renderText = typeof message?.renderText === "string" ? message.renderText : "";

    if (rawText) return rawText;
    if (renderText) return renderText;
    return "";
  }


  /**
   * Convert message text (plain or Markdown) into sanitized HTML suitable for embedding in the page.
   *
   * This strips known ChatGPT UI artifact sequences, escapes HTML, renders Markdown when `marked` is available
   * (falling back to simple paragraph/line-break conversion), sanitizes the generated HTML with `DOMPurify`
   * when present, and ensures all links open in a new tab with `rel="noopener noreferrer"`.
   * @param {string} text - The message content to render; non-string values are treated as empty.
   * @returns {string} An HTML string wrapped in a `<div class="cgo-markdown">` containing the rendered and sanitized content.
   */
  function renderMessageTextToHtml(text) {
    const source = typeof text === "string" ? text : "";
    if (!source.trim()) return "";

    const rawSrc = stripChatgptUiArtifacts(source);

    if (typeof marked === "undefined" || typeof DOMPurify === "undefined") {
      const escapedSrc = escapeHtml(rawSrc);
      return `<div class="cgo-markdown"><p>${escapedSrc.replace(/\n/g, "<br>")}</p></div>`;
    }

    const preEscapedSrc = rawSrc.replace(/<([^<>]+)>/g, "&lt;$1&gt;");

    const rawHtml = marked.parse(preEscapedSrc, {
      breaks: true,
      gfm: true,
      renderer: createMarkedRenderer(),
    });

    const safeHtml = DOMPurify.sanitize(rawHtml, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "svg", "path"],
      FORBID_ATTR: ["style", "onerror", "onclick", "onload"],
    });

    const wrapper = document.createElement("div");
    wrapper.innerHTML = safeHtml;

    for (const a of wrapper.querySelectorAll("a")) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    }

    return `<div class="cgo-markdown">${wrapper.innerHTML}</div>`;
  }

  /**
   * Get the inline SVG markup used for the thought icon.
   * @returns {string} SVG markup string for the thought icon.
   */
  function getThoughtIconSvg() {
    return `
<svg viewBox="0 0 24 24" aria-hidden="true" class="cgo-thought-icon">
  <path fill="currentColor" d="M12 4c-4.42 0-8 2.91-8 6.5 0 1.94 1.05 3.68 2.74 4.87-.12.92-.52 1.89-1.34 2.77 1.64-.15 3.08-.74 4.23-1.72.73.18 1.52.28 2.37.28 4.42 0 8-2.91 8-6.5S16.42 4 12 4zm-3 6.5a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm3 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm3 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z"/>
</svg>`;
  }

  /**
   * Provide the inline SVG markup used for the markdown copy button icon.
   *
   * The returned SVG string contains the markup for a 24×24 markdown-copy icon and includes
   * the `cgo-markdown-copy-icon` CSS class and `aria-hidden="true"`.
   * @returns {string} The SVG markup string for the markdown-copy icon.
   */
  function getMarkdownCopyIconSvg() {
    return `
<svg viewBox="0 0 24 24" aria-hidden="true" class="cgo-markdown-copy-icon">
  <path d="M8.5 3.75h6.6l3.15 3.15v9.85a2.25 2.25 0 0 1-2.25 2.25H8.5a2.25 2.25 0 0 1-2.25-2.25V6A2.25 2.25 0 0 1 8.5 3.75Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
  <path d="M15 3.9v3.1h3.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M9.35 10.2h5.3M9.35 13h5.3M9.35 15.8h3.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  <path d="M4.6 7.75v9.9a2.25 2.25 0 0 0 2.25 2.25h7.9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.72"/>
</svg>`;
  }

  /**
   * Provide the inline SVG markup used for the voice-transcription badge icon.
   * @returns {string} SVG markup string for the voice badge.
   */
  function getVoiceTranscriptionIconSvg() {
    return `
<svg viewBox="0 0 24 24" aria-hidden="true" class="cgo-voice-badge-icon">
  <path d="M12 4.75a2.75 2.75 0 0 0-2.75 2.75v4.9a2.75 2.75 0 0 0 5.5 0V7.5A2.75 2.75 0 0 0 12 4.75Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M7.75 11.9a4.25 4.25 0 0 0 8.5 0M12 16.15v3.1M9.35 19.25h5.3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
  }

  /**
   * Render a small badge for voice-transcription messages.
   *
   * @param {Object} message - Normalized export message.
   * @returns {string} HTML string for the badge or an empty string.
   */
  function renderVoiceTranscriptionBadge(message) {
    if (!message?.isVoiceTranscription) return "";

    const label = escapeHtml(t("voice_transcription_label"));
    return `<span class="cgo-voice-badge" role="img" aria-label="${label}" title="${label}">${getVoiceTranscriptionIconSvg()}</span>`;
  }

  /**
   * Format a Unix timestamp (seconds) into a locale-aware date and time string.
   * @param {number|any} value - Seconds since the Unix epoch; if falsy the function returns an empty string.
   * @returns {string} The local date/time string for the given timestamp, or `""` if `value` is falsy or cannot be parsed.
   */
  function formatExportDate(value) {
    if (!value) return "";
    try {
      return new Date(value * 1000).toLocaleString();
    } catch {
      return "";
    }
  }

  /**
   * Render a list of "thought" items as a toolbar of toggles and corresponding hidden panels in HTML.
   * @param {Array<object>} thoughts - Array of thought objects; each may include `summary`, `content`, and `finished`.
   * @param {string|number} [messageId] - Identifier used to derive stable DOM IDs for each thought panel.
   * @returns {string} An HTML string containing the thoughts toolbar and panels, or an empty string if `thoughts` is empty or not an array.
   */
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

  /**
   * Render an image's metadata as an escaped HTML fragment.
   *
   * @param {Object} image - Image metadata object.
   * @param {number} [image.width] - Image width in pixels.
   * @param {number} [image.height] - Image height in pixels.
   * @param {number|string} [image.fileSizeBytes] - File size in bytes.
   * @param {string} [image.mimeType] - MIME type string.
   * @returns {string} An HTML string containing joined, escaped metadata (dimensions, human-readable file size, MIME type) separated by " · ", or an empty string when no metadata is available.
   */
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

  /**
   * Render an array of image descriptors into HTML blocks grouping internal and external images.
   *
   * @param {Array<Object>} images - List of image objects. Each object may contain:
   *   - {string} [embeddedUrl] - Preferred source URL for embedded images.
   *   - {string} [url] - Fallback source URL.
   *   - {string} [alt] - Alternate text used for the image and as a caption fallback.
   *   - {string} [title] - Caption fallback when `alt` is not provided.
   *   - {number} [width], {number} [height], {number} [fileSizeBytes], {string} [mimeType] - Optional metadata used by renderImageMeta.
   * @returns {string} An HTML string with two optional containers:
   *   - A `.cgo-images-internal` block for non-http(s) sources.
   *   - A `.cgo-images-external` block for http(s) sources (images get `loading="lazy"` and `referrerpolicy="no-referrer"`).
   *   Returns an empty string when `images` is not a non-empty array.
   */
  function renderImages(images) {
    if (!Array.isArray(images) || images.length === 0) return "";

    const internalItems = [];
    const externalItems = [];

    for (const image of images) {
      const rawSrc = image?.embeddedUrl || image?.url || "";
      const alt = escapeHtml(image?.alt || "");
      const caption = escapeHtml(image?.alt || image?.title || "");

      // Validate URL scheme
      let src = "";
      let isExternal = false;
      if (rawSrc) {
        try {
          if (/^https?:\/\//i.test(rawSrc)) {
            src = rawSrc;
            isExternal = true;
          } else if (/^data:image\//i.test(rawSrc)) {
            src = rawSrc;
            isExternal = false;
          }
          // Otherwise treat as missing (disallow other schemes)
        } catch {
          // Invalid URL; treat as missing
        }
      }

      const figureHtml = src
        ? `<figure class="cgo-image${isExternal ? " cgo-image-external" : ""}">
            <img src="${escapeHtml(src)}" alt="${alt}"${isExternal ? ' loading="lazy" referrerpolicy="no-referrer"' : ""}>
            ${caption ? `<figcaption>${caption}</figcaption>` : ""}
            ${renderImageMeta(image)}
          </figure>`
        : `<figure class="cgo-image cgo-image-missing">
            <div class="cgo-image-missing-box">${escapeHtml(t("image_not_include_label"))}</div>
            ${caption ? `<figcaption>${caption}</figcaption>` : ""}
          </figure>`;

      if (isExternal) {
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

  /**
   * Render an HTML fragment representing a list of attachments.
   *
   * @param {Array<Object>} attachments - Array of attachment objects. Each object may include `name`, `localPath`, and `url`.
   * @returns {string} An HTML string containing rendered attachment rows, or an empty string if `attachments` is not a non-empty array.
   */
  function renderAttachments(attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) return "";

    return `<div class="cgo-attachments">${attachments.map((attachment) => {
      const name = escapeHtml(attachment?.name || "attachment");
      const rawHref = attachment?.localPath || attachment?.url || "";
      const meta = escapeHtml(t("attachment_not_embedded_label"));

      // Validate URL scheme (only allow http: and https:)
      let href = "";
      if (rawHref) {
        try {
          if (/^https?:\/\//i.test(rawHref)) {
            href = rawHref;
          }
          // Otherwise omit the link (disallow other schemes)
        } catch {
          // Invalid URL; omit link
        }
      }

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

  /**
   * Render a single conversation message into a complete HTML section.
   *
   * This function builds the structural HTML for one message, including:
   * - Header (role label, timestamp, markdown copy button)
   * - Body (rendered markdown content, thoughts, images, attachments)
   *
   * The actual markdown source text is NOT embedded directly here to avoid
   * HTML parsing issues (e.g. accidental <script> execution). Instead, the raw
   * markdown is injected later in `main()` as a hidden
   * `<script type="application/json" class="cgo-message-markdown">`.
   *
   * Rendering flow:
   * 1. Extract source text via `pickMessageSourceText()`
   * 2. Convert to safe HTML via `renderMessageTextToHtml()`
   * 3. Append optional sections:
   *    - thoughts (renderThoughts)
   *    - images (renderImages)
   *    - attachments (renderAttachments)
   *
   * Security considerations:
   * - All dynamic values are escaped via `escapeHtml()`
   * - Markdown HTML output is sanitized via DOMPurify
   * - No raw user HTML is directly injected into the DOM
   *
   * @param {Object} message - Message object from payload.messages
   * @param {string} [message.id] - Unique message ID (used for DOM id)
   * @param {string} [message.role] - "user" or "assistant"
   * @param {number} [message.createTime] - Unix timestamp (seconds)
   * @param {string} [message.text] - Raw text content (preferred for safety)
   * @param {string} [message.renderText] - Pre-rendered/alternative text
   * @param {Array} [message.thoughts] - Thought items to render
   * @param {Array} [message.visibleImages] - Pre-filtered images
   * @param {Array} [message.images] - Fallback images
   * @param {Array} [message.visibleAttachments] - Pre-filtered attachments
   * @param {Array} [message.attachments] - Fallback attachments
   *
   * @returns {string} HTML string representing the message section
   *
   * @example
   * const html = buildMessageHtml(message);
   * app.innerHTML += html;
   *
   * @note
   * Do NOT embed raw markdown or JSON directly in this HTML string.
   * Always inject it later using DOM APIs (see main()) to avoid parser issues.
   */
  function buildMessageHtml(message) {
    const roleLabel = message.role === "user" ? t("role_user") : t("role_assistant");
    const dateText = formatExportDate(message.createTime);
    const sourceText = pickMessageSourceText(message);

    return `
<section class="message ${escapeHtml(message.role || "")}" id="mes-${escapeHtml(message.id || "")}">
  <div class="message-header">
    <div class="message-header-main">
      <span class="message-role">${escapeHtml(roleLabel)}</span>
      ${renderVoiceTranscriptionBadge(message)}
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

  /**
   * Loads the viewer payload stored under `cgo_viewer_<token>` where `token` is taken from the page's query string.
   * @returns {{payload: any, key: string}} An object containing the payload and storage key.
   * @throws {Error} If the `token` query parameter is missing ("viewer token not found").
   * @throws {Error} If no payload is found for the token ("viewer payload not found").
   */
  async function loadPayload() {
    const params = new URLSearchParams(location.search);
    const token = params.get("token");
    if (!token) throw new Error("viewer token not found");

    const key = `cgo_viewer_${token}`;
    const stored = await chrome.storage.local.get(key);
    const payload = stored?.[key];

    if (!payload) throw new Error("viewer payload not found");
    return { payload, key };
  }

  /**
   * Initialize the optional CGO export UI (if present) with feature flags and a label resolver.
   *
   * When a global `window.CGOExportUI` exists, calls its `init` method to enable code actions,
   * disable built-in highlighting, and provide a `getLabel` callback that resolves localization
   * keys via `t(key)` with fallbacks.
   */
  function installHandlers(payload) {
    window.CGOExportUI?.init({
      enableCodeActions: true,
      enableHighlight: false,
      getLabel: (key, fallback) => t(key) || fallback || key,
    });
  }

  /**
   * Initialize and render the CGO Viewer page from a stored export payload.
   *
   * Loads the export payload, sets document language/title/meta, renders message HTML into #app,
   * installs UI handlers, and scrolls to a specific message if requested; deletes the stored payload
   * only after successful rendering. On failure it renders an error UI and logs the error.
   */
  async function main() {
    let storageKey = null;
    try {
      const { payload, key } = await loadPayload();
      storageKey = key;

      document.documentElement.lang = chrome?.i18n?.getUILanguage?.() || document.documentElement.lang || "en";
      document.title = payload.title || t("untitled_conversation") || "CGO Viewer";
      document.getElementById("page-title").textContent = payload.title || t("untitled_conversation");
      document.getElementById("page-meta").innerHTML = `
        <span>${escapeHtml(t("conversation_id"))}: ${escapeHtml(payload.conversationId || "")}</span>
        <span>${escapeHtml(t("exported_at"))}: ${escapeHtml(new Date(payload.exportedAt || Date.now()).toLocaleString())}</span>`;

      const app = document.getElementById("app");
      const messages = payload.messages || [];

      app.innerHTML = messages.map(buildMessageHtml).join("\n");

      for (const message of messages) {
        const messageId = String(message?.id || "");
        if (!messageId) continue;

        const section = app.querySelector(`#mes-${CSS.escape(messageId)}`);
        if (!section) continue;

        const sourceText = pickMessageSourceText(message);

        const holder = document.createElement("script");
        holder.type = "application/json";
        holder.className = "cgo-message-markdown";
        holder.textContent = JSON.stringify(sourceText || "");

        section.insertBefore(holder, section.firstChild);
      }

      installHandlers(payload);

      if (payload.messageId) {
        document.getElementById(makeMessageDomId(payload.messageId))?.scrollIntoView({ block: "start" });
      }

      // Only remove storage after successful render
      if (storageKey) {
        await chrome.storage.local.remove(storageKey);
      }
    } catch (error) {
      document.title = "CGO Viewer Error";
      document.getElementById("page-title").textContent = "CGO Viewer Error";
      document.getElementById("app").innerHTML = `<pre>${escapeHtml(String(error?.message || error))}</pre>`;
      console.error(error);
      // Do not remove storage on error, allowing retry
    }
  }

  main();
})();
