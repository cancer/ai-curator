/**
 * Extract plain text from HTML.
 *
 * Uses a simple parser rather than HTMLRewriter to ensure compatibility
 * across all environments (browsers, Workers, tests).
 *
 * Features:
 * - root option: extract only from inside the specified element
 * - exclude option: skip specified elements and their subtrees
 * - script/style always excluded
 * - Block elements get spacing between them
 * - HTML entities are decoded
 */

export interface HtmlToTextOptions {
  /** Extract only from inside this element selector */
  root?: string;
  /** Exclude these element selectors and their subtrees */
  exclude?: string[];
}

// Block elements that should have spacing around them
const BLOCK_ELEMENTS = new Set([
  "p",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "blockquote",
  "pre",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "nav",
  "aside",
  "tr",
  "td",
  "th",
  "br",
]);

// HTML entities to decode
const ENTITY_MAP: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
  "&mdash;": String.fromCharCode(0x2014),
  "&ndash;": String.fromCharCode(0x2013),
  "&hellip;": String.fromCharCode(0x2026),
  "&lsquo;": String.fromCharCode(0x2018),
  "&rsquo;": String.fromCharCode(0x2019),
  "&ldquo;": String.fromCharCode(0x201c),
  "&rdquo;": String.fromCharCode(0x201d),
  "&lsaquo;": String.fromCharCode(0x2039),
  "&rsaquo;": String.fromCharCode(0x203a),
};

/**
 * Decode HTML entities in text.
 */
function decodeEntities(text: string): string {
  let result = text;

  // Replace named entities
  for (const [entity, char] of Object.entries(ENTITY_MAP)) {
    result = result.replaceAll(entity, char);
  }

  // Replace numeric entities: &#123; and &#x1F;
  result = result.replace(/&#(\d+);/g, (_match, code) => {
    return String.fromCharCode(parseInt(code, 10));
  });

  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_match, code) => {
    return String.fromCharCode(parseInt(code, 16));
  });

  return result;
}

/**
 * Normalize whitespace: collapse multiple spaces to one, trim.
 */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

interface ParserState {
  insideRoot: boolean;
  skipDepth: number;
  textParts: string[];
}

export function htmlToText(
  html: string,
  options?: HtmlToTextOptions,
): string {
  const rootSelector = options?.root;
  const excludeSelectors = new Set(options?.exclude ?? []);

  // Always exclude script and style
  excludeSelectors.add("script");
  excludeSelectors.add("style");

  const state: ParserState = {
    insideRoot: !rootSelector,
    skipDepth: 0,
    textParts: [],
  };

  // Simple HTML parser
  let i = 0;
  while (i < html.length) {
    // Find next tag
    const tagStart = html.indexOf("<", i);

    if (tagStart === -1) {
      // No more tags - add remaining text
      if (state.insideRoot && state.skipDepth === 0) {
        const text = html.substring(i);
        if (text.trim()) {
          state.textParts.push(text);
        }
      }
      break;
    }

    // Add text before this tag
    if (tagStart > i && state.insideRoot && state.skipDepth === 0) {
      const text = html.substring(i, tagStart);
      if (text.trim()) {
        state.textParts.push(text);
      }
    }

    // Find tag end
    const tagEnd = html.indexOf(">", tagStart);
    if (tagEnd === -1) break;

    const tagContent = html.substring(tagStart + 1, tagEnd).trim();

    // Skip comments, doctypes, XML declarations
    if (tagContent.startsWith("!") || tagContent.startsWith("?")) {
      i = tagEnd + 1;
      continue;
    }

    // Extract tag name (handle attributes and namespaces)
    const tagNameMatch = tagContent.match(/^\/?\w+/);
    if (!tagNameMatch) {
      i = tagEnd + 1;
      continue;
    }

    let tagName = tagNameMatch[0];
    const isClosing = tagName.startsWith("/");
    if (isClosing) {
      tagName = tagName.substring(1);
    }
    tagName = tagName.toLowerCase();

    if (!isClosing) {
      // Opening tag
      // Check if this is the root element
      if (rootSelector && tagName === rootSelector && !state.insideRoot) {
        state.insideRoot = true;
      }

      // Check if we should skip this element
      if (excludeSelectors.has(tagName)) {
        state.skipDepth++;
      }

      // Add spacing for block elements
      if (state.insideRoot && state.skipDepth === 0 && BLOCK_ELEMENTS.has(tagName)) {
        state.textParts.push(" ");
      }
    } else {
      // Closing tag
      // Check if we're exiting root
      if (rootSelector && tagName === rootSelector) {
        state.insideRoot = false;
      }

      // Check if we're exiting skip
      if (excludeSelectors.has(tagName) && state.skipDepth > 0) {
        state.skipDepth--;
      }

      // Add spacing after block elements
      if (state.insideRoot && state.skipDepth === 0 && BLOCK_ELEMENTS.has(tagName)) {
        state.textParts.push(" ");
      }
    }

    i = tagEnd + 1;
  }

  // Join and process text
  let result = state.textParts.join("");

  // Decode entities
  result = decodeEntities(result);

  // Normalize whitespace
  result = normalizeWhitespace(result);

  return result;
}
