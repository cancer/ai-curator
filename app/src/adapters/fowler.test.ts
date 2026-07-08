import { describe, it, expect, vi } from "vitest";
import { parseFeed, extractArticleBody, fetchFowlerFeed, selectHref } from "./fowler";
import { fowlerFeedXml } from "../../test/fixtures/fowler-feed";
import {
  fowlerArticleHtml,
  fowlerArticleWithoutMain,
} from "../../test/fixtures/fowler-article";

describe("parseFeed", () => {
  it("parses every Atom entry", async () => {
    const articles = await parseFeed(fowlerFeedXml);
    expect(articles).toHaveLength(2);
  });

  it("selects the alternate link@href and normalizes it", async () => {
    const [first] = await parseFeed(fowlerFeedXml);
    expect(first.url).toBe(
      "https://martinfowler.com/articles/made-up-pattern.html",
    );
  });

  it("uses a single bare link@href when there is only one", async () => {
    const second = (await parseFeed(fowlerFeedXml))[1];
    expect(second.url).toBe(
      "https://martinfowler.com/articles/invented-refactoring.html",
    );
  });

  it("builds feedSummary from content via htmlToText, sets title/source/publishedAt", async () => {
    const [first] = await parseFeed(fowlerFeedXml);
    expect(first.title).toBe("The Made-Up Pattern Catalogue");
    expect(first.source).toBe("fowler");
    expect(first.publishedAt).toBe("2025-07-07T10:00:00.000Z");
    expect(first.feedSummary).toBe(
      "A fictional introduction to a pattern that does not exist.",
    );
  });

  it("does not set body in the feed parse step", async () => {
    const [first] = await parseFeed(fowlerFeedXml);
    expect(first.body).toBeUndefined();
  });

  it("keeps the full feedSummary without truncation (non-persistent, so no 300-char cap)", async () => {
    const longContent =
      '<content type="html">&lt;p&gt;' + "あ".repeat(1000) + "&lt;/p&gt;</content>";
    const xml =
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<feed xmlns="http://www.w3.org/2005/Atom">' +
      "<entry>" +
      "<title>Long entry</title>" +
      '<link href="https://martinfowler.com/articles/long.html"/>' +
      "<updated>2025-07-07T10:00:00Z</updated>" +
      longContent +
      "</entry>" +
      "</feed>";

    const [article] = await parseFeed(xml);
    // Old behaviour capped this at 300; it must now retain the full content.
    expect(article.feedSummary!.length).toBeGreaterThan(300);
  });
});

describe("selectHref", () => {
  it("throws an explicit error when the link list is empty", () => {
    expect(() => selectHref([])).toThrow("fowler: entry has no link");
  });

  it("prefers rel=alternate, falling back to the first link", () => {
    expect(
      selectHref([
        { "@_href": "https://example.com/self", "@_rel": "self" },
        { "@_href": "https://example.com/alt", "@_rel": "alternate" },
      ]),
    ).toBe("https://example.com/alt");
    expect(selectHref({ "@_href": "https://example.com/only" })).toBe(
      "https://example.com/only",
    );
  });
});

describe("extractArticleBody", () => {
  it("extracts only the body text from <main>, dropping excluded sections", async () => {
    const body = await extractArticleBody(fowlerArticleHtml);
    expect(body).toBe(
      "This is the first fabricated body paragraph of the article. This is the second fabricated body paragraph of the article.",
    );
  });

  it("throws when <main> is missing (site structure change detection)", async () => {
    await expect(extractArticleBody(fowlerArticleWithoutMain)).rejects.toThrow();
  });
});

describe("fetchFowlerFeed", () => {
  // フィクスチャの entry は 2025-07-07 更新。ウィンドウ下限をそれ以前に置いて全件通す。
  const WINDOW_ALL = new Date("2025-01-01T00:00:00.000Z");

  it("fetches only the feed (no per-article body fetch) and never sets body", async () => {
    const fetch = vi.fn(
      async (_url: RequestInfo | URL) =>
        new Response(fowlerFeedXml, { status: 200 }),
    );

    const articles = await fetchFowlerFeed(WINDOW_ALL, { fetch });

    // The feed is fetched exactly once; article pages are not fetched.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("https://martinfowler.com/feed.atom");
    expect(articles).toHaveLength(2);
    expect(articles[0].feedSummary).toBe(
      "A fictional introduction to a pattern that does not exist.",
    );
    for (const article of articles) {
      expect(article.body).toBeUndefined();
    }
  });

  it("keeps only entries within the day window", async () => {
    const fetch = vi.fn(
      async (_url: RequestInfo | URL) =>
        new Response(fowlerFeedXml, { status: 200 }),
    );

    // Window lower bound after both fixture entries (2025-07-07) -> none kept.
    const articles = await fetchFowlerFeed(
      new Date("2026-01-01T00:00:00.000Z"),
      { fetch },
    );
    expect(articles).toEqual([]);
  });

  it("returns [] on a non-ok feed response", async () => {
    // 4xx returns immediately from fetchWithRetry (no backoff sleeps).
    const fetch = vi.fn(async (_url: RequestInfo | URL) =>
      new Response("nope", { status: 404 }),
    );
    expect(await fetchFowlerFeed(WINDOW_ALL, { fetch })).toEqual([]);
  });
});
