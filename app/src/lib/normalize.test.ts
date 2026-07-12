import { describe, it, expect } from "vitest";
import { normalizeUrl } from "./normalize";

describe("normalizeUrl", () => {
  it("throws on invalid URL", () => {
    expect(() => normalizeUrl("not a url")).toThrow();
    expect(() => normalizeUrl("://invalid")).toThrow();
  });

  it("throws on non-http(s) schemes (javascript:, data:)", () => {
    expect(() => normalizeUrl("javascript:alert(1)")).toThrow();
    expect(() => normalizeUrl("data:text/html,<script>alert(1)</script>")).toThrow();
    expect(() => normalizeUrl("ftp://example.com/file")).toThrow();
  });

  it("accepts http and https URLs", () => {
    expect(normalizeUrl("http://example.com/a")).toBe("http://example.com/a");
    expect(normalizeUrl("https://example.com/a")).toBe("https://example.com/a");
  });

  it("removes utm_* parameters", () => {
    const url = "https://example.com/article?id=123&utm_source=twitter&utm_medium=social&utm_campaign=week1";
    const normalized = normalizeUrl(url);
    expect(normalized).toBe("https://example.com/article?id=123");
  });

  it("removes tracking parameters (source, ref, fbclid, gclid)", () => {
    const url = "https://example.com/article?id=123&source=newsletter&ref=blog&fbclid=abc&gclid=xyz";
    const normalized = normalizeUrl(url);
    expect(normalized).toBe("https://example.com/article?id=123");
  });

  it("removes fragments", () => {
    const url = "https://example.com/article?id=123#section-two";
    const normalized = normalizeUrl(url);
    expect(normalized).toBe("https://example.com/article?id=123");
  });

  it("preserves HN item?id parameter", () => {
    const url = "https://news.ycombinator.com/item?id=12345&utm_source=twitter";
    const normalized = normalizeUrl(url);
    expect(normalized).toBe("https://news.ycombinator.com/item?id=12345");
  });

  it("preserves other query parameters", () => {
    const url = "https://example.com/search?q=test&lang=en&utm_source=google";
    const normalized = normalizeUrl(url);
    expect(normalized).toBe("https://example.com/search?q=test&lang=en");
  });

  it("handles URL with no query params or fragments", () => {
    const url = "https://example.com/article";
    const normalized = normalizeUrl(url);
    expect(normalized).toBe("https://example.com/article");
  });

  it("is idempotent", () => {
    const url = "https://example.com/article?id=123&utm_source=twitter#section";
    const normalized1 = normalizeUrl(url);
    const normalized2 = normalizeUrl(normalized1);
    expect(normalized1).toBe(normalized2);
  });
});
