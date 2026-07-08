import { describe, it, expect } from "vitest";
import { htmlToText } from "./html";

// テストは @cloudflare/vitest-pool-workers により workerd 上で実行されるため、
// 実装が使う HTMLRewriter がテストでもそのまま利用できる。
// htmlToText は async（HTMLRewriter の transform が非同期）なので各ケースで await する。
describe("htmlToText", () => {
  it("extracts plain text and does not duplicate nested text", async () => {
    // ネストした <strong> により "world" は <p> と <strong> の 2 つの要素配下にある。
    // text 収集が要素ごとに二重発火していれば "worldworld" になるので、これがカナリア。
    const text = await htmlToText("<p>Hello <strong>world</strong></p>");
    expect(text).toBe("Hello world");
  });

  it("inserts a separator between adjacent block elements", async () => {
    const text = await htmlToText("<h1>A</h1><p>B</p>");
    expect(text).toBe("A B");
  });

  it("excludes a subtree via counter, not remove (nested text is not picked up by the text handler)", async () => {
    const html =
      "<div><p>keep</p><aside><p>secret</p></aside><p>keep too</p></div>";
    const text = await htmlToText(html, { exclude: ["aside"] });
    expect(text).toContain("keep");
    expect(text).toContain("keep too");
    expect(text).not.toContain("secret");
  });

  it("excludes multiple selectors' subtrees", async () => {
    const html =
      "<div><nav><p>menu</p></nav><p>body</p><footer><p>copyright</p></footer></div>";
    const text = await htmlToText(html, { exclude: ["nav", "footer"] });
    expect(text).toContain("body");
    expect(text).not.toContain("menu");
    expect(text).not.toContain("copyright");
  });

  it("collects only inside the root selector", async () => {
    const html =
      "<div><p>outside</p><main><p>inside</p></main><p>also outside</p></div>";
    const text = await htmlToText(html, { root: "main" });
    expect(text).toBe("inside");
  });

  it("combines root and exclude", async () => {
    const html =
      "<div><p>header</p><main><p>content</p><aside><p>sidebar</p></aside><p>more</p></main><p>footer</p></div>";
    const text = await htmlToText(html, { root: "main", exclude: ["aside"] });
    expect(text).toContain("content");
    expect(text).toContain("more");
    expect(text).not.toContain("header");
    expect(text).not.toContain("footer");
    expect(text).not.toContain("sidebar");
  });

  it("always excludes script and style", async () => {
    const html =
      "<div><script>var secret = 1;</script><p>visible</p><style>.x{color:red}</style></div>";
    const text = await htmlToText(html);
    expect(text).toBe("visible");
  });

  it("decodes named entities", async () => {
    const text = await htmlToText(
      "<p>Tom &amp; Jerry &mdash; a &ldquo;classic&rdquo; show &nbsp; here</p>",
    );
    expect(text).toBe(
      `Tom & Jerry — a “classic” show here`,
    );
  });

  it("decodes numeric entities (decimal and hex)", async () => {
    const text = await htmlToText("<p>Price: &#163;50 and &#x40;sign</p>");
    expect(text).toContain("Price: £50");
    expect(text).toContain("@sign");
  });

  it("normalizes whitespace and trims", async () => {
    const text = await htmlToText("<p>   Multiple   spaces   here   </p>");
    expect(text).toBe("Multiple spaces here");
  });
});
