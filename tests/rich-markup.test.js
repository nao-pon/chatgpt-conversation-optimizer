const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadRichMarkup() {
  const context = vm.createContext({ console });
  context.globalThis = context;
  const filePath = path.join(__dirname, "..", "rich-markup.js");
  vm.runInContext(fs.readFileSync(filePath, "utf8"), context, { filename: filePath });
  return context.CGORichMarkup;
}

function loadSafeSvg() {
  const context = vm.createContext({ console });
  context.globalThis = context;
  const filePath = path.join(__dirname, "..", "safe-svg.js");
  vm.runInContext(fs.readFileSync(filePath, "utf8"), context, { filename: filePath });
  return context.CGOSafeSvg;
}

const SAMPLE = `実装できました！

<box border radius="lg" padding={3} gap={2}>
<row align="center" gap={3}>
<icon name="file-archive" size="2xl" color="secondary"/>
<box flex="1" gap={1}>
**v0.2a17q 完全ソースZIP**
<text color="secondary" size="xs">Gateway・Tag・日本語README・テスト一式</text>
[ダウンロード](https://example.com/file.zip)
</box>
</row>
<divider color="subtle"/>
<row align="center" justify="between">
<text color="secondary" size="sm">ホスト回帰テスト</text>
<text color="success" weight="medium"><icon name="check-circle" inline/> 149件成功・2件スキップ</text>
</row>
</box>

## 変更した内容`;

test("extracts a balanced rich response block while preserving surrounding Markdown", () => {
  const rich = loadRichMarkup();
  const result = rich.extractBlocks(SAMPLE);

  assert.equal(result.blocks.length, 1);
  assert.match(result.source, /実装できました！/);
  assert.match(result.source, /CGORICHBLOCK0/);
  assert.match(result.source, /## 変更した内容/);
  assert.equal(result.blocks[0].ast.tag, "box");
});

test("renders supported layout attributes and resolves named icons locally", () => {
  const rich = loadRichMarkup();
  const result = rich.extractBlocks(SAMPLE);
  const html = rich.renderBlock(result.blocks[0].ast, (value, options) => {
    const text = String(value).trim();
    return options.inline ? text : `<p>${text}</p>`;
  });

  assert.match(html, /cgo-rich-has-border/);
  assert.equal((html.match(/cgo-rich-has-border/g) || []).length, 1);
  assert.match(html, /cgo-rich-radius-lg/);
  assert.match(html, /cgo-rich-padding-3/);
  assert.match(html, /cgo-rich-justify-between/);
  assert.match(html, /cgo-rich-color-success/);
  assert.match(html, /data-icon="file-archive"/);
  assert.match(html, /data-icon="check-circle"/);
  assert.match(html, /<svg viewBox="0 0 24 24"/);
});

test("does not interpret rich tags inside fenced code", () => {
  const rich = loadRichMarkup();
  const source = "```text\n<box border>literal</box>\n```";
  const result = rich.extractBlocks(source);

  assert.equal(result.blocks.length, 0);
  assert.equal(result.source, source);
});

test("leaves malformed blocks untouched", () => {
  const rich = loadRichMarkup();
  const source = "before\n<box border><row>broken</box>\nafter";
  const result = rich.extractBlocks(source);

  assert.equal(result.blocks.length, 0);
  assert.equal(result.source, source);
});

test("ignores untrusted icon attributes and falls back to a static glyph", () => {
  const rich = loadRichMarkup();
  const source = '<box><icon name="not-real" onload="alert(1)"/></box>';
  const result = rich.extractBlocks(source);
  const html = rich.renderBlock(result.blocks[0].ast, (value) => value);

  assert.match(html, /data-icon="file"/);
  assert.doesNotMatch(html, /onload|alert\(1\)/);
});

test("renders title and badge components inside a rich card", () => {
  const rich = loadRichMarkup();
  const source = `<box border radius="lg" padding={3} gap={2}>
<title size="md">3ボタン式（STOPがNC）の対応案</title>
<row align="center" justify="between">
<box><text weight="semibold">OPEN</text><badge color="secondary">NO</badge></box>
<text color="secondary">フォトカプラ</text>
</row>
</box>`;
  const result = rich.extractBlocks(source);
  const html = rich.renderBlock(result.blocks[0].ast, (value) => String(value).trim());

  assert.match(html, /cgo-rich-title/);
  assert.match(html, /cgo-rich-text-size-md/);
  assert.match(html, /cgo-rich-badge cgo-rich-color-secondary/);
  assert.match(html, />NO<\/span>/);
});

test("expands safe body collections and pre-renders interactive radio table values", () => {
  const rich = loadRichMarkup();
  const source = `{@body const [mode,setMode] = DIL.useState("3no")}
{@body const modes = [{value:"1no",label:"1ボタン式（NO）"},{value:"3no",label:"3ボタン式（すべてNO）"},{value:"3nc",label:"3ボタン式（STOPのみNC）"},{value:"custom",label:"機種専用設定"}]}
<box border radius="lg" padding={3} gap={2}>
<title>ゲート操作インターフェース</title>
<radio-group direction="col" value={mode} onChange={setMode}>
{#each modes as m}
<radio value={m.value}>{m.label}</radio>
{/each}
</radio-group>
<divider color="subtle"/>
<table>
<table-row><table-cell>OPEN</table-cell><table-cell>{mode === "1no" ? "共通ボタン" : mode === "custom" ? "機種別" : "NOパルス"}</table-cell></table-row>
<table-row><table-cell>STOP</table-cell><table-cell>{mode === "1no" ? "共通ボタン" : mode === "3nc" ? "NC開放" : mode === "custom" ? "機種別" : "NOパルス"}</table-cell></table-row>
</table>
<caption>将来のWeb UI構想です。</caption>
</box>`;
  const result = rich.extractBlocks(source);
  const block = result.blocks[0];
  const html = rich.renderBlock(
    block.ast,
    (value) => String(value).trim(),
    { context: block.context }
  );

  assert.equal(result.blocks.length, 1);
  assert.doesNotMatch(result.source, /\{@body|const modes/);
  assert.equal((html.match(/class="cgo-rich-radio"/g) || []).length, 4);
  assert.match(html, /value="3no"[^>]* checked/);
  assert.match(html, /class="cgo-rich-table"/);
  assert.match(html, /data-cgo-rich-state="mode"/);
  assert.match(html, /data-cgo-rich-value="3no">NOパルス<\/span>/);
  assert.match(html, /cgo-rich-caption/);
  assert.doesNotMatch(html, /\{#each|\{mode ===/);
});

test("renders numbered connected lists recursively inside a box", () => {
  const rich = loadRichMarkup();
  const source = `<box border radius="lg" padding={3} gap={2}>
<list marker="number" connector="solid" gap={2}>
<list-item>**基準RSSIを取得**\n\n最初の20秒間で基準を記録します。</list-item>
<list-item>**離脱直前のRSSIを計算**\n\n直近3サンプルの平均を計算します。</list-item>
<list-item>**基準値と比較**\n\n12dB以上弱くなっているか確認します。</list-item>
<list-item>**絶対的な電波強度を確認**\n\n−80dBm以下か確認します。</list-item>
</list>
</box>`;
  const result = rich.extractBlocks(source);
  const html = rich.renderBlock(result.blocks[0].ast, (value, options) => {
    const text = String(value).trim();
    return options.inline ? text : `<p>${text}</p>`;
  });

  assert.match(html, /<ol class="cgo-rich-list cgo-rich-list-number cgo-rich-gap-2 cgo-rich-list-connector-solid">/);
  assert.equal((html.match(/class="cgo-rich-list-item"/g) || []).length, 4);
  assert.doesNotMatch(html, /<list|&lt;list/);
});

test("renders responsive grids, nested surfaces, and the newer icon names", () => {
  const rich = loadRichMarkup();
  const source = `<box border radius="lg" padding={3} gap={3}>
<grid columns={2} gap={3}>
<grid-item><box gap={2}><row><icon name="house" color="success"/>**帰宅・駐車**</row><box background="surface-secondary" padding={3}><icon name="arrow-down"/></box></box></grid-item>
<grid-item><box gap={2}><row><icon name="car-front"/>**再出発**</row><box background="surface-secondary" padding={3}><icon name="arrow-down"/></box></box></grid-item>
</grid>
</box>`;
  const result = rich.extractBlocks(source);
  const html = rich.renderBlock(result.blocks[0].ast, (value) => String(value).trim());

  assert.match(html, /cgo-rich-grid-columns-2/);
  assert.equal((html.match(/class="cgo-rich-grid-item"/g) || []).length, 2);
  assert.match(html, /cgo-rich-background-surface-secondary/);
  assert.match(html, /data-icon="house"/);
  assert.match(html, /data-icon="car-front"/);
  assert.match(html, /data-icon="arrow-down"/);
});

test("extracts safe inline text and standalone captions outside boxes", () => {
  const rich = loadRichMarkup();
  const source = `| 値 | 意味 |\n|---|---|\n| confirmed | <text color="success" weight="medium">離脱傾向を確認</text> |\n\n<caption>その他の条件が正常な場合の例です。</caption>`;
  const result = rich.extractBlocks(source);
  const rendered = result.blocks.map((block) => rich.renderBlock(
    block.ast,
    (value) => String(value).trim(),
    { context: block.context }
  ));

  assert.equal(result.blocks.length, 2);
  assert.match(result.source, /\| confirmed \| .*CGORICHBLOCK0.* \|/);
  assert.match(rendered[0], /^<span class="cgo-rich-text/);
  assert.match(rendered[0], /cgo-rich-color-success/);
  assert.match(rendered[1], /^<div class="cgo-rich-caption">/);
});

test("preserves a complete SVG with text elements inside a box", () => {
  const rich = loadRichMarkup();
  const safeSvg = loadSafeSvg();
  const source = `<box gap={2}>
<svg viewBox="0 0 340 240" width="100%" xmlns="http://www.w3.org/2000/svg">
  <g fill="none" stroke="#16a2b5" strokeWidth="1.4" strokeDasharray="5 4">
    <path d="M175 37 L129 125 L241 154 Z"/>
  </g>
  <g fontSize="11" fontWeight="600">
    <text x="192" y="35">上面</text>
    <text x="126" y="233">パレット＋積荷</text>
  </g>
</svg>
<caption>概念図：上方と側方から計測する構成。</caption>
</box>`;
  const result = rich.extractBlocks(source);
  const svgNode = result.blocks[0].ast.children.find((child) => child.type === "svg");
  const sanitizer = { sanitize: (markup) => markup };
  const html = rich.renderBlock(result.blocks[0].ast, (value) => {
    const extracted = safeSvg.extractBlocks(value);
    if (!extracted.blocks.length) return String(value).trim();
    return safeSvg.restoreBlocks(
      `<p>${extracted.blocks[0].token}</p>`,
      extracted,
      sanitizer
    );
  });

  assert.ok(svgNode);
  assert.match(svgNode.markup, /<text x="192" y="35">上面<\/text>/);
  assert.equal((html.match(/<text\b/g) || []).length, 2);
  assert.match(html, /class="cgo-inline-svg"/);
  assert.match(html, /stroke-width="1.4"/);
  assert.match(html, /font-size="11"/);
  assert.match(html, /class="cgo-rich-caption"/);
  assert.doesNotMatch(html, /class="cgo-rich-text/);
});
