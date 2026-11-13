const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadSafeSvg() {
  const context = vm.createContext({ console });
  context.globalThis = context;
  const filePath = path.join(__dirname, "..", "safe-svg.js");
  vm.runInContext(fs.readFileSync(filePath, "utf8"), context, {
    filename: filePath,
  });
  return context.CGOSafeSvg;
}

test("extracts complete SVG graphics while preserving surrounding Markdown", () => {
  const safeSvg = loadSafeSvg();
  const source = `Before

<svg viewBox="0 0 100 40" aria-label="Example">
  <rect width="100" height="40" fill="#2563eb"/>
  <text x="50" y="24" text-anchor="middle">SVG</text>
</svg>

After`;
  const result = safeSvg.extractBlocks(source);

  assert.equal(result.blocks.length, 1);
  assert.match(result.source, /Before/);
  assert.match(result.source, /CGOSVGBLOCK0/);
  assert.match(result.source, /After/);
  assert.match(result.blocks[0].markup, /^<svg[\s\S]*<rect/);
});

test("does not render SVG markup inside fenced or inline code", () => {
  const safeSvg = loadSafeSvg();
  const fenced = "```svg\n<svg><circle r=\"4\"/></svg>\n```";
  const inline = "Use `<svg><circle r=\"4\"/></svg>` literally.";

  const fencedResult = safeSvg.extractBlocks(fenced);
  const inlineResult = safeSvg.extractBlocks(inline);

  assert.equal(fencedResult.blocks.length, 0);
  assert.equal(fencedResult.source, fenced);
  assert.equal(inlineResult.blocks.length, 0);
  assert.equal(inlineResult.source, inline);
});

test("restores only sanitizer-approved SVG with the restrictive SVG profile", () => {
  const safeSvg = loadSafeSvg();
  const extracted = safeSvg.extractBlocks(
    '<svg onload="alert(1)"><script>alert(2)</script><path d="M0 0h10v10z"/></svg>'
  );
  let receivedOptions;
  const sanitizer = {
    sanitize(_markup, options) {
      receivedOptions = options;
      return '<svg><path d="M0 0h10v10z"></path></svg>';
    },
  };
  const html = safeSvg.restoreBlocks(
    `<p>${extracted.blocks[0].token}</p>`,
    extracted,
    sanitizer
  );

  assert.match(html, /^<span class="cgo-inline-svg"><svg>/);
  assert.doesNotMatch(html, /script|onload|alert/);
  assert.equal(receivedOptions.USE_PROFILES.svg, true);
  assert.equal(receivedOptions.USE_PROFILES.svgFilters, true);
  assert.ok(receivedOptions.FORBID_TAGS.includes("foreignObject"));
  assert.ok(receivedOptions.FORBID_TAGS.includes("script"));
  assert.ok(receivedOptions.FORBID_ATTR.includes("href"));
  assert.ok(receivedOptions.FORBID_ATTR.includes("style"));
});

test("removes external paint URLs while preserving local SVG fragment references", () => {
  const safeSvg = loadSafeSvg();
  const sanitizer = {
    sanitize() {
      return '<svg><path fill="url(https://example.com/paint.svg)" filter="url(#shadow)" d="M0 0h1v1z"></path></svg>';
    },
  };

  const html = safeSvg.sanitizeBlock("<svg></svg>", sanitizer);

  assert.doesNotMatch(html, /https:\/\//);
  assert.match(html, /filter="url\(#shadow\)"/);
});

test("drops a block when sanitization does not return an SVG root", () => {
  const safeSvg = loadSafeSvg();
  const extracted = safeSvg.extractBlocks("<svg><path/></svg>");
  const sanitizer = { sanitize: () => "<p>not svg</p>" };

  assert.equal(
    safeSvg.restoreBlocks(extracted.blocks[0].token, extracted, sanitizer),
    ""
  );
});
