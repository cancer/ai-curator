import { describe, expect, test } from "bun:test";
import { parseMediumFeed } from "./medium";

const authorText = await Bun.file(new URL("../../fixtures/medium_author_feed.xml", import.meta.url)).text();
const tagText = await Bun.file(new URL("../../fixtures/medium_tag_feed.xml", import.meta.url)).text();

describe("parseMediumFeed", () => {
  test("著者 feed: content:encoded から本文テキストを抽出する", () => {
    const articles = parseMediumFeed(authorText, "medium:@kentbeck_7670");
    expect(articles.length).toBeGreaterThan(0);
    const first = articles[0]!;
    expect(first.source).toBe("medium:@kentbeck_7670");
    expect(first.url).not.toContain("?source=");
    expect(Date.parse(first.publishedAt)).not.toBeNaN();
    expect(first.body).toBeDefined();
    expect(first.body!.length).toBeGreaterThan(500);
    expect(first.body!).not.toContain("<p>");
  });

  test("タグ feed: 本文なし、description から要約テキストを取る", () => {
    const articles = parseMediumFeed(tagText, "medium:tag/software-architecture");
    expect(articles.length).toBeGreaterThan(0);
    const first = articles[0]!;
    expect(first.body).toBeUndefined();
    expect(first.feedSummary).toBeDefined();
    expect(first.feedSummary!).not.toContain("<");
  });
});
