import { describe, it, expect } from "vitest";
import { parseFeed, resolveFeedBody, selectHref } from "./feed";

// すべて架空の合成データ（実在フィードのコピペではない）。形式だけ本物を模す。

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Fictional Feed</title>
    <item>
      <title>Made-up article about widgets</title>
      <link>https://blog.example/widgets?utm_source=rss</link>
      <pubDate>Tue, 08 Jul 2026 00:00:00 GMT</pubDate>
      <description>&lt;p&gt;A short snippet.&lt;/p&gt;</description>
      <content:encoded>&lt;p&gt;Full imaginary body about &lt;b&gt;widgets&lt;/b&gt;.&lt;/p&gt;</content:encoded>
    </item>
    <item>
      <title>Snippet-only article</title>
      <link>https://blog.example/snippet</link>
      <pubDate>Tue, 08 Jul 2026 01:00:00 GMT</pubDate>
      <description>&lt;p&gt;Only a snippet here.&lt;/p&gt;</description>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Fictional Atom</title>
  <entry>
    <title>Invented essay on design</title>
    <link rel="alternate" href="https://site.example/essay"/>
    <updated>2026-07-08T00:00:00Z</updated>
    <content>&lt;main&gt;&lt;p&gt;Imaginary essay body.&lt;/p&gt;&lt;/main&gt;</content>
  </entry>
</feed>`;

describe("parseFeed", () => {
  it("parses RSS: content:encoded -> body, description -> feedSummary, url normalized, source=feed:url", async () => {
    const articles = await parseFeed(RSS, "https://blog.example/feed");
    expect(articles).toHaveLength(2);

    const [a, b] = articles;
    expect(a.title).toBe("Made-up article about widgets");
    expect(a.source).toBe("feed:https://blog.example/feed");
    // utm_source が正規化で除去される。
    expect(a.url).toBe("https://blog.example/widgets");
    expect(a.publishedAt).toBe("2026-07-08T00:00:00.000Z");
    // content:encoded があれば body（プレーンテキスト化）。
    expect(a.body).toContain("Full imaginary body about widgets");
    expect(a.body).not.toContain("<b>");
    // feedSummary は本文優先（content:encoded）。
    expect(a.feedSummary).toContain("Full imaginary body about widgets");

    // content:encoded が無ければ body 無し・feedSummary は description。
    expect(b.body).toBeUndefined();
    expect(b.feedSummary).toBe("Only a snippet here.");
  });

  it("parses Atom: content -> body/feedSummary, alternate link selected, source=feed:url", async () => {
    const articles = await parseFeed(ATOM, "https://site.example/atom");
    expect(articles).toHaveLength(1);
    const a = articles[0];
    expect(a.title).toBe("Invented essay on design");
    expect(a.url).toBe("https://site.example/essay");
    expect(a.source).toBe("feed:https://site.example/atom");
    expect(a.body).toContain("Imaginary essay body.");
    expect(a.body).not.toContain("<main>");
  });

  it("throws on XML that is neither RSS nor Atom", () => {
    expect(() => parseFeed("<html></html>", "https://x/f")).toThrow(
      "neither RSS nor Atom",
    );
  });
});

describe("selectHref", () => {
  it("prefers rel=alternate, falls back to first link", () => {
    expect(
      selectHref([
        { "@_href": "https://x/self", "@_rel": "self" },
        { "@_href": "https://x/alt", "@_rel": "alternate" },
      ]),
    ).toBe("https://x/alt");
    expect(selectHref({ "@_href": "https://x/only" })).toBe("https://x/only");
  });

  it("throws when there is no link", () => {
    expect(() => selectHref(undefined)).toThrow("entry has no link");
  });
});

describe("resolveFeedBody", () => {
  it("returns in-memory inline body without fetching", async () => {
    const body = await resolveFeedBody(
      { url: "https://x/a", body: "INLINE", feedSummary: "snippet" },
      {
        fetch: async () => {
          throw new Error("should not fetch");
        },
      },
    );
    expect(body).toBe("INLINE");
  });

  it("falls back to feedSummary when no inline body", async () => {
    const body = await resolveFeedBody(
      { url: "https://x/a", feedSummary: "snippet" },
      {
        fetch: async () => {
          throw new Error("should not fetch");
        },
      },
    );
    expect(body).toBe("snippet");
  });

  it("fetches and crudely extracts the link when neither body nor feedSummary", async () => {
    const body = await resolveFeedBody(
      { url: "https://x/a" },
      {
        fetch: async () =>
          new Response("<html><body><p>Fetched text.</p></body></html>", {
            status: 200,
          }),
        sleep: async () => {},
      },
    );
    expect(body).toContain("Fetched text.");
  });

  it("prefers the main element when extracting a fetched article", async () => {
    const body = await resolveFeedBody(
      { url: "https://x/a" },
      {
        fetch: async () =>
          new Response(
            "<html><body><nav>Site menu</nav><main><p>Article body.</p></main><footer>Copyright</footer></body></html>",
            { status: 200 },
          ),
        sleep: async () => {},
      },
    );
    expect(body).toBe("Article body.");
  });

  it("returns null when the link fetch fails", async () => {
    const body = await resolveFeedBody(
      { url: "https://x/a" },
      {
        fetch: async () => new Response("nope", { status: 500 }),
        sleep: async () => {},
      },
    );
    expect(body).toBeNull();
  });
});
