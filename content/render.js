(() => {
  if (globalThis.__CGO_SKIP__) return;
  const CGO = (globalThis.__CGO ||= {});

  /**
   * Merge message data from the conversation API with images and attachments discovered in the DOM.
   *
   * This fills gaps where exported message payloads omit signed URLs or rendered assets that are
   * already visible in the page.
   *
   * @param {Object[]} messages - Normalized export messages.
   * @param {Object[]} domAssets - Assets scraped from rendered conversation turns.
   * @returns {Object[]} Messages enriched with images, prompts, and attachments.
   */
  function mergeMessagesWithDomAssets(messages, domAssets) {
    const merged = messages.map((message) => ({
      ...message,
      images: [],
      attachments: [],
      imagePrompts: [
        ...(Array.isArray(message.imagePrompts) ? message.imagePrompts : []),
        ...(Array.isArray(message.imagePromptSeeds) ? message.imagePromptSeeds : []),
      ],
    }));

    const { byMessageId, anonymous } = CGO.buildAssistantDomImagePools(domAssets);
    const domImageUrlIndex = CGO.buildDomImageUrlIndex(domAssets);
    let anonymousIndex = anonymous.length - 1;

    for (let i = merged.length - 1; i >= 0; i--) {
      const message = merged[i];
      const isImageMessage = CGO.isImageCandidateMessage(message);

      let collectedImages = [];
      let collectedPrompts = Array.isArray(message.imagePrompts)
        ? [...message.imagePrompts]
        : [];
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
          for (const promptHint of promptHints) {
            addPromptOnce(collectedPrompts, promptHint);
          }
        }

        // content_references 由来画像の hint も prompt に反映
        for (const image of collectedImages) {
          if (image?.hint) {
            addPromptOnce(collectedPrompts, {
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
        const source = String(image?.source || "");

        return (
          /^content-reference-image-/i.test(source) ||
          /^image\//i.test(mimeType) ||
          /\.(png|jpg|jpeg|webp|gif|bmp|svg)$/i.test(fileName) ||
          /[?&]mime_type=image%2F/i.test(url) ||
          /^https:\/\/images\.openai\.com\/static-rsc-/i.test(url) ||
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

      normalizeImageVariantsForDisplay(message);
      CGO.prepareInlineImageData(message);
      sanitizeRenderableMedia(message);

      if (isImageMessage && message.images.length) {
        CGO.log("[export] image message merged", {
          id: message.id,
          imageCount: message.images.length,
          attachmentCount: message.attachments.length,
          promptCount: message.imagePrompts.length,
        });
      }
    }

    return dedupeGeneratedImageExportItems(merged);
  }

  /**
   * Append an image prompt entry when its text has not already been recorded.
   *
   * @param {Object[]} list - Prompt entry list to mutate.
   * @param {Object} item - Prompt entry candidate.
   * @returns {void}
   */
  function addPromptOnce(list, item) {
    const text = String(item?.text || "").trim();
    if (!text) return;
    if (list.some((entry) => String(entry?.text || "").trim() === text)) return;
    list.push(item);
  }

  /**
   * Determine whether a normalized export item represents a generated-image assistant message.
   *
   * @param {Object} message - Normalized export item.
   * @returns {boolean} `true` when the item should participate in generated-image merging.
   */
  function isGeneratedImageExportItem(message) {
    if (!message || message.role !== "assistant") return false;

    if (typeof message.id === "string" && message.id.includes(":generated-image")) {
      return true;
    }

    if (typeof CGO.hasToolGeneratedImages === "function" && CGO.hasToolGeneratedImages(message)) {
      return true;
    }

    const images = Array.isArray(message.images) ? message.images : [];
    return images.some((image) => {
      const source = String(image?.source || "");
      return (
        source.includes("tool-asset-pointer") ||
        source.includes("content-reference-image-group") ||
        source.includes("data-file-id") ||
        source.includes("data-url")
      );
    });
  }

  /**
   * Build a stable deduplication key for an exported generated image.
   *
   * @param {Object} image - Exported image metadata.
   * @returns {string} Image key or an empty string when no stable key is available.
   */
  function getGeneratedImageKey(image) {
    if (!image || typeof image !== "object") return "";

    if (image.fileId) return `file:${image.fileId}`;

    const url = String(image.url || image.embeddedUrl || image.localPath || "");
    if (url) {
      const fileIdMatch = url.match(/file_[A-Za-z0-9]+/);
      if (fileIdMatch) return `file:${fileIdMatch[0]}`;
      return `url:${url}`;
    }

    const title = String(image.title || image.alt || "");
    const width = Number(image.width || 0);
    const height = Number(image.height || 0);
    const size = Number(image.fileSizeBytes || 0);

    if (width && height && size) {
      return `meta:${width}x${height}:${size}:${title}`;
    }

    return "";
  }

  /**
   * Score image metadata richness so merges can prefer the more complete representation.
   *
   * @param {Object} image - Exported image metadata.
   * @returns {number} Richness score where higher is better.
   */
  function scoreImageMeta(image) {
    if (!image || typeof image !== "object") return 0;

    let score = 0;
    if (image.fileId) score += 20;
    if (image.url) score += 20;
    if (image.embeddedUrl) score += 20;
    if (image.localPath) score += 20;
    if (image.thumbnailUrl) score += 8;
    if (image.originalUrl) score += 8;
    if (image.sourceUrl) score += 8;
    if (image.alt) score += 12;
    if (image.title) score += 12;
    if (image.fileName) score += 8;
    if (image.mimeType) score += 6;
    if (Number(image.width || 0)) score += 6;
    if (Number(image.height || 0)) score += 6;
    if (Number(image.fileSizeBytes || 0)) score += 6;
    if (image.source) score += 2;
    if (image.unresolved === false) score += 4;

    return score;
  }

  /**
   * Merge two image metadata objects while preferring the richer non-generic values.
   *
   * @param {Object} primaryImage - Preferred image metadata.
   * @param {Object} donorImage - Fallback image metadata.
   * @returns {Object} Normalized merged image metadata.
   */
  function mergeImageMetaPreferRich(primaryImage, donorImage) {
    const primary = primaryImage || {};
    const donor = donorImage || {};

    const preferString = (a, b) => {
      const aa = String(a || "").trim();
      const bb = String(b || "").trim();

      if (!aa) return bb;
      if (!bb) return aa;

      const generic = /^(generated image|生成された画像|画像データあり|image data present)$/i;
      if (generic.test(aa) && !generic.test(bb)) return bb;
      if (bb.length > aa.length && !generic.test(bb)) return bb;

      return aa;
    };

    return CGO.normalizeImageMeta({
      ...primary,
      fileId: primary.fileId || donor.fileId || "",
      url: CGO.choosePreferredImageUrl
        ? CGO.choosePreferredImageUrl(primary.url, donor.url)
        : (primary.url || donor.url || ""),
      embeddedUrl: primary.embeddedUrl || donor.embeddedUrl || null,
      localPath: primary.localPath || donor.localPath || "",
      thumbnailUrl: primary.thumbnailUrl || donor.thumbnailUrl || "",
      originalUrl: primary.originalUrl || donor.originalUrl || "",
      sourceUrl: primary.sourceUrl || donor.sourceUrl || "",
      fileName: preferString(primary.fileName, donor.fileName),
      mimeType: primary.mimeType || donor.mimeType || "",
      fileSizeBytes: Number(primary.fileSizeBytes || donor.fileSizeBytes || 0),
      width: Number(primary.width || donor.width || 0),
      height: Number(primary.height || donor.height || 0),
      alt: preferString(primary.alt, donor.alt),
      title: preferString(primary.title, donor.title),
      source: primary.source || donor.source || "",
      unresolved: primary.unresolved === false || donor.unresolved === false
        ? false
        : !!(primary.unresolved || donor.unresolved),
      skipReason: primary.skipReason || donor.skipReason || "",
    });
  }

  /**
   * Merge prompt entry lists while preserving order and deduplicating by prompt text.
   *
   * @param {Object[]} primaryPrompts - Existing prompt entries.
   * @param {Object[]} donorPrompts - Additional prompt entries.
   * @returns {Object[]} Deduplicated prompt entries.
   */
  function mergePromptLists(primaryPrompts, donorPrompts) {
    const out = [];
    const seen = new Set();

    for (const item of [...(primaryPrompts || []), ...(donorPrompts || [])]) {
      const text = String(item?.text || "").trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      out.push(item);
    }

    return out;
  }

  /**
   * Merge tool-message arrays while preserving order and deduplicating by message id.
   *
   * @param {Object[]} primaryTools - Existing tool messages.
   * @param {Object[]} donorTools - Additional tool messages.
   * @returns {Object[]} Deduplicated tool message list.
   */
  function mergeToolMessageLists(primaryTools, donorTools) {
    const out = [];
    const seenIds = new Set();

    for (const tool of [...(primaryTools || []), ...(donorTools || [])]) {
      if (!tool) continue;

      const id = tool?.id || "";
      if (id) {
        if (seenIds.has(id)) continue;
        seenIds.add(id);
      }

      out.push(tool);
    }

    return out;
  }

  /**
   * Merge attachment lists and remove duplicates by file identity.
   *
   * @param {Object[]} primaryAttachments - Existing attachment entries.
   * @param {Object[]} donorAttachments - Additional attachment entries.
   * @returns {Object[]} Deduplicated attachment list.
   */
  function mergeAttachmentLists(primaryAttachments, donorAttachments) {
    const merged = [
      ...(primaryAttachments || []),
      ...(donorAttachments || []),
    ];

    if (typeof CGO.dedupeAttachments === "function") {
      return CGO.dedupeAttachments(merged);
    }

    const out = [];
    const seen = new Set();

    for (const attachment of merged) {
      if (!attachment) continue;

      const key = [
        attachment.fileId || "",
        attachment.url || "",
        attachment.name || attachment.fileName || "",
      ].join("|");

      if (key !== "||" && seen.has(key)) continue;
      if (key !== "||") seen.add(key);
      out.push(attachment);
    }

    return out;
  }

  /**
   * Build a grouping key for image variants that represent the same user-facing asset.
   *
   * @param {Object} image - Image metadata.
   * @returns {string} Variant key or an empty string.
   */
  function getImageVariantKey(image) {
    if (!image || typeof image !== "object") return "";

    const names = [
      image.fileName,
      image.title,
      image.alt,
    ]
      .map(normalizeRenderableMediaName)
      .filter(Boolean);

    const name = names.find((value) => /\.(png|jpg|jpeg|webp|gif|bmp|svg)$/i.test(value)) || names[0] || "";
    if (!name) return "";

    const mimeType = String(image.mimeType || "").toLowerCase();
    const looksImage =
      /^image\//i.test(mimeType) ||
      /\.(png|jpg|jpeg|webp|gif|bmp|svg)$/i.test(name);

    return looksImage ? `name:${name}` : "";
  }

  /**
   * Choose the image variant that should be rendered inline.
   *
   * @param {Object[]} images - Image variants for the same user-facing asset.
   * @returns {Object|null} Preferred lightweight display image.
   */
  function chooseLightweightDisplayImage(images) {
    const candidates = (images || []).filter(Boolean);
    if (!candidates.length) return null;

    return candidates.slice().sort((a, b) => {
      const aSize = Number(a?.fileSizeBytes || 0);
      const bSize = Number(b?.fileSizeBytes || 0);
      const aa = aSize > 0 ? aSize : Number.POSITIVE_INFINITY;
      const bb = bSize > 0 ? bSize : Number.POSITIVE_INFINITY;
      if (aa !== bb) return aa - bb;

      const aPixels = Number(a?.width || 0) * Number(a?.height || 0);
      const bPixels = Number(b?.width || 0) * Number(b?.height || 0);
      const ap = aPixels > 0 ? aPixels : Number.POSITIVE_INFINITY;
      const bp = bPixels > 0 ? bPixels : Number.POSITIVE_INFINITY;
      if (ap !== bp) return ap - bp;

      const aResolved = a?.embeddedUrl || a?.localPath || (a?.url && a?.unresolved === false);
      const bResolved = b?.embeddedUrl || b?.localPath || (b?.url && b?.unresolved === false);
      if (!!aResolved !== !!bResolved) return aResolved ? -1 : 1;

      return 0;
    })[0];
  }

  /**
   * Collapse multiple size variants of the same attached image.
   *
   * The smallest known variant remains in the image gallery; other variants are
   * discarded because ChatGPT's duplicate upload representations are not always
   * independently downloadable.
   *
   * @param {Object} message - Export message mutated in place.
   * @returns {Object} The same message reference.
   */
  function normalizeImageVariantsForDisplay(message) {
    if (!message || typeof message !== "object") return message;

    const images = Array.isArray(message.images) ? message.images : [];
    if (images.length < 2) return message;

    const groups = new Map();
    const passthrough = [];

    for (const image of images) {
      const key = getImageVariantKey(image);
      if (!key) {
        passthrough.push(image);
        continue;
      }

      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(image);
    }

    const keptImages = [...passthrough];
    let removedVariantCount = 0;

    for (const group of groups.values()) {
      if (group.length === 1) {
        keptImages.push(group[0]);
        continue;
      }

      const displayImage = chooseLightweightDisplayImage(group);
      if (!displayImage) continue;

      keptImages.push(displayImage);
      removedVariantCount += group.length - 1;
    }

    if (!removedVariantCount) return message;

    message.images = CGO.dedupeImages(keptImages);
    return message;
  }

  /**
   * Remove duplicate generated-image export items that describe the same image assets.
   *
   * @param {Object[]} messages - Normalized export items.
   * @returns {Object[]} Export items with duplicate generated-image entries merged out.
   */
  function dedupeGeneratedImageExportItems(messages) {
    const items = Array.isArray(messages) ? messages : [];
    const removeIds = new Set();
    const primaryByKey = new Map();

    for (const message of items) {
      if (!isGeneratedImageExportItem(message)) continue;

      const images = Array.isArray(message.images) ? message.images : [];
      const keys = images.map(getGeneratedImageKey).filter(Boolean);

      if (keys.length <= 1) continue;

      for (const key of keys) {
        if (!primaryByKey.has(key)) {
          primaryByKey.set(key, message);
        }
      }
    }

    for (const message of items) {
      if (!isGeneratedImageExportItem(message)) continue;
      if (removeIds.has(message.id)) continue;

      const images = Array.isArray(message.images) ? message.images : [];
      const keys = images.map(getGeneratedImageKey).filter(Boolean);

      if (keys.length !== 1) continue;

      const key = keys[0];
      const primary = primaryByKey.get(key);

      if (!primary || primary === message) {
        continue;
      }

      const donorImage = images[0];
      primary.images = (primary.images || []).map((image) => {
        const imageKey = getGeneratedImageKey(image);
        if (imageKey !== key) return image;
        return mergeImageMetaPreferRich(image, donorImage);
      });

      primary.imagePrompts = mergePromptLists(primary.imagePrompts, message.imagePrompts);
      primary.toolMessages = mergeToolMessageLists(primary.toolMessages, message.toolMessages);
      primary.attachments = mergeAttachmentLists(primary.attachments, message.attachments);

      if (typeof CGO.prepareInlineImageData === "function") {
        CGO.prepareInlineImageData(primary);
        sanitizeRenderableMedia(primary);
      }

      removeIds.add(message.id);

      CGO.log("[export] dedupe generated image item", {
        removedId: message.id,
        primaryId: primary.id,
        primaryImageCount: primary.images?.length || 0,
        donorImageCount: images.length,
        donorPromptCount: message.imagePrompts?.length || 0,
      });
    }

    if (!removeIds.size) {
      return items;
    }

    return items.filter((message) => !removeIds.has(message.id));
  }


  /**
   * Render prompt or hint text associated with generated images.
   *
   * @param {Array<{text: string}>} imagePrompts - Image prompt descriptors.
   * @returns {string} HTML fragment.
   */
  function renderImagePrompts(imagePrompts) {
    if (!Array.isArray(imagePrompts) || imagePrompts.length === 0) return "";

    const prompts = imagePrompts.filter(isRenderableImagePrompt);
    if (!prompts.length) return "";

    return prompts
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

  /**
   * Decide whether an image prompt entry should be rendered in the export UI.
   *
   * @param {Object} item - Prompt entry metadata.
   * @returns {boolean} `true` when the prompt is visible to the user.
   */
  function isRenderableImagePrompt(item) {
    const source = String(item?.source || "");
    const text = String(item?.text || "").trim();

    if (!text) return false;
    if (source === "parent-user-message") return false;
    if (source === "tool-image-gen-title") return false;
    if (source === "tool-async-task-title") return false;

    return true;
  }

  /**
   * Render collapsible thought panels for assistant messages that include reasoning summaries.
   *
   * @param {Object[]} thoughts - Thought items attached to a message.
   * @param {string} [messageId=""] - Message id used to generate stable DOM ids.
   * @returns {string} HTML fragment.
   */
  function renderThoughts(thoughts, messageId = "") {
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
        ? renderMessageTextToHtml(item.content, { interactiveCode: false })
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
      >${getThoughtIconSvg()}</button>
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

  /**
   * Render human-readable image metadata such as dimensions, size, and MIME type.
   *
   * @param {Object} image - Normalized image metadata.
   * @returns {string} HTML fragment.
   */
  function renderImageMeta(image) {
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

  /**
   * Render a single image figure for HTML or ZIP export modes.
   *
   * @param {Object} image - Normalized image metadata.
   * @param {Object} [options={}] - Rendering options.
   * @returns {string} HTML fragment for one image figure.
   */
  function renderSingleImageFigure(image, options = {}) {
    const mode = options.mode || "html"; // "html" | "zip"
    const noImg = !!options.noImg;
    const alt = CGO.escapeHtml(image.alt || "");
    const caption = CGO.escapeHtml(image.alt || image.title || "");
    const sourceLink = CGO.renderImageSourceLink(image);
    const skipLabel = CGO.getImageSkipLabel(image);
    const isExternal = CGO.isProbablyExternalImage(image);
    const lightweightUrl = image.thumbnailUrl || image.url || "";
    const isReferenceImage = /^content-reference-image-/i.test(String(image.source || ""));

    if (noImg && lightweightUrl && !image.unresolved && isExternal && isReferenceImage) {
      return `<figure class="cgo-image cgo-image-external">
        <img src="${CGO.escapeHtml(lightweightUrl)}" data-cgo-full-src="${CGO.escapeHtml(image.url || lightweightUrl)}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer">
        ${caption ? `<figcaption>${caption}</figcaption>` : ""}
        ${renderImageMeta(image)}
        ${sourceLink}
      </figure>`;
    }

    // ZIP内ローカル画像
    if (mode === "zip" && image.localPath) {
      return `<figure class="cgo-image${isExternal ? " cgo-image-external" : ""}">
        <img src="${CGO.escapeHtml(image.localPath)}" alt="${alt}">
        ${caption ? `<figcaption>${caption}</figcaption>` : ""}
        ${renderImageMeta(image)}
        ${sourceLink}
      </figure>`;
    }

    // HTML埋め込み済み画像
    if (mode === "html" && image.embeddedUrl && !noImg) {
      return `<figure class="cgo-image${isExternal ? " cgo-image-external" : ""}">
        <img src="${image.embeddedUrl}" alt="${alt}">
        ${caption ? `<figcaption>${caption}</figcaption>` : ""}
        ${renderImageMeta(image)}
        ${sourceLink}
      </figure>`;
    }

    // 外部画像は参照用としてそのまま表示
    if (image.url && !image.unresolved && isExternal) {
      return `<figure class="cgo-image cgo-image-external">
        <img src="${CGO.escapeHtml(image.url)}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer">
        ${caption ? `<figcaption>${caption}</figcaption>` : ""}
        ${renderImageMeta(image)}
        ${sourceLink}
      </figure>`;
    }

    // HTML側で未埋め込みだが内部URLが生きている場合
    if (mode === "html" && image.url && !image.unresolved && !isExternal && !noImg) {
      return `<figure class="cgo-image">
        <img src="${CGO.escapeHtml(image.url)}" alt="${alt}">
        ${caption ? `<figcaption>${caption}</figcaption>` : ""}
        ${renderImageMeta(image)}
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

  /**
   * Render an image gallery, optionally suppressing inline `<img>` output.
   *
   * @param {Object[]} images - Images to render.
   * @param {boolean} [noImg=false] - Whether to hide actual image tags.
   * @returns {string} HTML fragment.
   */
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

  /**
   * Render inline image references as a compact gallery.
   *
   * @param {Object[]} images - Inline image metadata entries.
   * @param {Object} [options={}] - Rendering options.
   * @returns {string} Gallery markup.
   */
  function renderInlineImageGroup(images, options = {}) {
    if (!Array.isArray(images) || !images.length) return "";

    const mode = options.zipMode ? "zip" : "html";
    const noImg = !!options.noImg;
    const items = images
      .map((image) => CGO.renderSingleImageFigure(image, { mode, noImg }))
      .filter(Boolean);

    if (!items.length) return "";

    return `<div class="cgo-images cgo-images-external cgo-images-inline-reference">
      ${items.join("\n")}
    </div>`;
  }

  /**
   * Render images for normal HTML exports.
   *
   * @param {Object[]} images - Images to render.
   * @returns {string} HTML fragment.
   */
  function renderImages(images) {
    return renderImagesBase(images);
  }

  /**
   * Render image placeholders without embedding image tags.
   *
   * @param {Object[]} images - Images to render.
   * @returns {string} HTML fragment.
   */
  function renderImagesNoImg(images) {
    const noImg = true;
    return renderImagesBase(images, noImg);
  }

  /**
   * Promote image attachments into the message image collection so they render in the image gallery.
   *
   * @param {Object} message - Normalized export message.
   */
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

  /**
   * Normalize a media label for duplicate detection.
   *
   * @param {*} value - Candidate label value.
   * @returns {string} Normalized label.
   */
  function normalizeRenderableMediaName(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/\\/g, "/")
      .split("/")
      .pop()
      .replace(/\?.*$/, "")
      .replace(/^!+/, "");
  }

  /**
   * Extract stable identifiers from image/attachment metadata.
   *
   * @param {Object} asset - Media metadata.
   * @returns {string[]} Candidate identifiers.
   */
  function getRenderableMediaIds(asset) {
    const ids = new Set();
    const directId = String(asset?.fileId || "").trim();
    if (directId) ids.add(directId);

    const rawValues = [
      asset?.url,
      asset?.embeddedUrl,
      asset?.localPath,
    ];

    for (const rawValue of rawValues) {
      const value = String(rawValue || "").trim();
      if (!value) continue;

      const fileIdMatch = value.match(/file_[A-Za-z0-9]+/i);
      if (fileIdMatch) ids.add(fileIdMatch[0]);

      const downloadMatch = value.match(/\/backend-api\/files\/([A-Za-z0-9_-]+)\/download(?:\?|$)/i);
      if (downloadMatch) ids.add(downloadMatch[1]);

      const estuaryMatch = value.match(/[?&]id=([A-Za-z0-9_-]+)/i);
      if (estuaryMatch) ids.add(estuaryMatch[1]);
    }

    return Array.from(ids);
  }

  /**
   * Build a compact identity descriptor for render-time media filtering.
   *
   * @param {Object} asset - Image or attachment metadata.
   * @returns {{ids: string[], urls: string[], names: string[], fileSizeBytes: number, width: number, height: number}} Identity descriptor.
   */
  function buildRenderableMediaIdentity(asset) {
    const names = [
      asset?.name,
      asset?.fileName,
      asset?.title,
      asset?.alt,
    ]
      .map(normalizeRenderableMediaName)
      .filter(Boolean);

    const urls = [
      asset?.url,
      asset?.embeddedUrl,
      asset?.localPath,
    ]
      .map((value) => String(value || "").trim())
      .filter(Boolean);

    return {
      ids: getRenderableMediaIds(asset),
      urls: Array.from(new Set(urls)),
      names: Array.from(new Set(names)),
      fileSizeBytes: Number(asset?.fileSizeBytes || 0),
      width: Number(asset?.width || 0),
      height: Number(asset?.height || 0),
    };
  }

  /**
   * Decide whether two image/attachment records should be treated as the same rendered media.
   *
   * @param {Object} asset - Candidate media metadata.
   * @param {Object} identity - Identity descriptor.
   * @returns {boolean} `true` when both records refer to the same media.
   */
  function isRenderableMediaMatch(asset, identity) {
    if (!asset || !identity) return false;

    const candidate = buildRenderableMediaIdentity(asset);

    if (candidate.ids.some((id) => identity.ids.includes(id))) {
      return true;
    }

    if (candidate.urls.some((url) => identity.urls.includes(url))) {
      return true;
    }

    const sharedName = candidate.names.find((name) => identity.names.includes(name));
    if (!sharedName) return false;

    if (
      candidate.fileSizeBytes > 0 &&
      identity.fileSizeBytes > 0 &&
      candidate.fileSizeBytes === identity.fileSizeBytes
    ) {
      return true;
    }

    if (
      candidate.width > 0 &&
      candidate.height > 0 &&
      identity.width > 0 &&
      identity.height > 0 &&
      candidate.width === identity.width &&
      candidate.height === identity.height
    ) {
      return true;
    }

    return candidate.names.length === 1 && identity.names.length === 1;
  }

  /**
   * Apply a final render-time cleanup so inline images, gallery images, and attachment cards do not duplicate each other.
   *
   * @param {Object} message - Export message mutated in place.
   * @returns {Object} The same message reference.
   */
  function sanitizeRenderableMedia(message) {
    if (!message || typeof message !== "object") return message;

    const inlineImages = Array.isArray(message.inlineImages)
      ? message.inlineImages
        .map((entry) => entry?.image)
        .filter((image) => image && typeof image === "object")
      : [];

    const inlineIdentities = inlineImages.map(buildRenderableMediaIdentity);

    const sourceImages = Array.isArray(message.visibleImages)
      ? message.visibleImages
      : (Array.isArray(message.images) ? message.images : []);
    const dedupedImages = [];
    const seenImageIdentities = [];

    for (const image of sourceImages) {
      if (!image || typeof image !== "object") continue;
      if (inlineIdentities.some((identity) => isRenderableMediaMatch(image, identity))) {
        continue;
      }

      const identity = buildRenderableMediaIdentity(image);
      if (seenImageIdentities.some((seen) => isRenderableMediaMatch(image, seen))) {
        continue;
      }

      dedupedImages.push(image);
      seenImageIdentities.push(identity);
    }

    const sourceAttachments = Array.isArray(message.visibleAttachments)
      ? message.visibleAttachments
      : (Array.isArray(message.attachments) ? message.attachments : []);
    const hiddenAttachmentIdentities = [
      ...inlineIdentities,
      ...seenImageIdentities,
    ];

    const filteredAttachments = sourceAttachments.filter((attachment) => {
      if (!attachment || typeof attachment !== "object") return false;
      return !hiddenAttachmentIdentities.some((identity) => isRenderableMediaMatch(attachment, identity));
    });

    message.visibleImages = dedupedImages;
    message.visibleAttachments = filteredAttachments;
    return message;
  }

  /**
   * Replace inline image placeholder tokens in rendered HTML with image figure markup.
   *
   * @param {string} bodyHtml - Rendered message HTML.
   * @param {Object} message - Message containing `inlineImages`.
   * @param {Object} [options={}] - Rendering options.
   * @returns {string} HTML with inline placeholders expanded.
   */
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
      if (!entry?.token) continue;

      const figureHtml = Array.isArray(entry.images)
        ? renderInlineImageGroup(entry.images, { zipMode, noImg })
        : entry.image
          ? CGO.renderSingleImageFigure(entry.image, {
            mode: zipMode ? "zip" : "html",
            noImg,
          })
          : "";

      if (!figureHtml) continue;

      html = html.split(entry.token).join(figureHtml);
    }

    return html;
  }

  /**
   * Load a packaged text asset from the extension bundle.
   *
   * @param {string} path - Extension-relative asset path.
   * @returns {Promise<string>} Asset text content.
   */
  async function loadExtensionTextFile(path) {
    const url = chrome.runtime.getURL(path);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load ${path}`);
    return res.text();
  }

  /**
   * Load syntax-highlighting assets packaged with the extension.
   *
   * @returns {Promise<{js: string, css: string}>} Highlight.js script and stylesheet content.
   */
  async function getHighlightAssets() {
    const [js, css] = await Promise.all([
      CGO.loadExtensionTextFile("vendor/highlight.min.js"),
      CGO.loadExtensionTextFile("vendor/github-dark.min.css"),
    ]);
    return { js, css };
  }


  /**
   * Load the shared CSS and UI JavaScript used by exported conversation pages.
   *
   * @returns {Promise<{css: string, uiJs: string}>} Shared export assets.
   */
  async function getSharedExportAssets() {
    const [css, uiJs] = await Promise.all([
      CGO.loadExtensionTextFile("shared-export.css"),
      CGO.loadExtensionTextFile("shared-export-ui.js"),
    ]);
    return { css, uiJs };
  }

  /**
   * Escape HTML special characters for safe string interpolation into markup.
   *
   * @param {string} text - Raw text.
   * @returns {string} Escaped HTML string.
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
   * Remove ChatGPT-specific private-use markers and excess spacing before markdown rendering.
   *
   * @param {string} text - Raw exported message text.
   * @returns {string} Cleaned markdown-ish text.
   */
  function stripChatgptUiArtifacts(text) {
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

  /**
   * Apply final HTML fixes to rendered markdown, such as external-link attributes.
   *
   * @param {string} containerHtml - Sanitized markdown HTML.
   * @returns {string} Post-processed HTML.
   */
  function postProcessRenderedMarkdown(containerHtml) {
    const wrapper = document.createElement("div");
    wrapper.innerHTML = containerHtml;

    for (const a of wrapper.querySelectorAll("a")) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    }

    return wrapper.innerHTML;
  }

  /**
   * Extract plain text from the different token shapes emitted by `marked`.
   *
   * @param {*} value - Token or raw string value.
   * @returns {string} Extracted text.
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
   * Create a `marked` renderer customized for export-friendly code blocks and inline code.
   *
   * @param {Object} [options={}] - Rendering options.
   * @returns {marked.Renderer} Configured renderer instance.
   */
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

  /**
   * Rewrite sandbox file references inside message text to point at local ZIP paths when available.
   *
   * @param {string} text - Message text that may contain sandbox URLs.
   * @param {Object[]} attachments - Attachments associated with the message.
   * @returns {string} Rewritten text.
   */
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

  /**
   * Render message markdown into sanitized HTML with the extension's export styling conventions.
   *
   * @param {string} text - Raw message text.
   * @param {Object} [options={}] - Markdown rendering options.
   * @returns {string} Rendered HTML fragment.
   */
  function renderMessageTextToHtml(text, options = {}) {
    const source = typeof text === "string" ? text : "";
    if (!source.trim()) return "";
    
    const markdownSrc = stripChatgptUiArtifacts(source).replace(/<([^<>]+)>/g, "&lt;$1&gt;");
    
    if (typeof marked !== "undefined" && typeof DOMPurify !== "undefined") {
      const renderer = createMarkedRenderer(options);
    
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
    
      return `<div class="cgo-markdown">${postProcessRenderedMarkdown(safeHtml)}</div>`;
    } else {
      const safeText = CGO.escapeHtml(markdownSrc);
      return `<div class="cgo-markdown"><p>${safeText.replace(/\n/g, "<br>")}</p></div>`;
    }
  }

  /**
   * Format a ChatGPT message timestamp for display in export output.
   *
   * @param {?number} value - Unix timestamp in seconds.
   * @returns {string} Localized date string or an empty string.
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
   * Return the SVG markup used for the exported thought-toggle icon.
   *
   * @returns {string} SVG markup string.
   */
  function getThoughtIconSvg() {
    return `
    <svg viewBox="0 0 24 24" aria-hidden="true" class="cgo-thought-icon">
      <path fill="currentColor" d="M12 4c-4.42 0-8 2.91-8 6.5 0 1.94 1.05 3.68 2.74 4.87-.12.92-.52 1.89-1.34 2.77 1.64-.15 3.08-.74 4.23-1.72.73.18 1.52.28 2.37.28 4.42 0 8-2.91 8-6.5S16.42 4 12 4zm-3 6.5a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm3 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm3 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z"/>
    </svg>
  `;
  };

  /**
   * Return the SVG markup used for the exported markdown-copy button icon.
   *
   * @returns {string} SVG markup string.
   */
  function getMarkdownCopyIconSvg() {
    return `
    <svg viewBox="0 0 24 24" aria-hidden="true" class="cgo-markdown-copy-icon">
      <path d="M8.5 3.75h6.6l3.15 3.15v9.85a2.25 2.25 0 0 1-2.25 2.25H8.5a2.25 2.25 0 0 1-2.25-2.25V6A2.25 2.25 0 0 1 8.5 3.75Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
      <path d="M15 3.9v3.1h3.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M9.35 10.2h5.3M9.35 13h5.3M9.35 15.8h3.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      <path d="M4.6 7.75v9.9a2.25 2.25 0 0 0 2.25 2.25h7.9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.72"/>
    </svg>`;
  };

  /**
   * Return the SVG markup used for the ChatGPT web-link button.
   *
   * @returns {string} SVG markup string.
   */
  function getChatgptWebLinkIconSvg() {
    return `
    <svg viewBox="0 0 24 24" aria-hidden="true" class="cgo-web-link-icon">
      <path d="M9.25 5.75H6.8A2.05 2.05 0 0 0 4.75 7.8v9.4a2.05 2.05 0 0 0 2.05 2.05h9.4a2.05 2.05 0 0 0 2.05-2.05v-2.45" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M13.25 4.75h6v6M19 5l-8.25 8.25" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }

  /**
   * Render a fixed link to the original ChatGPT web conversation.
   *
   * @param {string} webUrl - Absolute ChatGPT conversation URL.
   * @returns {string} Link HTML or an empty string when no URL is available.
   */
  function renderChatgptWebLink(webUrl) {
    const href = String(webUrl || "").trim();
    if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\/(?:g\/[^/]+\/)?c\/[^/?#]+/i.test(href)) {
      return "";
    }

    const label = CGO.escapeHtml(CGO.t("open_chatgpt_web_link"));
    return `
    <a class="cgo-icon-btn cgo-web-link" href="${CGO.escapeHtml(href)}" target="_blank" rel="noopener noreferrer" aria-label="${label}">
      ${getChatgptWebLinkIconSvg()}
      <span class="cgo-icon-tooltip">${label}</span>
    </a>`;
  }

  /**
   * Get the inline SVG markup used for the voice-transcription badge icon.
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
   * @param {Object} message - Export message.
   * @returns {string} HTML string for the badge or an empty string.
   */
  function renderVoiceTranscriptionBadge(message) {
    if (!message?.isVoiceTranscription) return "";

    const label = CGO.escapeHtml(CGO.t("voice_transcription_label"));
    return `<span class="cgo-voice-badge" role="img" aria-label="${label}" title="${label}">${getVoiceTranscriptionIconSvg()}</span>`;
  }

  /**
   * Build the complete exported conversation HTML document.
   *
   * @param {string} title - Document title.
   * @param {string} conversationId - Conversation id.
   * @param {Object[]} messages - Export messages to render.
   * @param {Object} [options={}] - Export rendering options.
   * @returns {string} Full HTML document string.
   */
  function buildConversationExportHtml(
    title,
    conversationId,
    messages,
    options = {}
  ) {
    const {
      lightweight = false,
      zipMode = false,
      thoughtsRenderer = options.lightweight ? function () { return ""; } : renderThoughts,
      imageRenderer = options.lightweight ? renderImagesNoImg : renderImages,
      attachmentRenderer = CGO.renderAttachments,
      interactiveCode = false,
      interactiveUi = true,
      highlightAttach = false,
      highlightAssets = null,
      includeImages = true,
      projectName = "",
      conversationTitle = "",
      projectGizmoId = "",
      webUrl = "",
      sharedCss = "",
      sharedUiJs = "",
    } = options;

    const resolvedWebUrl = webUrl || CGO.buildChatgptWebConversationUrl?.(
      conversationId,
      projectGizmoId,
      /^https:\/\/(chatgpt\.com|chat\.openai\.com)$/i.test(location.origin)
        ? location.origin
        : "https://chatgpt.com"
    ) || "";

    const messageHtml = messages.map((message) => {
      const roleLabel = message.role === "user" ? CGO.t("role_user") : CGO.t("role_assistant");
      const dateText = formatExportDate(message.createTime);
      const sourceText = typeof message.renderText === "string" ? message.renderText : message.text;
      const renderedText =
        zipMode
          ? rewriteSandboxLinksForZip(sourceText, message.visibleAttachments || message.attachments || [])
          : sourceText;
      const rawMarkdownJson = JSON.stringify(typeof sourceText === "string" ? sourceText : "")
        .replace(/<\//g, "<\\/");
      const markdownCopyLabel = CGO.escapeHtml(CGO.t("copy_markdown_button"));
      let bodyHtml = renderMessageTextToHtml(renderedText, { interactiveCode });
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
        ${renderVoiceTranscriptionBadge(message)}
        <span class="message-date">${CGO.escapeHtml(dateText)}</span>
      </div>
      <div class="message-header-actions">
        <button type="button" class="cgo-icon-btn cgo-markdown-copy-btn" title="${markdownCopyLabel}" aria-label="${markdownCopyLabel}">
          ${getMarkdownCopyIconSvg()}
          <span class="cgo-icon-tooltip">${markdownCopyLabel}</span>
        </button>
      </div>
    </div>
    <div class="message-body">
      ${bodyHtml}
      ${imageRenderer(visibleImages)}
      ${renderImagePrompts(message.imagePrompts || [])}
      ${attachmentRenderer(visibleAttachments)}
      ${thoughtsRenderer(message.thoughts || [], message.id)}
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
    ${projectGizmoId ? `<meta name="cgo:project-gizmo-id" content="${CGO.escapeHtml(projectGizmoId)}">` : ""}
    ${resolvedWebUrl ? `<meta name="cgo:web-url" content="${CGO.escapeHtml(resolvedWebUrl)}">` : ""}
    <meta name="cgo:exported-at" content="${CGO.escapeHtml(new Date().toISOString())}">
    <title>${CGO.escapeHtml(title)}</title>
    <style>
      ${sharedCss}
      ${highlightAssets?.css || ""}
    </style>
    <link rel="icon" type="image/vnd.microsoft.icon" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IB2cksfwAAAARnQU1BAACxjwv8YQUAAAAgY0hSTQAAeiYAAICEAAD6AAAAgOgAAHUwAADqYAAAOpgAABdwnLpRPAAAAAlwSFlzAAALEwAACxMBAJqcGAAAAAd0SU1FB+oFDwgoOwnNG1QAAALSSURBVDjLPZNNbJRVFIafc79+/aY/UxCb0OnMWJkxgAYTJTFQw6YomnSBGomBBf4hiImaEKOyUEJYdMPKjS7UQkLUBhOSBtJIoin4gxhY0EJVAjMNAaH8JIoUO7/f6+J+5SbnnsU995znvXmvARBlSwRhwfZ8Dv1rIQRak4hiFFWxsALrX0QTF0ExxCpTnym20JopYUHBho9DaGhwhS+QwABiANg4SHBkH/GmrcQ//wFGgXBxyYEVCEK0OIdeXguVO1Cdhdpdn6tzUJtD165D0Eb+0C7Szy4DZ2BWcGDgAj8tbgDy0+cpSPL4SeJLV6lf+puVI9sgcAA4DF9cxV/GfDMzH14H1OvE/eu5uvptHDGWnHsCxdj5U9h3ZeyrMQhCbPu72MQ0dnYCe3oVhC30/PopT9z4jPj0RaQ4IXABduAcPLgCvt4LPUuwD4fglffh4Jfw20+wboD20vcoHXF56FvSj/Xw2l/bEsKupbLDTdFREKm8aOsTJ5qyZf2ydRtkB0ZlI9+o4/pZ0ZETbVnZgrzeqO0RXTk5zKFEpl/y+8wt2Pg6LFyAW7MKR82/h4QARw0zw1GvgIuxL37EnlyDHTqFnRnHjv0O44fhn5uYNQjUpO/4bhY9t5wXym9hlSqqN4EoLzqLsv1TsmNN2cikaO+TDe2Xnb8jm/xT1l2UpR/QkjP7NDA7rIFfdoiunEhlBFFWdD4kjja9/lReRFkR9YqOvPIXxkQqK1K9oi0rOnPaXPnYN4gycvekp/CGmveCC3AnRvlvahoc9/Rj0O4a8+6gBbwD7dYVGB5DWwaxrW/C/SmC3m66iw9z+6nldC1dSNrNsfKdR5mbvoka3rFGa6aECwv2yOPw0SeoL4+dHEUf7KBl6gjx86/SuXMD94WzdAe3+feHSS4Ml6ARg1T2JFGuZO/tLZDpQTu3QLMOJuylZ9DBowm6Jf+E5K+oTG2m+D++bDOvk1A/rwAAAABJRU5ErkJggg==">
  </head>
  <body>
    ${renderChatgptWebLink(resolvedWebUrl)}
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

  /**
   * Trigger a browser download for an in-memory text payload.
   *
   * @param {string} filename - Download filename.
   * @param {string} text - File contents.
   * @param {string} [mimeType="text/plain;charset=utf-8"] - Blob MIME type.
   */
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
   * Store a temporary payload in IndexedDB and open the export viewer page for that token.
   *
   * Lightweight viewer payloads are temporary handoff data. They are deleted after 24 hours, and
   * can optionally be deleted after successful display. The storage layer adds `exportedAt`.
   *
   * @param {Object} payload - Serializable data to make available to the lightweight viewer.
   * @returns {Promise<void>}
   */
  async function openLightweightViewer(payload) {
    const token =
      Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10);
    const storage = window.CGOViewerStorage;

    if (!storage?.saveViewerPayload) {
      throw new Error("viewer storage is unavailable");
    }

    try {
      await storage.cleanupExpiredViewerPayloads?.();
    } catch (error) {
      CGO.log("[warn] viewer payload cleanup failed", String(error));
    }

    await storage.saveViewerPayload(token, {
      ...payload,
      deleteAfterRender: CGO.VIEWER_DELETE_AFTER_RENDER === true,
    });

    const viewerUrl =
      chrome.runtime.getURL("viewer.html") +
      `?token=${encodeURIComponent(token)}`;

    window.open(viewerUrl, "_blank", "noopener,noreferrer");
  }

  /**
   * Build a timestamped filename that is safe for browser downloads.
   *
   * @param {string} baseName - Desired base filename.
   * @param {string} [ext="html"] - File extension without dot.
   * @returns {string} Safe filename.
   */
  function buildSafeFilename(baseName, ext = "html") {
    const safeBase = (baseName || "chatgpt_conversation")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);

    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
    return `${safeBase || "chatgpt_conversation"}_${stamp}.${ext}`;
  }

  /**
   * Return the message id whose turn is closest to the viewport center.
   *
   * @returns {string} Visible message id or an empty string.
   */
  function getCurrentVisibleMessageId() {
    const turns = Array.from(
      document.querySelectorAll(
        'article[data-testid^="conversation-turn-"], section[data-testid^="conversation-turn-"]'
      )
    );

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

    return (
      bestEl.getAttribute("data-turn-id") ||
      bestEl.querySelector("[data-message-id]")?.getAttribute("data-message-id") ||
      ""
    );
  };

  /**
   * Resolve a DOM-selected message id to the corresponding exported message id.
   *
   * @param {Object[]} messages - Export message list.
   * @param {string} domMessageId - Message id captured from the live DOM.
   * @returns {string} Matching export message id, if found.
   */
  function resolveExportMessageIdFromDomId(messages, domMessageId) {
    if (!domMessageId || !Array.isArray(messages)) return "";

    const direct = messages.find((message) => message?.id === domMessageId);
    if (direct?.id) return direct.id;

    return "";
  }

  /**
   * Export the current conversation either as a downloadable HTML file or a lightweight viewer tab.
   *
   * @param {HTMLButtonElement} button - Toolbar button used to display progress text.
   * @param {string} [action="download"] - Export mode or selected message id for lightweight view.
   * @returns {Promise<void>} Resolves after the export action completes.
   */
  async function exportCurrentConversationAsHtml(button, action = "download") {
    try {
      const conversationId = CGO.getConversationIdFromLocation();
      if (!conversationId) {
        throw new Error("conversationId not found");
      }
      const conversationData = await CGO.getConversationForExport?.(conversationId) ||
        await CGO.getConversationFromCache(conversationId);
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
        sanitizeRenderableMedia(message);
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
      const projectGizmoId =
        CGO.getProjectGizmoIdFromLocation?.() ||
        String(conversationData?.gizmo_id || conversationData?.conversation_template_id || "").trim() ||
        "";

      const title = projectName
        ? `${projectName} / ${conversationTitle}`
        : conversationTitle;
      const webUrl = CGO.buildChatgptWebConversationUrl?.(
        conversationId,
        projectGizmoId,
        /^https:\/\/(chatgpt\.com|chat\.openai\.com)$/i.test(location.origin)
          ? location.origin
          : "https://chatgpt.com"
      ) || "";

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
          projectGizmoId,
          webUrl,
          sharedCss: sharedExportAssets.css,
          sharedUiJs: sharedExportAssets.uiJs,
        }
      );

      if (action == "download") {
        downloadTextFile(CGO.buildSafeFilename(title, "html"), html, "text/html;charset=utf-8");
      } else {
        const requestedMessageId =
          action === "download" ? "" : action;

        const resolvedMessageId =
          requestedMessageId
            ? resolveExportMessageIdFromDomId(messages, requestedMessageId)
            : "";

        const lightweightPayload = {
          title,
          conversationId,
          projectName,
          conversationTitle,
          projectGizmoId,
          webUrl,
          messageId: resolvedMessageId,
          messages: messages.map((message) => ({
            id: message.id,
            role: message.role,
            createTime: message.createTime,
            text: message.text || "",
            renderText: typeof message.renderText === "string" ? message.renderText : (message.text || ""),
            inlineImages: message.inlineImages || [],
            isVoiceTranscription: !!message.isVoiceTranscription,
            voiceDirection: message.voiceDirection || "",
            hasVoiceAudio: !!message.hasVoiceAudio,
            thoughts: message.thoughts || [],
            imagePrompts: message.imagePrompts || [],
            imagePromptSeeds: message.imagePromptSeeds || [],
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

  CGO.buildConversationExportHtml = buildConversationExportHtml;
  CGO.buildSafeFilename = buildSafeFilename;
  CGO.escapeHtml = escapeHtml;
  CGO.exportCurrentConversationAsHtml = exportCurrentConversationAsHtml;
  CGO.getCurrentVisibleMessageId = getCurrentVisibleMessageId;
  CGO.getSharedExportAssets = getSharedExportAssets;
  CGO.loadExtensionTextFile = loadExtensionTextFile;
  CGO.mergeMessagesWithDomAssets = mergeMessagesWithDomAssets;
  CGO.normalizeImageVariantsForDisplay = normalizeImageVariantsForDisplay;
  CGO.renderSingleImageFigure = renderSingleImageFigure;
})();
