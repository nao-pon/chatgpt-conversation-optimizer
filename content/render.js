(() => {
  if (globalThis.__CGO_SKIP__) return;
  const CGO = (globalThis.__CGO ||= {});

  CGO.mergeMessagesWithDomAssets = function mergeMessagesWithDomAssets(messages, domAssets) {
    const merged = messages.map((message) => ({
      ...message,
      images: [],
      attachments: [],
      imagePrompts: [],
    }));

    const { byMessageId, anonymous } = CGO.buildAssistantDomImagePools(domAssets);
    const domImageUrlIndex = CGO.buildDomImageUrlIndex(domAssets);
    let anonymousIndex = anonymous.length - 1;

    for (let i = merged.length - 1; i >= 0; i--) {
      const message = merged[i];
      const isImageMessage = CGO.isImageCandidateMessage(message);

      let collectedImages = [];
      let collectedPrompts = [];
      let matchedDomAsset = null;

      // 1) user 添付画像
      if (
        message.role === "user" &&
        CGO.isNonEmptyArray(message.rawMessage?.content?.parts)
      ) {
        const userImages = CGO.extractUserImagesFromMessage(message.rawMessage);

        for (const image of userImages) {
          if (image.fileId) {
            const domUrl = domImageUrlIndex.get(image.fileId);
            if (domUrl) {
              image.url = domUrl;
              image.source = "user-asset-pointer+dom-url";
            } else {
              image.unresolved = true;
            }
          }
        }

        if (userImages.length) {
          collectedImages.push(...userImages);
        }
      }

      // 2) tool child 由来画像
      if (isImageMessage && CGO.isNonEmptyArray(message.toolMessages)) {
        const toolImages = message.toolMessages.flatMap(CGO.extractImageAssetsFromToolMessage);

        for (const image of toolImages) {
          if (
            image?.fileId &&
            image.url &&
            !/[?&]sig=/.test(image.url)
          ) {
            const domUrl = domImageUrlIndex.get(image.fileId);
            if (domUrl) {
              image.url = domUrl;
              image.source = "tool-asset-pointer+dom-url";
            } else {
              image.unresolved = true;
            }
          }
        }

        if (toolImages.length) {
          collectedImages.push(...toolImages);
        }
      }

      // 3) content_references.image_group
      if (isImageMessage && collectedImages.length === 0) {
        const contentRefImages = CGO.extractImageAssetsFromContentReferences(message.rawMessage || {});
        if (contentRefImages.length) {
          collectedImages.push(...contentRefImages);
        }
      }

      // 4) rawMessage からの汎用復元
      if (isImageMessage && collectedImages.length === 0) {
        const dataImages = CGO.extractImageAssetsFromMessageData(message.rawMessage || null);
        if (dataImages.length) {
          collectedImages.push(...dataImages);
        }
      }

      // 5) prompt / hint は画像があっても併記
      if (isImageMessage) {
        const promptHints = CGO.extractPromptHintsFromMessage(message);
        if (promptHints.length) {
          collectedPrompts.push(...promptHints);
        }

        // content_references 由来画像の hint も prompt に反映
        for (const image of collectedImages) {
          if (image?.hint && !collectedPrompts.some((p) => p.text === image.hint)) {
            collectedPrompts.push({
              text: image.hint,
              source: "content-reference-image-group",
            });
          }
        }
      }

      // 6) DOM fallback
      if (isImageMessage && message.role === "assistant" && collectedImages.length === 0) {
        const candidateIds = [
          ...CGO.getToolMessageIds(message),
          message.id,
        ];

        for (const candidateId of candidateIds) {
          const asset = byMessageId.get(candidateId);
          if (asset) {
            matchedDomAsset = asset;
            byMessageId.delete(candidateId);
            break;
          }
        }

        if (!matchedDomAsset && anonymousIndex >= 0) {
          matchedDomAsset = anonymous[anonymousIndex];
          anonymousIndex -= 1;
        }

        if (matchedDomAsset) {
          collectedImages.push(...(matchedDomAsset.images || []));
          if (CGO.isNonEmptyArray(matchedDomAsset.attachments)) {
            message.attachments = [...matchedDomAsset.attachments];
          }
        }
      }

      const dataImages = Array.isArray(message.dataImages) ? message.dataImages : [];
      message.images = CGO.mergeImageListsPreferData(
        dataImages,
        CGO.dedupeImages(collectedImages)
      ).filter((image) => {
        const mimeType = String(image?.mimeType || "").toLowerCase();
        const fileName = String(image?.fileName || image?.title || image?.alt || "").toLowerCase();
        const url = String(image?.url || "");

        return (
          /^image\//i.test(mimeType) ||
          /\.(png|jpg|jpeg|webp|gif|bmp|svg)$/i.test(fileName) ||
          /[?&]mime_type=image%2F/i.test(url) ||
          /\/backend-api\/files\/[A-Za-z0-9_-]+\/download(\?|$)/i.test(url) ||
          /\/backend-api\/estuary\/content\?/i.test(url)
        );
      });
      message.imagePrompts = collectedPrompts;

      const dataAttachments = CGO.extractAttachmentsFromMessageData(message.rawMessage || {});
      const metadataAttachments = CGO.extractAttachmentsFromMetadataAttachments(message.rawMessage || {});
      const sandboxAttachments = CGO.extractSandboxArtifacts(message || "");
      const mergedAttachments = CGO.dedupeAttachments([
        ...(message.attachments || []),
        ...dataAttachments,
        ...metadataAttachments,
        ...sandboxAttachments,
      ]);

      message.attachments = mergedAttachments;
      promoteImageAttachmentsToImages(message);

      const promotedAttachmentImages = (message.attachments || [])
        .filter((attachment) => attachment?.kind === "image")
        .map((attachment) => CGO.normalizeImageMeta({
          fileId: attachment.fileId || "",
          url: attachment.url || "",
          fileName: attachment.name || "",
          mimeType: attachment.mimeType || "",
          fileSizeBytes: Number(attachment.fileSizeBytes || 0),
          alt: attachment.name || "",
          title: attachment.name || "",
          source: `${attachment.source || "attachment"}+attachment-image`,
          unresolved: attachment.unresolved !== false,
        }));

      message.images = CGO.dedupeImages([
        ...(message.images || []),
        ...promotedAttachmentImages,
      ]);

      CGO.prepareInlineImageData(message);

      CGO.log("[export] merge message", {
        id: message.id,
        role: message.role,
        isImageMessage,
        toolMessageIds: CGO.getToolMessageIds(message),
        matchedDomMessageId: matchedDomAsset?.messageId || null,
        imageCount: message.images.length,
        attachmentCount: message.attachments.length,
        imageSources: message.images.map((img) => img.source),
        promptCount: message.imagePrompts.length,
        anonymousIndexAfter: anonymousIndex,
      });
    }

    return merged;
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

  CGO.renderThoughts = function renderThoughts(thoughts, messageId = "") {
    if (!Array.isArray(thoughts) || thoughts.length === 0) return "";

    const safeMessageId = String(messageId || "thoughts")
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "thoughts";

    const buttonsHtml = [];
    const panelsHtml = [];

    thoughts.forEach((item, index) => {
      const summaryText = item?.summary || CGO.t("thought_item_fallback", String(index + 1));
      const summary = CGO.escapeHtml(summaryText);
      const contentHtml = item?.content
        ? CGO.renderMessageTextToHtml(item.content, { interactiveCode: false })
        : "";
      /*        const chunks = Array.isArray(item?.chunks) ? item.chunks : [];
              const chunksHtml = chunks.length
                ? `<ul class="cgo-thought-chunks">${chunks
                  .map((chunk) => `<li>${CGO.escapeHtml(chunk)}</li>`)
                  .join("")}</ul>`
                : "";*/
      const finishedHtml = item?.finished
        ? `<span class="cgo-thought-finished">${CGO.escapeHtml(CGO.t("thought_finished_label"))}</span>`
        : "";

      const panelId = `cgo-thought-${safeMessageId}-${index + 1}`;

      buttonsHtml.push(`
      <button
        type="button"
        class="cgo-thought-toggle"
        data-target="${panelId}"
        title="${summary}"
        aria-label="${summary}"
        aria-expanded="false"
      >${CGO.getThoughtIconSvg()}</button>
    `);

      panelsHtml.push(`
      <div
        class="cgo-thought-panel"
        data-thought-panel-id="${panelId}"
        hidden
      >
        <div class="cgo-thought-panel-header">
          <span class="cgo-thought-summary">${summary}</span>
          ${finishedHtml}
        </div>
        <div class="cgo-thought-body">
          ${contentHtml}
        </div>
      </div>
    `);
    });

    return `<div class="cgo-thoughts cgo-markdown" aria-label="${CGO.escapeHtml(CGO.t("thoughts_toggle_label"))}">
    <hr>
    <div class="cgo-thoughts-toolbar">${buttonsHtml.join("\n")}</div>
    <div class="cgo-thoughts-panels">${panelsHtml.join("\n")}</div>
  </div>`;
  }

  CGO.renderImageMeta = function renderImageMeta(image) {
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
  }

  CGO.renderSingleImageFigure = function renderSingleImageFigure(image, options = {}) {
    const mode = options.mode || "html"; // "html" | "zip"
    const noImg = !!options.noImg;
    const alt = CGO.escapeHtml(image.alt || "");
    const caption = CGO.escapeHtml(image.alt || image.title || "");
    const sourceLink = CGO.renderImageSourceLink(image);
    const skipLabel = CGO.getImageSkipLabel(image);
    const isExternal = CGO.isProbablyExternalImage(image);

    // ZIP内ローカル画像
    if (mode === "zip" && image.localPath) {
      return `<figure class="cgo-image${isExternal ? " cgo-image-external" : ""}">
        <img src="${CGO.escapeHtml(image.localPath)}" alt="${alt}">
        ${caption ? `<figcaption>${caption}</figcaption>` : ""}
        ${CGO.renderImageMeta(image)}
        ${sourceLink}
      </figure>`;
    }

    // HTML埋め込み済み画像
    if (mode === "html" && image.embeddedUrl && !noImg) {
      return `<figure class="cgo-image${isExternal ? " cgo-image-external" : ""}">
        <img src="${image.embeddedUrl}" alt="${alt}">
        ${caption ? `<figcaption>${caption}</figcaption>` : ""}
        ${CGO.renderImageMeta(image)}
        ${sourceLink}
      </figure>`;
    }

    // 外部画像は参照用としてそのまま表示
    if (image.url && !image.unresolved && isExternal) {
      return `<figure class="cgo-image cgo-image-external">
        <img src="${CGO.escapeHtml(image.url)}" loading="lazy" referrerpolicy="no-referrer">
        ${CGO.renderImageMeta(image)}
        ${sourceLink}
      </figure>`;
    }

    // HTML側で未埋め込みだが内部URLが生きている場合
    if (mode === "html" && image.url && !image.unresolved && !isExternal && !noImg) {
      return `<figure class="cgo-image">
        <img src="${CGO.escapeHtml(image.url)}" alt="${alt}">
        ${caption ? `<figcaption>${caption}</figcaption>` : ""}
        ${CGO.renderImageMeta(image)}
        ${sourceLink}
      </figure>`;
    }

    // fallback
    return `<figure class="cgo-image cgo-image-missing${isExternal ? " cgo-image-external" : ""}">
      <div class="cgo-image-missing-box">${CGO.escapeHtml(CGO.t(noImg ? "image_not_include_label" : "image_unavailable_label"))}</div>
      <figcaption>
        ${caption || CGO.escapeHtml(CGO.t("generated_image_present_label"))}
        ${skipLabel ? `<div class="cgo-image-skip">${CGO.escapeHtml(skipLabel)}</div>` : ""}
      </figcaption>
      ${sourceLink}
    </figure>`;
  }

  function renderImagesBase(images, noImg = false) {
    if (!Array.isArray(images) || images.length === 0) return "";

    const internalItems = [];
    const externalItems = [];

    for (const image of images) {
      const html = CGO.renderSingleImageFigure(image, { mode: "html", noImg });

      if (CGO.isProbablyExternalImage(image)) {
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

  CGO.renderImages = function renderImages(images) {
    return renderImagesBase(images);
  }

  function renderImagesNoImg(images) {
    const noImg = true;
    return renderImagesBase(images, noImg);
  }

  CGO.escapeRegExp = function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function promoteImageAttachmentsToImages(message) {
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    if (!attachments.length) return;

    const promoted = attachments
      .filter((attachment) => attachment?.kind === "image")
      .map((attachment) => CGO.normalizeImageMeta({
        fileId: attachment.fileId || "",
        url: attachment.url || "",
        fileName: attachment.name || "",
        mimeType: attachment.mimeType || "",
        fileSizeBytes: Number(attachment.fileSizeBytes || 0),
        alt: attachment.name || "",
        title: attachment.name || "",
        source: `${attachment.source || "attachment"}+attachment-image`,
        unresolved: attachment.unresolved !== false,
        skipReason: attachment.skipReason || "",
        localPath: attachment.localPath || "",
      }));

    if (!promoted.length) return;

    message.images = CGO.dedupeImages([
      ...(Array.isArray(message.images) ? message.images : []),
      ...promoted,
    ]);
  }

  function renderPreparedInlineImagesInHtml(
    bodyHtml,
    message,
    options = {}
  ) {
    let html = typeof bodyHtml === "string" ? bodyHtml : "";
    const noImg = !!options.noImg;
    const zipMode = !!options.zipMode;
    const inlineImages = Array.isArray(message?.inlineImages) ? message.inlineImages : [];

    if (!html || !inlineImages.length) {
      return html;
    }

    for (const entry of inlineImages) {
      if (!entry?.token || !entry?.image) continue;

      const figureHtml = CGO.renderSingleImageFigure(entry.image, {
        mode: zipMode ? "zip" : "html",
        noImg,
      });

      html = html.split(entry.token).join(figureHtml);
    }

    return html;
  }

  CGO.loadExtensionTextFile = async function loadExtensionTextFile(path) {
    const url = chrome.runtime.getURL(path);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load ${path}`);
    return res.text();
  }

  async function getHighlightAssets() {
    const [js, css] = await Promise.all([
      CGO.loadExtensionTextFile("vendor/highlight.min.js"),
      CGO.loadExtensionTextFile("vendor/github-dark.min.css"),
    ]);
    return { js, css };
  }


  CGO.getSharedExportAssets = async function getSharedExportAssets() {
    const [css, uiJs] = await Promise.all([
      CGO.loadExtensionTextFile("shared-export.css"),
      CGO.loadExtensionTextFile("shared-export-ui.js"),
    ]);
    return { css, uiJs };
  }

  CGO.escapeHtml = function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  CGO.stripChatgptUiArtifacts = function stripChatgptUiArtifacts(text) {
    if (!text) return "";

    return String(text)
      // ChatGPT rich UI markers
      .replace(/\uE200(?:filecite|cite)\uE202[\s\S]*?\uE201/g, "")
      .replace(/\uE200(?:filenavlist|navlist|schedule|forecast|standing|finance)\uE202[\s\S]*?\uE201/g, "")
      .replace(/[\uE200\uE201\uE202]/g, "")
      // まれに残る不要な空行を整理
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  CGO.postProcessRenderedMarkdown = function postProcessRenderedMarkdown(containerHtml) {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = containerHtml;

    for (const a of wrapper.querySelectorAll("a")) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    }

    return wrapper.innerHTML;
  }

  CGO.getMarkedTextValue = function getMarkedTextValue(value) {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      if (typeof value.text === "string") return value.text;
      if (typeof value.raw === "string") return value.raw;
      if (typeof value.lang === "string") return value.lang;
    }
    return String(value ?? "");
  }

  CGO.createMarkedRenderer = function createMarkedRenderer(options = {}) {
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
        codeText = CGO.getMarkedTextValue(codeOrToken);
        langText = CGO.getMarkedTextValue(maybeLang).trim();
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
      const codeText = CGO.getMarkedTextValue(codeOrToken);
      const unescaped = CGO.unescapeHtml(codeText);
      const safe = CGO.escapeHtml(unescaped);
      return `<code>${safe}</code>`;
    };
    
    return renderer;
  }

  function rewriteSandboxLinksForZip(text, attachments) {
    const source = typeof text === "string" ? text : "";
    if (!source) return source;
    if (!Array.isArray(attachments) || attachments.length === 0) return source;

    let out = source;

    for (const attachment of attachments) {
      if (!attachment?.isSandboxArtifact) continue;
      if (!attachment?.sandboxPath) continue;
      if (!attachment?.localPath) continue;

      const escapedSandboxPath = attachment.sandboxPath.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

      out = out.replace(
        new RegExp(escapedSandboxPath, "g"),
        attachment.localPath
      );
    }

    return out;
  }

  CGO.renderMessageTextToHtml = function renderMessageTextToHtml(text, options = {}) {
    const source = typeof text === "string" ? text : "";
    if (!source.trim()) return "";
    
    const markdownSrc = CGO.stripChatgptUiArtifacts(source).replace(/<([^<>]+)>/g, "&lt;$1&gt;");
    
    if (typeof marked !== "undefined" && DOMPurify !== "undefined") {
      const renderer = CGO.createMarkedRenderer(options);
    
      const rawHtml = marked.parse(markdownSrc, {
        breaks: true,
        gfm: true,
        renderer,
      });
    
      const safeHtml = DOMPurify.sanitize(rawHtml, {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "svg", "path"],
        FORBID_ATTR: ["style", "onerror", "onclick", "onload"],
      });
    
      return `<div class="cgo-markdown">${CGO.postProcessRenderedMarkdown(safeHtml)}</div>`;
    } else {
      const safeText = CGO.escapeHtml(markdownSrc);
      return `<div class="cgo-markdown"><p>${safeText.replace(/\n/g, "<br>")}</p></div>`;
    }
  }

  CGO.formatExportDate = function formatExportDate(value) {
    if (!value) return "";
    try {
      return new Date(value * 1000).toLocaleString();
    } catch {
      return "";
    }
  }

  CGO.getThoughtIconSvg = function getThoughtIconSvg() {
    return `
    <svg viewBox="0 0 24 24" aria-hidden="true" class="cgo-thought-icon">
      <path fill="currentColor" d="M12 4c-4.42 0-8 2.91-8 6.5 0 1.94 1.05 3.68 2.74 4.87-.12.92-.52 1.89-1.34 2.77 1.64-.15 3.08-.74 4.23-1.72.73.18 1.52.28 2.37.28 4.42 0 8-2.91 8-6.5S16.42 4 12 4zm-3 6.5a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm3 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm3 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z"/>
    </svg>
  `;
  };

  CGO.getMarkdownCopyIconSvg = function getMarkdownCopyIconSvg() {
    return `
    <svg viewBox="0 0 24 24" aria-hidden="true" class="cgo-markdown-copy-icon">
      <path d="M8.5 3.75h6.6l3.15 3.15v9.85a2.25 2.25 0 0 1-2.25 2.25H8.5a2.25 2.25 0 0 1-2.25-2.25V6A2.25 2.25 0 0 1 8.5 3.75Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
      <path d="M15 3.9v3.1h3.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M9.35 10.2h5.3M9.35 13h5.3M9.35 15.8h3.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      <path d="M4.6 7.75v9.9a2.25 2.25 0 0 0 2.25 2.25h7.9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.72"/>
    </svg>`;
  };

  CGO.buildConversationExportHtml = function buildConversationExportHtml(
    title,
    conversationId,
    messages,
    options = {}
  ) {
    const {
      lightweight = false,
      zipMode = false,
      thoughtsRenderer = options.lightweight ? function () { return ""; } : CGO.renderThoughts,
      imageRenderer = options.lightweight ? renderImagesNoImg : CGO.renderImages,
      attachmentRenderer = CGO.renderAttachments,
      interactiveCode = false,
      interactiveUi = true,
      highlightAttach = false,
      highlightAssets = null,
      includeImages = true,
      projectName = "",
      conversationTitle = "",
      sharedCss = "",
      sharedUiJs = "",
    } = options;

    const messageHtml = messages.map((message) => {
      const roleLabel = message.role === "user" ? CGO.t("role_user") : CGO.t("role_assistant");
      const dateText = CGO.formatExportDate(message.createTime);
      const sourceText = typeof message.renderText === "string" ? message.renderText : message.text;
      const renderedText =
        zipMode
          ? rewriteSandboxLinksForZip(sourceText, message.visibleAttachments || message.attachments || [])
          : sourceText;
      const rawMarkdownJson = JSON.stringify(typeof sourceText === "string" ? sourceText : "")
        .replace(/<\//g, "<\\/");
      const markdownCopyLabel = CGO.escapeHtml(CGO.t("copy_markdown_button"));
      let bodyHtml = CGO.renderMessageTextToHtml(renderedText, { interactiveCode });
      bodyHtml = renderPreparedInlineImagesInHtml(bodyHtml, message, {
        noImg: !!lightweight,
        zipMode: !!zipMode,
      });
      const visibleAttachments = Array.isArray(message.visibleAttachments)
        ? message.visibleAttachments
        : (message.attachments || []);
      const visibleImages = Array.isArray(message.visibleImages)
        ? message.visibleImages
        : (message.images || []);

      return `
  <section class="message ${CGO.escapeHtml(message.role)}" id="mes-${CGO.escapeHtml(message.id)}">
    <script type="application/json" class="cgo-message-markdown">${rawMarkdownJson}</script>
    <div class="message-header">
      <div class="message-header-main">
        <span class="message-role">${CGO.escapeHtml(roleLabel)}</span>
        <span class="message-date">${CGO.escapeHtml(dateText)}</span>
      </div>
      <div class="message-header-actions">
        <button type="button" class="cgo-icon-btn cgo-markdown-copy-btn" title="${markdownCopyLabel}" aria-label="${markdownCopyLabel}">
          ${CGO.getMarkdownCopyIconSvg()}
          <span class="cgo-icon-tooltip">${markdownCopyLabel}</span>
        </button>
      </div>
    </div>
    <div class="message-body">
      ${bodyHtml}
      ${thoughtsRenderer(message.thoughts || [], message.id)}
      ${imageRenderer(visibleImages)}
      ${renderImagePrompts(message.imagePrompts || [])}
      ${attachmentRenderer(visibleAttachments)}
    </div>
  </section>`;
    }).join("\n");

    return `<!doctype html>
  <html lang="${CGO.escapeHtml(CGO.DETECTION_LANG)}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${projectName ? `<meta name="cgo:project" content="${CGO.escapeHtml(projectName)}">` : ""}
    ${conversationTitle ? `<meta name="cgo:conversation-title" content="${CGO.escapeHtml(conversationTitle)}">` : ""}
    ${conversationId ? `<meta name="cgo:conversation-id" content="${CGO.escapeHtml(conversationId)}">` : ""}
    <meta name="cgo:exported-at" content="${CGO.escapeHtml(new Date().toISOString())}">
    <title>${CGO.escapeHtml(title)}</title>
    <style>
      ${sharedCss}
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
    ${interactiveUi
        ? `<script>${sharedUiJs || ""}</script>
    <script>
      window.CGOExportUI?.init({
        enableCodeActions: ${interactiveCode ? "true" : "false"},
        enableHighlight: ${highlightAssets?.js ? "true" : "false"},
      });
    </script>`
        : ""}
    ${highlightAssets?.js ? `<script>${highlightAssets.js}</script>` : ""}
  </body>
  </html>`;
  }

  function downloadTextFile(filename, text, mimeType = "text/plain;charset=utf-8") {
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /**
   * Stores a payload temporarily in chrome.storage.local under a generated token and opens the export viewer page for that token in a new tab.
   *
   * The function adds an `exportedAt` timestamp to the stored payload and generates a token used both as the storage key prefix (`cgo_viewer_<token>`) and as a `token` query parameter to viewer.html.
   * @param {Object} payload - Arbitrary serializable data to make available to the lightweight viewer.
   */
  async function openLightweightViewer(payload) {
    const token =
      Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
    const key = `cgo_viewer_${token}`;

    await chrome.storage.local.set({
      [key]: {
        ...payload,
        exportedAt: Date.now(),
      },
    });

    const viewerUrl =
      chrome.runtime.getURL("viewer.html") +
      `?token=${encodeURIComponent(token)}`;

    window.open(viewerUrl, "_blank", "noopener,noreferrer");
  }

  CGO.buildSafeFilename = function buildSafeFilename(baseName, ext = "html") {
    const safeBase = (baseName || "chatgpt_conversation")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);

    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    return `${safeBase || "chatgpt_conversation"}_${stamp}.${ext}`;
  }

  CGO.getCurrentVisibleMessageId = function getCurrentVisibleMessageId() {
    const turns = Array.from(document.querySelectorAll('article[data-testid^="conversation-turn-"]'));
    if (turns.length === 0) return "";

    const viewportCenter = window.innerHeight / 2;
    let bestEl = null;
    let bestDistance = Infinity;

    for (const el of turns) {
      const rect = el.getBoundingClientRect();
      const center = rect.top + rect.height / 2;
      const distance = Math.abs(center - viewportCenter);

      if (distance < bestDistance) {
        bestDistance = distance;
        bestEl = el;
      }
    }

    if (!bestEl) return "";

    // Parse turn id from data-testid attribute
    const testId = bestEl.getAttribute('data-testid') || "";
    const match = testId.match(/^conversation-turn-(.+)$/);
    if (match) {
      return match[1];
    }

    // Fallback to dataset.turnId
    return bestEl.dataset.turnId || "";
  }

  CGO.exportCurrentConversationAsHtml = async function exportCurrentConversationAsHtml(button, action = "download") {
    try {
      const conversationId = CGO.getConversationIdFromLocation();
      if (!conversationId) {
        throw new Error("conversationId not found");
      }
      const conversationData = await CGO.getConversationFromCache();
      if (!conversationData) {
        throw new Error("conversation cache not found");
      }
      const mapping = conversationData?.mapping || {};
      const currentNode = conversationData?.current_node || null;

      if (!currentNode || !mapping[currentNode]) {
        throw new Error("Current conversation node not found.");
      }
      const isLightweight = action !== "download";

      const chain = CGO.buildExportChain(mapping, currentNode);
      const baseMessages = CGO.normalizeMessagesForExport(chain, mapping);
      const domAssets = CGO.buildDomAssetMap();
      const messages = CGO.mergeMessagesWithDomAssets(baseMessages, domAssets);
      const authorization = await CGO.getLastAuthorizationFromPage();

      if (!isLightweight) {
        // まず cache 優先 + 無い分だけ API
        await CGO.resolveImageUrlsWithDownloadApi(
          messages,
          conversationId,
          authorization,
          ({ done, total }) => {
            if (total > 0) {
              CGO.setToolbarButtonText(button, CGO.t("export_resolving_progress", [done, total]));
            }
          },
          3
        );

        await CGO.resolveAttachmentUrlsWithDownloadApi(
          messages,
          conversationId,
          authorization,
          ({ done, total }) => {
            if (total > 0) {
              CGO.setToolbarButtonText(button, CGO.t("export_resolving_attachments_progress", [done, total]));
            }
          },
          3
        );

        // 画像埋め込み
        await CGO.embedImagesInMessages(
          messages,
          ({ done, total }) => {
            if (total > 0) {
              CGO.setToolbarButtonText(button, CGO.t("export_progress", [done, total]));
            }
          },
          3
        );
      }

      for (const message of messages) {
        CGO.prepareInlineImageData(message);
      }

      CGO.log("[export] counts", {
        chain: chain.length,
        baseMessages: baseMessages.length,
        domAssets: domAssets.length,
        merged: messages.length,
      });

      const conversationTitle = (conversationData?.title || "").trim() || "ChatGPT Conversation";
      const fallbackProjectName = CGO.extractProjectNameFromDocumentTitle(
        document.title, conversationTitle
      );
      const projectName = (conversationData?.project_name || "").trim() || fallbackProjectName;

      const title = projectName
        ? `${projectName} / ${conversationTitle}`
        : conversationTitle;

      const highlightAssets = !isLightweight
        ? await getHighlightAssets()
        : null;
      const sharedExportAssets = await CGO.getSharedExportAssets();

      const html = CGO.buildConversationExportHtml(
        title,
        conversationId,
        messages,
        {
          lightweight: isLightweight,
          interactiveCode: !isLightweight,
          interactiveUi: true,
          highlightAssets,
          projectName,
          conversationTitle,
          sharedCss: sharedExportAssets.css,
          sharedUiJs: sharedExportAssets.uiJs,
        }
      );

      if (action == "download") {
        downloadTextFile(CGO.buildSafeFilename(title, "html"), html, "text/html;charset=utf-8");
      } else {
        const lightweightPayload = {
          title,
          conversationId,
          projectName,
          conversationTitle,
          messageId: action === "download" ? "" : action,
          messages: messages.map((message) => ({
            id: message.id,
            role: message.role,
            createTime: message.createTime,
            text: message.text || "",
            renderText: typeof message.renderText === "string" ? message.renderText : (message.text || ""),
            thoughts: message.thoughts || [],
            images: message.images || [],
            visibleImages: message.visibleImages || [],
            attachments: message.attachments || [],
            visibleAttachments: message.visibleAttachments || [],
          })),
        };
        await openLightweightViewer(lightweightPayload);
        return;
      }

      CGO.log("[export] HTML exported", {
        title,
        messages: messages.length,
      });
    } catch (error) {
      CGO.log("[export:error] failed", error);
      alert(`${CGO.t("export_failed")}: ${error.message}`);
      throw error;
    }
  }
})();