(() => {
  "use strict";

  const root = typeof globalThis !== "undefined" ? globalThis : window;
  const MAX_SVG_BLOCKS = 24;
  const MAX_SVG_LENGTH = 200000;
  const FORBIDDEN_SVG_TAGS = Object.freeze([
    "script",
    "style",
    "foreignObject",
    "foreignobject",
    "iframe",
    "object",
    "embed",
    "image",
    "use",
    "a",
    "animate",
    "animateMotion",
    "animatemotion",
    "animateTransform",
    "animatetransform",
    "set",
    "discard",
    "feImage",
    "feimage",
    "audio",
    "video",
  ]);
  const FORBIDDEN_SVG_ATTRIBUTES = Object.freeze([
    "style",
    "href",
    "xlink:href",
    "src",
  ]);
  const REACT_SVG_ATTRIBUTE_ALIASES = Object.freeze({
    alignmentbaseline: "alignment-baseline",
    baselineshift: "baseline-shift",
    clippath: "clip-path",
    cliprule: "clip-rule",
    colorinterpolation: "color-interpolation",
    colorinterpolationfilters: "color-interpolation-filters",
    dominantbaseline: "dominant-baseline",
    fillopacity: "fill-opacity",
    fillrule: "fill-rule",
    floodcolor: "flood-color",
    floodopacity: "flood-opacity",
    fontfamily: "font-family",
    fontsize: "font-size",
    fontstyle: "font-style",
    fontweight: "font-weight",
    letterspacing: "letter-spacing",
    markerend: "marker-end",
    markermid: "marker-mid",
    markerstart: "marker-start",
    shaperendering: "shape-rendering",
    stopcolor: "stop-color",
    stopopacity: "stop-opacity",
    strokedasharray: "stroke-dasharray",
    strokedashoffset: "stroke-dashoffset",
    strokelinecap: "stroke-linecap",
    strokelinejoin: "stroke-linejoin",
    strokemiterlimit: "stroke-miterlimit",
    strokeopacity: "stroke-opacity",
    strokewidth: "stroke-width",
    textanchor: "text-anchor",
    vectoreffect: "vector-effect",
  });

  function normalizeReactSvgAttributes(markup) {
    return String(markup || "").replace(/<[^<>]+>/g, (tag) => {
      return tag.replace(/\s([A-Za-z][A-Za-z0-9]*)(?=\s*=)/g, (attribute, name) => {
        const alias = REACT_SVG_ATTRIBUTE_ALIASES[name.toLowerCase()];
        return alias ? attribute.replace(name, alias) : attribute;
      });
    });
  }

  function getFencedCodeRanges(source) {
    const ranges = [];
    const input = String(source || "");
    const lines = input.split("\n");
    let offset = 0;
    let open = null;

    for (const line of lines) {
      const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (!open && marker) {
        open = {
          start: offset,
          character: marker[1][0],
          length: marker[1].length,
        };
      } else if (open && marker) {
        const value = marker[1];
        if (value[0] === open.character && value.length >= open.length) {
          ranges.push([open.start, offset + line.length]);
          open = null;
        }
      }
      offset += line.length + 1;
    }

    if (open) ranges.push([open.start, input.length]);
    return ranges;
  }

  function isInsideRange(index, ranges) {
    return ranges.some(([start, end]) => index >= start && index <= end);
  }

  function getMarkdownCodeRanges(source) {
    const input = String(source || "");
    const ranges = getFencedCodeRanges(input);
    const tickRuns = Array.from(input.matchAll(/`+/g));

    for (let index = 0; index < tickRuns.length; index += 1) {
      const opening = tickRuns[index];
      if (isInsideRange(opening.index, ranges)) continue;

      for (let closingIndex = index + 1; closingIndex < tickRuns.length; closingIndex += 1) {
        const closing = tickRuns[closingIndex];
        if (isInsideRange(closing.index, ranges)) continue;
        if (closing[0].length !== opening[0].length) continue;
        ranges.push([opening.index, closing.index + closing[0].length]);
        index = closingIndex;
        break;
      }
    }

    return ranges.sort((left, right) => left[0] - right[0]);
  }

  function findSvgEnd(source, start) {
    const tokenPattern = /<\/?svg\b[^<>]*>/gi;
    tokenPattern.lastIndex = start;
    let depth = 0;
    let match;

    while ((match = tokenPattern.exec(source))) {
      if (match.index === start && /^<\s*\//.test(match[0])) return -1;
      if (/^<\s*\//.test(match[0])) {
        depth -= 1;
        if (depth === 0) return tokenPattern.lastIndex;
        if (depth < 0) return -1;
      } else if (/\/\s*>$/.test(match[0])) {
        if (depth === 0) return tokenPattern.lastIndex;
      } else {
        depth += 1;
      }
    }

    return -1;
  }

  /**
   * Replace complete inline SVG blocks outside Markdown code with inert tokens.
   *
   * @param {string} source - Markdown source that may contain raw SVG.
   * @returns {{source: string, blocks: Array<{token: string, markup: string}>}}
   */
  function extractBlocks(source) {
    const input = typeof source === "string" ? source : "";
    const ranges = getMarkdownCodeRanges(input);
    const openPattern = /<svg(?:\s|>)/gi;
    const blocks = [];
    let output = "";
    let cursor = 0;
    let match;

    while (blocks.length < MAX_SVG_BLOCKS && (match = openPattern.exec(input))) {
      if (isInsideRange(match.index, ranges)) continue;

      const end = findSvgEnd(input, match.index);
      if (end < 0) continue;

      const markup = input.slice(match.index, end);
      if (markup.length > MAX_SVG_LENGTH) {
        openPattern.lastIndex = end;
        continue;
      }

      const token = `\uE112CGOSVGBLOCK${blocks.length}\uE113`;
      output += input.slice(cursor, match.index);
      output += `\n\n${token}\n\n`;
      blocks.push({ token, markup });
      cursor = end;
      openPattern.lastIndex = end;
    }

    if (!blocks.length) return { source: input, blocks: [] };
    output += input.slice(cursor);
    return { source: output, blocks };
  }

  /**
   * Sanitize one SVG block with DOMPurify's SVG-only profile.
   *
   * External references, embedded HTML, scripts, animation, and CSS are
   * deliberately disabled. Shape, text, gradient, mask, and filter elements
   * remain available for static agent-generated graphics.
   *
   * @param {string} markup - Raw SVG markup.
   * @param {{sanitize: Function}} sanitizer - DOMPurify-compatible sanitizer.
   * @returns {string} Sanitized SVG markup, or an empty string when invalid.
   */
  function sanitizeBlock(markup, sanitizer) {
    if (!sanitizer || typeof sanitizer.sanitize !== "function") return "";

    const safe = sanitizer.sanitize(normalizeReactSvgAttributes(markup), {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: Array.from(FORBIDDEN_SVG_TAGS),
      FORBID_ATTR: Array.from(FORBIDDEN_SVG_ATTRIBUTES),
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: true,
      RETURN_TRUSTED_TYPE: false,
    });
    const normalized = String(safe || "").trim().replace(
      /\s+([A-Za-z_:][\w:.-]*)="([^"]*)"/g,
      (attribute, _name, value) => {
        if (!/url\s*\(/i.test(value)) return attribute;
        return /^url\(\s*#[A-Za-z_][\w:.-]*\s*\)$/i.test(value.trim())
          ? attribute
          : "";
      }
    );

    if (!/^<svg(?:\s|>)/i.test(normalized)) return "";
    if (!/<\/svg>\s*$/i.test(normalized)) return "";
    return normalized;
  }

  /**
   * Restore extracted blocks after the surrounding Markdown has been sanitized.
   *
   * @param {string} html - Sanitized surrounding Markdown HTML.
   * @param {{blocks: Array<{token: string, markup: string}>}} extracted - Extracted SVG blocks.
   * @param {{sanitize: Function}} sanitizer - DOMPurify-compatible sanitizer.
   * @returns {string} HTML containing sanitized, responsive inline SVG graphics.
   */
  function restoreBlocks(html, extracted, sanitizer) {
    if (!extracted?.blocks?.length) return String(html || "");

    let output = String(html || "");
    for (const block of extracted.blocks) {
      const safeSvg = sanitizeBlock(block.markup, sanitizer);
      const rendered = safeSvg
        ? `<span class="cgo-inline-svg">${safeSvg}</span>`
        : "";
      const escapedToken = block.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      output = output
        .replace(new RegExp(`<p>\\s*${escapedToken}\\s*</p>`, "g"), () => rendered)
        .split(block.token)
        .join(rendered);
    }

    return output;
  }

  root.CGOSafeSvg = Object.freeze({
    extractBlocks,
    restoreBlocks,
    sanitizeBlock,
  });
})();
