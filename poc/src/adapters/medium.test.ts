import { describe, expect, test } from "bun:test";
import { loadFixture } from "../fixtures";
import { parseMediumFeed } from "./medium";

const author = await loadFixture(
  new URL("../../fixtures/medium_author_feed.xml", import.meta.url),
);
const tag = await loadFixture(
  new URL("../../fixtures/medium_tag_feed.xml", import.meta.url),
);

describe("parseMediumFeed", () => {
  test.skipIf(!author.exists)("著者 feed: content:encoded から本文テキストを抽出する", () => {
    const articles = parseMediumFeed(author.text, "medium:@kentbeck_7670");
    expect(articles.length).toBeGreaterThan(0);
    const first = articles[0]!;
    expect(first.source).toBe("medium:@kentbeck_7670");
    expect(first.url).not.toContain("?source=");
    expect(Date.parse(first.publishedAt)).not.toBeNaN();
    expect(first.body).toBeDefined();
    expect(first.body!.length).toBeGreaterThan(500);
    expect(first.body!).not.toContain("<p>");
  });

  test.skipIf(!tag.exists)("タグ feed: 本文なし、description から要約テキストを取る", () => {
    const articles = parseMediumFeed(tag.text, "medium:tag/software-architecture");
    expect(articles.length).toBeGreaterThan(0);
    const first = articles[0]!;
    expect(first.body).toBeUndefined();
    expect(first.feedSummary).toBeDefined();
    expect(first.feedSummary!).not.toContain("<");
  });
});
