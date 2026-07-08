import { describe, it, expect } from "vitest";
import { parseAuthorFeed, parseTagFeed } from "./medium";
import { mediumAuthorFeedXml } from "../../test/fixtures/medium-author-feed";
import { mediumTagFeedXml } from "../../test/fixtures/medium-tag-feed";

describe("parseAuthorFeed", () => {
  it("extracts body from content:encoded via htmlToText (text only)", async () => {
    const articles = await parseAuthorFeed(mediumAuthorFeedXml, "madeup");
    expect(articles[0].body).toBe(
      "Why My Pretend Cache Never Warms Up First fictional paragraph about warming strategies. Second fictional paragraph with a & ampersand and a <tag>.",
    );
  });

  it("sets source to medium:@author", async () => {
    const articles = await parseAuthorFeed(mediumAuthorFeedXml, "madeup");
    expect(articles[0].source).toBe("medium:@madeup");
  });

  it("converts RFC 2822 pubDate to ISO 8601", async () => {
    const articles = await parseAuthorFeed(mediumAuthorFeedXml, "madeup");
    expect(articles[0].publishedAt).toBe("2025-07-07T10:00:00.000Z");
  });

  it("normalizes url (strips ?source= tracking param)", async () => {
    const articles = await parseAuthorFeed(mediumAuthorFeedXml, "madeup");
    expect(articles[0].url).toBe(
      "https://medium.com/@madeup/pretend-cache-9f8e7d6c5b4a",
    );
  });

  it("maps description to feedSummary and parses all items", async () => {
    const articles = await parseAuthorFeed(mediumAuthorFeedXml, "madeup");
    expect(articles).toHaveLength(2);
    expect(articles[0].feedSummary).toContain("made-up summary");
  });
});

describe("parseTagFeed", () => {
  it("produces no body for tag feed items", () => {
    const articles = parseTagFeed(mediumTagFeedXml, "madeuptag");
    expect(articles[0].body).toBeUndefined();
  });

  it("sets source to medium:tag/{tag}", () => {
    const articles = parseTagFeed(mediumTagFeedXml, "madeuptag");
    expect(articles[0].source).toBe("medium:tag/madeuptag");
  });

  it("maps description to feedSummary, converts pubDate, and normalizes url", () => {
    const [article] = parseTagFeed(mediumTagFeedXml, "madeuptag");
    expect(article.feedSummary).toContain("fabricated snippet");
    expect(article.publishedAt).toBe("2025-07-06T18:45:00.000Z");
    expect(article.url).toBe("https://medium.com/@someone/fake-outage-aabbccdd");
  });
});
