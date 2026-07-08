import { describe, it, expect } from "vitest";
import { htmlToText } from "./html";

describe("htmlToText", () => {
  it("extracts plain text from simple HTML", () => {
    const html = "<p>Hello <strong>world</strong></p>";
    const text = htmlToText(html);
    expect(text).toBe("Hello world");
  });

  it("removes script and style elements by default", () => {
    const html =
      "<div><script>console.log('hidden')</script><p>Visible</p><style>.hidden { display: none; }</style></div>";
    const text = htmlToText(html);
    expect(text).not.toContain("hidden");
    expect(text).not.toContain("console");
    expect(text).toContain("Visible");
  });

  it("respects root option - extracts only from specified element", () => {
    const html =
      "<div><p>Outside</p><main><p>Inside</p></main><p>Also outside</p></div>";
    const text = htmlToText(html, { root: "main" });
    expect(text).toContain("Inside");
    expect(text).not.toContain("Outside");
    expect(text).not.toContain("Also outside");
  });

  it("respects exclude option - skips specified elements", () => {
    const html =
      "<div><p>Keep this</p><aside><p>Skip this</p></aside><p>Keep this too</p></div>";
    const text = htmlToText(html, { exclude: ["aside"] });
    expect(text).toContain("Keep this");
    expect(text).not.toContain("Skip this");
    expect(text).toContain("Keep this too");
  });

  it("adds spacing between block elements", () => {
    const html = "<p>Paragraph 1</p><p>Paragraph 2</p>";
    const text = htmlToText(html);
    // Should have spaces between paragraphs
    expect(text).toMatch(/Paragraph\s+1\s+Paragraph\s+2/);
  });

  it("decodes HTML entities", () => {
    const html = "<p>Tom &amp; Jerry &mdash; classic &nbsp; show</p>";
    const text = htmlToText(html);
    // nbsp decodes to space, then normalized with adjacent spaces
    expect(text).toContain("Tom & Jerry — classic show");
  });

  it("decodes numeric entities", () => {
    const html = "<p>Price: &#163;50 (hex: &#x1F;)</p>";
    const text = htmlToText(html);
    expect(text).toContain("Price: £50");
  });

  it("normalizes whitespace - collapses multiple spaces", () => {
    const html = "<p>Multiple   spaces   between   words</p>";
    const text = htmlToText(html);
    expect(text).toBe("Multiple spaces between words");
  });

  it("trims leading and trailing whitespace", () => {
    const html = "<p>   Surrounded by spaces   </p>";
    const text = htmlToText(html);
    expect(text).toBe("Surrounded by spaces");
  });

  it("handles nested block elements with exclude", () => {
    const html =
      "<article><p>Start</p><aside><div><p>Nested skip</p></div></aside><p>End</p></article>";
    const text = htmlToText(html, { exclude: ["aside"] });
    expect(text).toContain("Start");
    expect(text).toContain("End");
    expect(text).not.toContain("Nested skip");
  });

  it("handles complex real-world HTML", () => {
    const html = `
      <article>
        <h1>Article Title</h1>
        <p>First paragraph with <strong>bold</strong> text.</p>
        <script>var x = 1;</script>
        <p>Second paragraph.</p>
        <aside><p>This is sidebar content</p></aside>
        <p>Third paragraph with &mdash; em dash.</p>
      </article>
    `;
    const text = htmlToText(html, { exclude: ["aside"] });
    expect(text).toContain("Article Title");
    expect(text).toContain("First paragraph with bold text");
    expect(text).toContain("Second paragraph");
    expect(text).toContain("Third paragraph with — em dash");
    expect(text).not.toContain("sidebar");
    expect(text).not.toContain("var x");
  });

  it("handles table elements as block elements", () => {
    const html = "<p>Before table</p><table><tr><td>Cell</td></tr></table><p>After table</p>";
    const text = htmlToText(html);
    expect(text).toContain("Before table");
    expect(text).toContain("Cell");
    expect(text).toContain("After table");
  });

  it("handles list elements with spacing", () => {
    const html = "<ul><li>Item 1</li><li>Item 2</li><li>Item 3</li></ul>";
    const text = htmlToText(html);
    expect(text).toContain("Item 1");
    expect(text).toContain("Item 2");
    expect(text).toContain("Item 3");
  });

  it("combines root and exclude options", () => {
    const html = `
      <div class="header">Header text</div>
      <main>
        <p>Article content</p>
        <aside>Sidebar</aside>
        <p>More content</p>
      </main>
      <div class="footer">Footer text</div>
    `;
    const text = htmlToText(html, { root: "main", exclude: ["aside"] });
    expect(text).toContain("Article content");
    expect(text).toContain("More content");
    expect(text).not.toContain("Header text");
    expect(text).not.toContain("Footer text");
    expect(text).not.toContain("Sidebar");
  });

  it("handles many HTML entities", () => {
    const html =
      "<p>&lt; &gt; &quot; &apos; &lsquo; &rsquo; &ldquo; &rdquo; &lsaquo; &rsaquo;</p>";
    const text = htmlToText(html);
    // Check that all entities were decoded correctly
    expect(text).toContain("<");
    expect(text).toContain(">");
    expect(text).toContain('"');
    expect(text).toContain("'");
    expect(text).toContain(String.fromCharCode(0x2018)); // left single quotation mark
    expect(text).toContain(String.fromCharCode(0x2019)); // right single quotation mark
    expect(text).toContain(String.fromCharCode(0x201c)); // left double quotation mark
    expect(text).toContain(String.fromCharCode(0x201d)); // right double quotation mark
    expect(text).toContain(String.fromCharCode(0x2039)); // single left-pointing angle quotation mark
    expect(text).toContain(String.fromCharCode(0x203a)); // single right-pointing angle quotation mark
  });
});
