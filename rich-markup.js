(() => {
  "use strict";

  const root = typeof globalThis !== "undefined" ? globalThis : window;

  const SUPPORTED_TAGS = new Set([
    "box",
    "row",
    "text",
    "title",
    "badge",
    "icon",
    "divider",
    "radio-group",
    "radio",
    "table",
    "table-row",
    "table-cell",
    "caption",
    "list",
    "list-item",
    "grid",
    "grid-item",
  ]);
  const VOID_TAGS = new Set(["icon", "divider"]);
  const INLINE_TEXT_PARENTS = new Set(["text", "title", "badge", "radio", "table-cell", "caption"]);
  const MAX_BLOCK_LENGTH = 100000;
  const MAX_NODES = 240;
  const MAX_DEPTH = 16;
  let renderedBlockSequence = 0;

  const ICONS = Object.freeze({
    "file-archive": `
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/>
      <path d="M14 2v6h6M9 13h6M10 17h4"/>`,
    "check-circle": `
      <circle cx="12" cy="12" r="9"/>
      <path d="m8.5 12 2.25 2.25L15.75 9"/>`,
    "circle-check": `
      <circle cx="12" cy="12" r="9"/>
      <path d="m8.5 12 2.25 2.25L15.75 9"/>`,
    download: `
      <path d="M12 3v12M7.5 10.5 12 15l4.5-4.5M5 21h14"/>`,
    file: `
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/>
      <path d="M14 2v6h6"/>`,
    info: `
      <circle cx="12" cy="12" r="9"/>
      <path d="M12 11v5M12 8h.01"/>`,
    "alert-triangle": `
      <path d="M10.3 3.7 2.5 17.2A2 2 0 0 0 4.2 20h15.6a2 2 0 0 0 1.7-2.8L13.7 3.7a2 2 0 0 0-3.4 0Z"/>
      <path d="M12 9v4M12 17h.01"/>`,
    "external-link": `
      <path d="M15 4h5v5M10 14 20 4M20 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h6"/>`,
    house: `
      <path d="m3 11 9-8 9 8"/>
      <path d="M5 10v10h14V10M9 20v-6h6v6"/>`,
    home: `
      <path d="m3 11 9-8 9 8"/>
      <path d="M5 10v10h14V10M9 20v-6h6v6"/>`,
    "car-front": `
      <path d="m5 11 1.4-4.2A2 2 0 0 1 8.3 5h7.4a2 2 0 0 1 1.9 1.8L19 11"/>
      <path d="M4 11h16v7H4zM6 18v2M18 18v2M7 14h.01M17 14h.01"/>`,
    "arrow-down": `
      <path d="M12 4v16M6 14l6 6 6-6"/>`,
  });

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function decodeQuotedValue(value) {
    return String(value || "").replace(/\\([\\"'nrt])/g, (_match, character) => {
      if (character === "n") return "\n";
      if (character === "r") return "\r";
      if (character === "t") return "\t";
      return character;
    });
  }

  function findDirectiveEnd(source, start) {
    let depth = 0;
    let quote = "";
    let escaped = false;

    for (let i = start; i < source.length; i += 1) {
      const character = source[i];
      if (quote) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === quote) {
          quote = "";
        }
        continue;
      }

      if (character === "\"" || character === "'" || character === "`") {
        quote = character;
        continue;
      }
      if (character === "{") depth += 1;
      if (character === "}") {
        depth -= 1;
        if (depth === 0) return i + 1;
      }
    }

    return -1;
  }

  function parseCollectionDeclaration(declaration, context) {
    const match = declaration.match(/^const\s+([a-zA-Z_$][\w$]*)\s*=\s*\[([\s\S]*)\]\s*;?$/);
    if (!match) return false;

    const items = [];
    const objectPattern = /\{([^{}]*)\}/g;
    let objectMatch;
    while ((objectMatch = objectPattern.exec(match[2])) && items.length < 50) {
      const item = Object.create(null);
      const fieldPattern = /([a-zA-Z_$][\w$]*)\s*:\s*(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)')/g;
      let fieldMatch;
      while ((fieldMatch = fieldPattern.exec(objectMatch[1]))) {
        item[fieldMatch[1]] = decodeQuotedValue(fieldMatch[2] ?? fieldMatch[3] ?? "");
      }
      if (Object.keys(item).length) items.push(item);
    }

    if (!items.length) return false;
    context.collections[match[1]] = items;
    return true;
  }

  function parseBodyDeclaration(declaration, context) {
    const stateMatch = declaration.match(
      /^const\s+\[\s*([a-zA-Z_$][\w$]*)\s*,\s*([a-zA-Z_$][\w$]*)\s*\]\s*=\s*(?:DIL\.)?useState\(\s*(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)')\s*\)\s*;?$/
    );
    if (stateMatch) {
      context.states[stateMatch[1]] = {
        value: decodeQuotedValue(stateMatch[3] ?? stateMatch[4] ?? ""),
        setter: stateMatch[2],
      };
      return true;
    }

    return parseCollectionDeclaration(declaration, context);
  }

  function extractBodyContext(source) {
    const input = String(source || "");
    const context = {
      states: Object.create(null),
      collections: Object.create(null),
    };
    let output = "";
    let cursor = 0;
    let searchIndex = 0;
    let matched = false;

    while (searchIndex < input.length) {
      const start = input.indexOf("{@body", searchIndex);
      if (start < 0) break;
      const end = findDirectiveEnd(input, start);
      if (end < 0) break;

      const declaration = input.slice(start + 6, end - 1).trim();
      if (parseBodyDeclaration(declaration, context)) {
        output += input.slice(cursor, start);
        output += "\n";
        cursor = end;
        matched = true;
      }
      searchIndex = end;
    }

    if (!matched) return { source: input, context };
    output += input.slice(cursor);
    return { source: output, context };
  }

  function interpolateEachItem(template, alias, item) {
    const aliasPattern = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let output = template.replace(
      new RegExp(`([a-zA-Z][\\w-]*)\\s*=\\s*\\{\\s*${aliasPattern}\\.([a-zA-Z_$][\\w$]*)\\s*\\}`, "g"),
      (_match, attributeName, propertyName) => `${attributeName}="${escapeHtml(item[propertyName] ?? "")}"`
    );
    output = output.replace(
      new RegExp(`\\{\\s*${aliasPattern}\\.([a-zA-Z_$][\\w$]*)\\s*\\}`, "g"),
      (_match, propertyName) => escapeHtml(item[propertyName] ?? "")
    );
    return output;
  }

  function expandEachDirectives(markup, context) {
    let output = String(markup || "");
    const pattern = /\{#each\s+([a-zA-Z_$][\w$]*)\s+as\s+([a-zA-Z_$][\w$]*)\s*\}([\s\S]*?)\{\/each\s*\}/g;

    for (let pass = 0; pass < 6; pass += 1) {
      let changed = false;
      output = output.replace(pattern, (whole, collectionName, alias, template) => {
        const collection = context.collections[collectionName];
        if (!Array.isArray(collection)) return whole;
        changed = true;
        return collection.map((item) => interpolateEachItem(template, alias, item)).join("");
      });
      if (!changed) break;
    }

    return output;
  }

  function tokenizeExpression(source) {
    const tokens = [];
    const input = String(source || "");
    let index = 0;

    while (index < input.length) {
      const character = input[index];
      if (/\s/.test(character)) {
        index += 1;
        continue;
      }
      if (input.startsWith("===", index)) {
        tokens.push({ type: "operator", value: "===" });
        index += 3;
        continue;
      }
      if (character === "?" || character === ":") {
        tokens.push({ type: "operator", value: character });
        index += 1;
        continue;
      }
      if (character === "\"" || character === "'") {
        const quote = character;
        let value = "";
        let closed = false;
        index += 1;
        while (index < input.length) {
          const current = input[index];
          if (current === "\\" && index + 1 < input.length) {
            value += decodeQuotedValue(input.slice(index, index + 2));
            index += 2;
            continue;
          }
          if (current === quote) {
            closed = true;
            index += 1;
            break;
          }
          value += current;
          index += 1;
        }
        if (!closed) return null;
        tokens.push({ type: "literal", value });
        continue;
      }

      const identifier = input.slice(index).match(/^[a-zA-Z_$][\w$]*/);
      if (!identifier) return null;
      tokens.push({ type: "identifier", value: identifier[0] });
      index += identifier[0].length;
    }

    return tokens;
  }

  function parseConditionalExpression(source) {
    const tokens = tokenizeExpression(source);
    if (!tokens?.length) return null;
    let index = 0;

    function parsePrimary() {
      const token = tokens[index];
      if (!token || (token.type !== "literal" && token.type !== "identifier")) return null;
      index += 1;
      return { type: token.type, value: token.value };
    }

    function parseEquality() {
      const left = parsePrimary();
      if (!left) return null;
      if (tokens[index]?.value !== "===") return left;
      index += 1;
      const right = parsePrimary();
      return right ? { type: "equality", left, right } : null;
    }

    function parseConditional() {
      const test = parseEquality();
      if (!test) return null;
      if (tokens[index]?.value !== "?") return test;
      index += 1;
      const consequent = parseConditional();
      if (!consequent || tokens[index]?.value !== ":") return null;
      index += 1;
      const alternate = parseConditional();
      return alternate ? { type: "conditional", test, consequent, alternate } : null;
    }

    const expression = parseConditional();
    return expression && index === tokens.length ? expression : null;
  }

  function evaluateExpression(node, values) {
    if (!node) return "";
    if (node.type === "literal") return node.value;
    if (node.type === "identifier") return values[node.value] ?? "";
    if (node.type === "equality") {
      return evaluateExpression(node.left, values) === evaluateExpression(node.right, values);
    }
    if (node.type === "conditional") {
      return evaluateExpression(node.test, values)
        ? evaluateExpression(node.consequent, values)
        : evaluateExpression(node.alternate, values);
    }
    return "";
  }

  function collectExpressionIdentifiers(node, output = new Set()) {
    if (!node) return output;
    if (node.type === "identifier") output.add(node.value);
    if (node.left) collectExpressionIdentifiers(node.left, output);
    if (node.right) collectExpressionIdentifiers(node.right, output);
    if (node.test) collectExpressionIdentifiers(node.test, output);
    if (node.consequent) collectExpressionIdentifiers(node.consequent, output);
    if (node.alternate) collectExpressionIdentifiers(node.alternate, output);
    return output;
  }

  function normalizeAttributeValue(value) {
    if (value === true) return true;
    return String(value ?? "").trim().toLowerCase();
  }

  function parseAttributes(rawTag, tagName) {
    const attrs = Object.create(null);
    const body = rawTag
      .replace(new RegExp(`^<\\s*${tagName}\\b`, "i"), "")
      .replace(/\/?>\s*$/, "");
    const attrPattern = /([a-zA-Z][\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^{}]*)\}|([^\s"'=<>`]+)))?/g;
    let match;

    while ((match = attrPattern.exec(body))) {
      const name = match[1].toLowerCase();
      const value = match[2] ?? match[3] ?? match[4] ?? match[5];
      attrs[name] = value === undefined ? true : value;
    }

    return attrs;
  }

  function appendText(parent, value) {
    if (!value) return;
    const previous = parent.children[parent.children.length - 1];
    if (previous?.type === "text") {
      previous.value += value;
      return;
    }
    parent.children.push({ type: "text", value });
  }

  function parseComponent(markup) {
    if (typeof markup !== "string" || !markup.trim() || markup.length > MAX_BLOCK_LENGTH) {
      return null;
    }

    const rootNode = { type: "root", children: [] };
    const stack = [rootNode];
    const tokenPattern = /<\/?(?:box|row|text|title|badge|icon|divider|radio-group|radio|table|table-row|table-cell|caption|list|list-item|grid|grid-item)\b[^<>]*>/gi;
    let cursor = 0;
    let nodeCount = 0;
    let match;

    while ((match = tokenPattern.exec(markup))) {
      appendText(stack[stack.length - 1], markup.slice(cursor, match.index));
      cursor = tokenPattern.lastIndex;

      const rawTag = match[0];
      const closing = /^<\s*\//.test(rawTag);
      const nameMatch = rawTag.match(/^<\s*\/?\s*([a-zA-Z][\w-]*)/);
      const tag = nameMatch?.[1]?.toLowerCase() || "";
      if (!SUPPORTED_TAGS.has(tag)) return null;

      if (closing) {
        if (stack.length === 1 || stack[stack.length - 1].tag !== tag) {
          return null;
        }
        stack.pop();
        continue;
      }

      nodeCount += 1;
      if (nodeCount > MAX_NODES || stack.length > MAX_DEPTH) return null;

      const node = {
        type: "element",
        tag,
        attrs: parseAttributes(rawTag, tag),
        children: [],
      };
      stack[stack.length - 1].children.push(node);

      const selfClosing = /\/\s*>$/.test(rawTag) || VOID_TAGS.has(tag);
      if (!selfClosing) stack.push(node);
    }

    appendText(stack[stack.length - 1], markup.slice(cursor));
    if (stack.length !== 1) return null;

    const meaningful = rootNode.children.filter(
      (node) => node.type !== "text" || node.value.trim()
    );
    if (meaningful.length !== 1 || meaningful[0].type !== "element") {
      return null;
    }

    return meaningful[0];
  }

  function parseBlock(markup) {
    const component = parseComponent(markup);
    return component?.tag === "box" ? component : null;
  }

  function getFencedCodeRanges(source) {
    const ranges = [];
    const lines = String(source || "").split("\n");
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

    if (open) ranges.push([open.start, String(source || "").length]);
    return ranges;
  }

  function isInsideRange(index, ranges) {
    return ranges.some(([start, end]) => index >= start && index <= end);
  }

  function findComponentEnd(source, start, tagName) {
    const escapedTag = String(tagName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const tokenPattern = new RegExp(`<\\/?${escapedTag}\\b[^<>]*>`, "gi");
    tokenPattern.lastIndex = start;
    let depth = 0;
    let match;

    while ((match = tokenPattern.exec(source))) {
      if (match.index === start && /^<\s*\//.test(match[0])) return -1;
      if (/^<\s*\//.test(match[0])) {
        depth -= 1;
        if (depth === 0) return tokenPattern.lastIndex;
        if (depth < 0) return -1;
      } else if (!/\/\s*>$/.test(match[0])) {
        depth += 1;
      }
    }

    return -1;
  }

  function extractBlocks(source) {
    const input = typeof source === "string" ? source : "";
    const body = extractBodyContext(input);
    const workingSource = body.source;
    const ranges = getFencedCodeRanges(workingSource);
    const openPattern = /<(box|caption|text|badge)(?:\s|>)/gi;
    const blocks = [];
    let output = "";
    let cursor = 0;
    let match;

    while ((match = openPattern.exec(workingSource))) {
      if (isInsideRange(match.index, ranges)) continue;

      const rootTag = String(match[1] || "").toLowerCase();
      const end = findComponentEnd(workingSource, match.index, rootTag);
      if (end < 0) continue;

      const markup = workingSource.slice(match.index, end);
      const expandedMarkup = expandEachDirectives(markup, body.context);
      const ast = parseComponent(expandedMarkup);
      if (!ast || ast.tag !== rootTag) continue;

      const token = `\uE110CGORICHBLOCK${blocks.length}\uE111`;
      output += workingSource.slice(cursor, match.index);
      const inline = rootTag === "text" || rootTag === "badge";
      output += inline ? token : `\n\n${token}\n\n`;
      blocks.push({ token, ast, markup, context: body.context, inline });
      cursor = end;
      openPattern.lastIndex = end;
    }

    if (!blocks.length) return { source: input, blocks: [] };
    output += workingSource.slice(cursor);
    return { source: output, blocks };
  }

  function addEnumClass(classes, prefix, value, allowed) {
    const normalized = normalizeAttributeValue(value);
    if (allowed.includes(normalized)) classes.push(`${prefix}-${normalized}`);
  }

  function addColorClass(classes, value) {
    addEnumClass(
      classes,
      "cgo-rich-color",
      value,
      ["primary", "secondary", "success", "warning", "danger", "subtle"]
    );
  }

  function renderIcon(node) {
    const requestedName = normalizeAttributeValue(node.attrs.name);
    const iconName = Object.hasOwn(ICONS, requestedName) ? requestedName : "file";
    const classes = ["cgo-rich-icon"];
    addEnumClass(classes, "cgo-rich-icon-size", node.attrs.size, ["xs", "sm", "md", "lg", "xl", "2xl"]);
    addColorClass(classes, node.attrs.color);
    if (node.attrs.inline === true || normalizeAttributeValue(node.attrs.inline) === "true") {
      classes.push("cgo-rich-icon-inline");
    }

    return `<span class="${classes.join(" ")}" aria-hidden="true" data-icon="${iconName}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[iconName]}</svg></span>`;
  }

  function getStateValues(context, stateName) {
    const values = [];
    const add = (value) => {
      const text = String(value ?? "");
      if (!values.includes(text)) values.push(text);
    };

    add(context.states[stateName]?.value ?? "");
    for (const collection of Object.values(context.collections || {})) {
      if (!Array.isArray(collection)) continue;
      for (const item of collection) {
        if (item && Object.hasOwn(item, "value")) add(item.value);
      }
    }

    return values.slice(0, 50);
  }

  function renderConditionalText(value, renderContext) {
    const match = String(value || "").trim().match(/^\{([\s\S]*)\}$/);
    if (!match) return "";

    const expression = parseConditionalExpression(match[1]);
    if (!expression) return "";
    const stateNames = [...collectExpressionIdentifiers(expression)]
      .filter((name) => Object.hasOwn(renderContext.context.states, name));
    if (stateNames.length !== 1) return "";

    const stateName = stateNames[0];
    const currentValue = String(renderContext.context.states[stateName]?.value ?? "");
    const stateValues = getStateValues(renderContext.context, stateName);
    if (!stateValues.length) return "";

    return stateValues.map((stateValue) => {
      const result = evaluateExpression(expression, { [stateName]: stateValue });
      const rendered = renderContext.renderMarkdown(String(result ?? ""), { inline: true });
      const hidden = stateValue === currentValue ? "" : " hidden";
      return `<span class="cgo-rich-expression-value" data-cgo-rich-state="${escapeHtml(stateName)}" data-cgo-rich-value="${escapeHtml(stateValue)}"${hidden}>${rendered}</span>`;
    }).join("");
  }

  function renderChildren(node, renderContext, parentTag = node.tag) {
    return node.children.map((child) => {
      if (child.type === "text") {
        if (!child.value.trim()) return "";

        if (parentTag === "table-cell") {
          const conditional = renderConditionalText(child.value, renderContext);
          if (conditional) return conditional;
        }

        const inline = INLINE_TEXT_PARENTS.has(parentTag);
        const rendered = renderContext.renderMarkdown(child.value, { inline });
        if (!rendered) return "";
        return inline ? rendered : `<div class="cgo-rich-content">${rendered}</div>`;
      }
      return renderNode(child, renderContext);
    }).join("");
  }

  function renderNode(node, renderContext) {
    if (!node || node.type !== "element") return "";

    if (node.tag === "icon") return renderIcon(node);
    if (node.tag === "divider") {
      const classes = ["cgo-rich-divider"];
      addColorClass(classes, node.attrs.color);
      return `<div class="${classes.join(" ")}" role="separator"></div>`;
    }

    if (node.tag === "radio-group") {
      const stateName = String(node.attrs.value || "").trim();
      const defaultValue = String(renderContext.context.states[stateName]?.value ?? "");
      const direction = normalizeAttributeValue(node.attrs.direction);
      const groupName = `${renderContext.blockId}-${stateName || "choice"}`;
      const childContext = {
        ...renderContext,
        radioGroup: { stateName, defaultValue, groupName },
      };
      const directionClass = direction === "row" ? "cgo-rich-direction-row" : "cgo-rich-direction-col";
      return `<div class="cgo-rich-radio-group ${directionClass}" role="radiogroup" data-cgo-rich-radio-group="${escapeHtml(stateName)}">${renderChildren(node, childContext)}</div>`;
    }

    if (node.tag === "radio") {
      const group = renderContext.radioGroup || {};
      const value = String(node.attrs.value ?? "");
      const checked = value === group.defaultValue ? " checked" : "";
      return `<label class="cgo-rich-radio"><input type="radio" name="${escapeHtml(group.groupName || renderContext.blockId)}" value="${escapeHtml(value)}" data-cgo-rich-state-input="${escapeHtml(group.stateName || "")}"${checked}><span>${renderChildren(node, renderContext)}</span></label>`;
    }

    if (node.tag === "table") {
      return `<div class="cgo-rich-table-wrap"><table class="cgo-rich-table"><tbody>${renderChildren(node, renderContext)}</tbody></table></div>`;
    }

    if (node.tag === "table-row") {
      return `<tr>${renderChildren(node, renderContext)}</tr>`;
    }

    if (node.tag === "table-cell") {
      return `<td>${renderChildren(node, renderContext)}</td>`;
    }

    if (node.tag === "caption") {
      return `<div class="cgo-rich-caption">${renderChildren(node, renderContext)}</div>`;
    }

    if (node.tag === "list") {
      const marker = normalizeAttributeValue(node.attrs.marker);
      const ordered = marker === "number";
      const classes = ["cgo-rich-list", ordered ? "cgo-rich-list-number" : "cgo-rich-list-bullet"];
      addEnumClass(classes, "cgo-rich-gap", node.attrs.gap, ["0", "1", "2", "3", "4", "5", "6"]);
      if (normalizeAttributeValue(node.attrs.connector) === "solid") {
        classes.push("cgo-rich-list-connector-solid");
      }
      return `<${ordered ? "ol" : "ul"} class="${classes.join(" ")}">${renderChildren(node, renderContext)}</${ordered ? "ol" : "ul"}>`;
    }

    if (node.tag === "list-item") {
      return `<li class="cgo-rich-list-item">${renderChildren(node, renderContext)}</li>`;
    }

    if (node.tag === "grid") {
      const classes = ["cgo-rich-grid"];
      addEnumClass(classes, "cgo-rich-grid-columns", node.attrs.columns, ["1", "2", "3", "4"]);
      addEnumClass(classes, "cgo-rich-gap", node.attrs.gap, ["0", "1", "2", "3", "4", "5", "6"]);
      return `<div class="${classes.join(" ")}">${renderChildren(node, renderContext)}</div>`;
    }

    if (node.tag === "grid-item") {
      return `<div class="cgo-rich-grid-item">${renderChildren(node, renderContext)}</div>`;
    }

    const classes = [`cgo-rich-${node.tag}`];
    addColorClass(classes, node.attrs.color);

    if (node.tag === "box") {
      const border = normalizeAttributeValue(node.attrs.border);
      if (border === true || border === "true" || border === "1") {
        classes.push("cgo-rich-has-border");
      }
      addEnumClass(classes, "cgo-rich-radius", node.attrs.radius, ["sm", "md", "lg", "xl"]);
      addEnumClass(classes, "cgo-rich-padding", node.attrs.padding, ["0", "1", "2", "3", "4", "5", "6"]);
      addEnumClass(classes, "cgo-rich-gap", node.attrs.gap, ["0", "1", "2", "3", "4", "5", "6"]);
      addEnumClass(classes, "cgo-rich-background", node.attrs.background, ["surface", "surface-secondary", "success", "warning", "danger"]);
      if (normalizeAttributeValue(node.attrs.flex) === "1") classes.push("cgo-rich-flex-1");
    }

    if (node.tag === "row") {
      addEnumClass(classes, "cgo-rich-gap", node.attrs.gap, ["0", "1", "2", "3", "4", "5", "6"]);
      addEnumClass(classes, "cgo-rich-align", node.attrs.align, ["start", "center", "end", "stretch"]);
      addEnumClass(classes, "cgo-rich-justify", node.attrs.justify, ["start", "center", "end", "between", "around"]);
    }

    if (node.tag === "text" || node.tag === "title") {
      addEnumClass(classes, "cgo-rich-text-size", node.attrs.size, ["xs", "sm", "md", "lg", "xl"]);
      addEnumClass(classes, "cgo-rich-weight", node.attrs.weight, ["normal", "medium", "semibold", "bold"]);
    }

    const inlineTag = node.tag === "text" || node.tag === "badge";
    return `<${inlineTag ? "span" : "div"} class="${classes.join(" ")}">${renderChildren(node, renderContext, node.tag)}</${inlineTag ? "span" : "div"}>`;
  }

  function renderBlock(ast, renderMarkdown, options = {}) {
    if (!ast || typeof renderMarkdown !== "function") return "";
    renderedBlockSequence += 1;
    const renderContext = {
      renderMarkdown,
      context: options.context || { states: Object.create(null), collections: Object.create(null) },
      blockId: `cgo-rich-${renderedBlockSequence}`,
      radioGroup: null,
    };
    const html = renderNode(ast, renderContext);
    if (!html) return "";
    return ast.tag === "box"
      ? `<div class="cgo-rich-block" data-cgo-rich-block="${renderContext.blockId}">${html}</div>`
      : html;
  }

  root.CGORichMarkup = Object.freeze({
    extractBlocks,
    parseBlock,
    renderBlock,
  });
})();
