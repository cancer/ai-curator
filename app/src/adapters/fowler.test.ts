import { describe, it, expect } from "vitest";
import { parseFeed, extractArticleBody } from "./fowler";
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
