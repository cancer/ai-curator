import { describe, expect, test } from "bun:test";
import { parseHnResponse } from "./hn";

const text = await Bun.file(new URL("../../fixtures/hn_search.json", import.meta.url)).text();

describe("parseHnResponse", () => {
  test("hits を正規化記事に変換する", () => {
    const articles = parseHnResponse(JSON.parse(text));
    expect(articles.length).toBeGreaterThan(0);
    const first = articles[0]!;
    expect(first.url).toStartWith("https://");
    expect(first.title.length).toBeGreaterThan(0);
    expect(first.source).toBe("hn");
    expect(Date.parse(first.publishedAt)).not.toBeNaN();
  });

  test("url を持たない self-post は HN パーマリンクにフォールバックする", () => {
    const articles = parseHnResponse({
      hits: [
        {
          objectID: "123",
          title: "Ask HN: something",
          url: null,
          story_text: "body text",
          created_at: "2026-07-01T00:00:00Z",
        },
      ],
    });
    expect(articles[0]!.url).toBe("https://news.ycombinator.com/item?id=123");
    expect(articles[0]!.feedSummary).toBe("body text");
  });
});
