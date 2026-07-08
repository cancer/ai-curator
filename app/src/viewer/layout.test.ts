import { describe, it, expect } from "vitest";
import { escapeHtml, page, htmlResponse } from "./layout";

describe("escapeHtml", () => {
  it("escapes all HTML-significant characters for text and attribute contexts", () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;",
    );
  });

  it("escapes & first so entities are not double-broken", () => {
    expect(escapeHtml("a & <b>")).toBe("a &amp; &lt;b&gt;");
  });

  it("leaves plain text unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

describe("page", () => {
  it("includes the mobile viewport meta tag", () => {
    const html = page("t", "<p>x</p>");
    expect(html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    );
  });

  it("escapes the title and embeds the body", () => {
    const html = page("<script>", "<p>body</p>");
    expect(html).toContain("<title>&lt;script&gt;</title>");
    expect(html).toContain("<p>body</p>");
  });
});

describe("htmlResponse", () => {
  it("sets html content type and default 200", async () => {
    const res = htmlResponse("<p>ok</p>");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe("<p>ok</p>");
  });

  it("honours a custom status", () => {
    expect(htmlResponse("<p>bad</p>", 400).status).toBe(400);
  });
});
