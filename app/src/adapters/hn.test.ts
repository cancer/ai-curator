import { describe, it, expect, vi } from "vitest";
import { parseStories, fetchStories, fetchArticleBody, type HnHit } from "./hn";
import { hnSearchRaw } from "../../test/fixtures/hn-search";

describe("parseStories", () => {
  it("keeps the external url for link posts", async () => {
    const [first] = await parseStories(hnSearchRaw);
    expect(first.url).toBe("https://example.invalid/blog/imaginary-1-0");
  });

  it("falls back to the item?id url for self-posts (url null)", async () => {
    const articles = await parseStories(hnSearchRaw);
    const selfPost = articles[1];
    expect(selfPost.url).toBe("https://news.ycombinator.com/item?id=48000002");
  });

  it("puts story_text (plain-text via htmlToText) into feedSummary when present", async () => {
    const selfPost = (await parseStories(hnSearchRaw))[1];
    expect(selfPost.feedSummary).toBe(
      "I maintain a made-up widget library and wonder about testing.",
    );
  });

  it("strips HTML from story_text before putting it in feedSummary", async () => {
    const withHtml = {
      hits: [
        {
          objectID: "1",
          title: "self post with html",
          url: null,
          points: 10,
          created_at: "2025-07-07T11:00:00.000Z",
          story_text: "<p>Hello <b>world</b></p>",
        },
      ],
    };
    const [article] = await parseStories(withHtml);
    expect(article.feedSummary).toBe("Hello world");
  });

  it("leaves feedSummary undefined when story_text is absent", async () => {
    const [first] = await parseStories(hnSearchRaw);
    expect(first.feedSummary).toBeUndefined();
  });

  it("sets source to hn, maps title/publishedAt, and never sets body", async () => {
    const [first] = await parseStories(hnSearchRaw);
    expect(first.source).toBe("hn");
    expect(first.title).toBe("Imaginary framework hits 1.0");
    expect(first.publishedAt).toBe("2025-07-07T11:00:00.000Z");
    expect(first.body).toBeUndefined();
  });
});

describe("fetchStories — pagination and window filter", () => {
  const WINDOW = new Date("2026-07-08T00:00:00.000Z");

  function hit(id: string): HnHit {
    return {
      objectID: id,
      title: `story ${id}`,
      url: `https://example.invalid/${id}`,
      points: 100,
      created_at: "2026-07-08T12:00:00.000Z",
    };
  }

  it("pages through nbPages and puts the window lower bound in the query", async () => {
    const responses = [
      { hits: [hit("1")], nbPages: 2 },
      { hits: [hit("2")], nbPages: 2 },
    ];
    let call = 0;
    const captured: string[] = [];
    const fetch = vi.fn(async (url: RequestInfo | URL) => {
      captured.push(String(url));
      return new Response(JSON.stringify(responses[call++]), { status: 200 });
    });

    const articles = await fetchStories(50, WINDOW, { fetch });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(articles).toHaveLength(2);
    // created_at_i>{epoch} is URL-encoded (">" -> "%3E") inside numericFilters.
    const epoch = Math.floor(WINDOW.getTime() / 1000);
    expect(captured[0]).toContain(`created_at_i%3E${epoch}`);
    // page index advances.
    expect(captured[0]).toContain("page=0");
    expect(captured[1]).toContain("page=1");
  });

  it("stops after a single page when nbPages is 1", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ hits: [hit("1")], nbPages: 1 }), {
          status: 200,
        }),
    );
    await fetchStories(50, WINDOW, { fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("skips the source (returns []) on a non-ok response", async () => {
    const fetch = vi.fn(async () => new Response("nope", { status: 500 }));
    const sleep = async () => {};
    expect(await fetchStories(50, WINDOW, { fetch, sleep })).toEqual([]);
  });
});

describe("fetchArticleBody — link body extraction with fallback", () => {
  function htmlResponse(html: string): Response {
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  it("extracts plain text from an html page above the min length", async () => {
    const html = "<html><body><p>" + "word ".repeat(100) + "</p></body></html>";
    const fetch = vi.fn(async () => htmlResponse(html));

    const body = await fetchArticleBody("https://example.invalid/a", { fetch });

    expect(body.length).toBeGreaterThanOrEqual(200);
    expect(body).toContain("word");
  });

  it("returns empty string on a non-ok response", async () => {
    const fetch = vi.fn(async () => new Response("x", { status: 404 }));
    expect(await fetchArticleBody("u", { fetch })).toBe("");
  });

  it("returns empty string for a non-html content type", async () => {
    const fetch = vi.fn(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    expect(await fetchArticleBody("u", { fetch })).toBe("");
  });

  it("returns empty string for an extremely short body (bot-block/paywall stub)", async () => {
    const fetch = vi.fn(async () =>
      htmlResponse("<html><body><p>Just a moment...</p></body></html>"),
    );
    expect(await fetchArticleBody("u", { fetch })).toBe("");
  });

  it("returns empty string when the fetch fails (network exhaustion)", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("network down");
    });
    const sleep = async () => {};
    expect(await fetchArticleBody("u", { fetch, sleep })).toBe("");
  });
});
