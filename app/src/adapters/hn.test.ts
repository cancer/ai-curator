import { describe, it, expect } from "vitest";
import { parseStories } from "./hn";
import { hnSearchRaw } from "../../test/fixtures/hn-search";

describe("parseStories", () => {
  it("keeps the external url for link posts", () => {
    const [first] = parseStories(hnSearchRaw);
    expect(first.url).toBe("https://example.invalid/blog/imaginary-1-0");
  });

  it("falls back to the item?id url for self-posts (url null)", () => {
    const articles = parseStories(hnSearchRaw);
    const selfPost = articles[1];
    expect(selfPost.url).toBe("https://news.ycombinator.com/item?id=48000002");
  });

  it("puts story_text into feedSummary when present", () => {
    const selfPost = parseStories(hnSearchRaw)[1];
    expect(selfPost.feedSummary).toBe(
      "I maintain a made-up widget library and wonder about testing.",
    );
  });

  it("leaves feedSummary undefined when story_text is absent", () => {
    const [first] = parseStories(hnSearchRaw);
    expect(first.feedSummary).toBeUndefined();
  });

  it("sets source to hn, maps title/publishedAt, and never sets body", () => {
    const [first] = parseStories(hnSearchRaw);
    expect(first.source).toBe("hn");
    expect(first.title).toBe("Imaginary framework hits 1.0");
    expect(first.publishedAt).toBe("2025-07-07T11:00:00.000Z");
    expect(first.body).toBeUndefined();
  });
});
