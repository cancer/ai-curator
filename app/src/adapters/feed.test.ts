import { describe, it, expect } from "vitest";
import {
  deriveMediumFeedUrl,
  parseFeed,
  resolveArticleBody,
  selectHref,
} from "./feed";
import type { NormalizedArticle } from "./types";

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

describe("deriveMediumFeedUrl", () => {
  it("derives the author feed for medium.com/@handle/...", () => {
    expect(
      deriveMediumFeedUrl("https://medium.com/@alice/some-post-abc123"),
    ).toBe("https://medium.com/feed/@alice");
  });

  it("derives the publication feed for medium.com/{pub}/...", () => {
    expect(
      deriveMediumFeedUrl("https://medium.com/some-pub/some-post-abc123"),
    ).toBe("https://medium.com/feed/some-pub");
  });

  it("derives the subdomain feed for {sub}.medium.com/...", () => {
    expect(deriveMediumFeedUrl("https://custom.medium.com/some-post")).toBe(
      "https://custom.medium.com/feed",
    );
  });

  it("returns null for non-Medium URLs", () => {
    expect(deriveMediumFeedUrl("https://example.com/@alice/post")).toBeNull();
  });

  it("treats www.medium.com like medium.com (www is not a source subdomain)", () => {
    expect(deriveMediumFeedUrl("https://www.medium.com/@bob/post-xyz")).toBe(
      "https://medium.com/feed/@bob",
    );
  });

  it("ignores the query string when deriving the feed", () => {
    expect(
      deriveMediumFeedUrl("https://medium.com/@alice/post-xyz?source=rss"),
    ).toBe("https://medium.com/feed/@alice");
  });

  it("returns null when medium.com has no path segment", () => {
    expect(deriveMediumFeedUrl("https://medium.com/")).toBeNull();
  });

  it("returns null for an unparseable URL", () => {
    expect(deriveMediumFeedUrl("not a url")).toBeNull();
  });
});

describe("resolveArticleBody", () => {
  it("returns in-memory inline body without fetching", async () => {
    const body = await resolveArticleBody(
      { url: "https://x/a", body: "INLINE", feedSummary: "snippet" },
      {
        fetch: async () => {
          throw new Error("should not fetch");
        },
      },
    );
    expect(body).toBe("INLINE");
  });

  it("does not short-circuit on feedSummary; proceeds to fetch the real body", async () => {
    // feedSummary スニペットは実本文ではないので解決チェーンに入れない。
    const body = await resolveArticleBody(
      { url: "https://x/a", feedSummary: "snippet" },
      {
        fetch: async () =>
          new Response(
            "<html><body><main><p>Real fetched body.</p></main></body></html>",
            { status: 200 },
          ),
        sleep: async () => {},
      },
    );
    expect(body).toBe("Real fetched body.");
  });

  it("returns null when the real body cannot be resolved, even if feedSummary exists", async () => {
    const body = await resolveArticleBody(
      { url: "https://x/a", feedSummary: "snippet" },
      {
        fetch: async () => new Response("nope", { status: 500 }),
        sleep: async () => {},
      },
    );
    expect(body).toBeNull();
  });

  it("fetches and crudely extracts the link when neither body nor feedSummary", async () => {
    const body = await resolveArticleBody(
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
    const body = await resolveArticleBody(
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

  it("falls back to the article element when there is no main", async () => {
    const body = await resolveArticleBody(
      { url: "https://x/a" },
      {
        fetch: async () =>
          new Response(
            "<html><body><nav>Menu</nav><article><p>The real article text.</p></article><footer>Foot</footer></body></html>",
            { status: 200 },
          ),
        sleep: async () => {},
      },
    );
    expect(body).toBe("The real article text.");
  });

  it("falls back to the whole page when there is neither main nor article", async () => {
    const body = await resolveArticleBody(
      { url: "https://x/a" },
      {
        fetch: async () =>
          new Response(
            "<html><body><div><p>Just a plain div body.</p></div></body></html>",
            { status: 200 },
          ),
        sleep: async () => {},
      },
    );
    expect(body).toBe("Just a plain div body.");
  });

  it("excludes nav/footer/aside/header from the extracted body", async () => {
    const body = await resolveArticleBody(
      { url: "https://x/a" },
      {
        fetch: async () =>
          new Response(
            "<html><body><main><header>Section head</header><aside>Sidebar</aside><p>Core content.</p></main></body></html>",
            { status: 200 },
          ),
        sleep: async () => {},
      },
    );
    expect(body).toBe("Core content.");
  });

  it("returns null when the link fetch fails", async () => {
    const body = await resolveArticleBody(
      { url: "https://x/a" },
      {
        fetch: async () => new Response("nope", { status: 500 }),
        sleep: async () => {},
      },
    );
    expect(body).toBeNull();
  });
});

// content:encoded に全文が入った合成 Medium フィード（架空）。2 記事とも @alice。
const MEDIUM_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Alice on Medium</title>
    <item>
      <title>Post one</title>
      <link>https://medium.com/@alice/post-one-abc</link>
      <pubDate>Tue, 08 Jul 2026 00:00:00 GMT</pubDate>
      <description>&lt;p&gt;Snippet one.&lt;/p&gt;</description>
      <content:encoded>&lt;article&gt;&lt;p&gt;Full body of post one about widgets.&lt;/p&gt;&lt;/article&gt;</content:encoded>
    </item>
    <item>
      <title>Post two</title>
      <link>https://medium.com/@alice/post-two-def</link>
      <pubDate>Tue, 08 Jul 2026 01:00:00 GMT</pubDate>
      <description>&lt;p&gt;Snippet two.&lt;/p&gt;</description>
      <content:encoded>&lt;article&gt;&lt;p&gt;Full body of post two about gadgets.&lt;/p&gt;&lt;/article&gt;</content:encoded>
    </item>
  </channel>
</rss>`;

describe("resolveArticleBody: Medium feed recovery", () => {
  it("recovers the full body of a Medium article via its derived feed", async () => {
    const body = await resolveArticleBody(
      { url: "https://medium.com/@alice/post-one-abc" },
      {
        fetch: async () => new Response(MEDIUM_FEED, { status: 200 }),
        sleep: async () => {},
      },
    );
    expect(body).toBe("Full body of post one about widgets.");
  });

  it("recovers the Medium body even when a feedSummary snippet is present", async () => {
    // description のみの Medium 記事でも、実本文（content:encoded）を回収し
    // スニペットに短絡させない。
    const body = await resolveArticleBody(
      {
        url: "https://medium.com/@alice/post-one-abc",
        feedSummary: "Snippet one.",
      },
      {
        fetch: async () => new Response(MEDIUM_FEED, { status: 200 }),
        sleep: async () => {},
      },
    );
    expect(body).toBe("Full body of post one about widgets.");
  });

  it("fetches the derived feed only once for two articles from the same source", async () => {
    let calls = 0;
    const fetch = async () => {
      calls++;
      return new Response(MEDIUM_FEED, { status: 200 });
    };
    const mediumFeedCache = new Map<string, NormalizedArticle[]>();
    const b1 = await resolveArticleBody(
      { url: "https://medium.com/@alice/post-one-abc" },
      { fetch, sleep: async () => {}, mediumFeedCache },
    );
    const b2 = await resolveArticleBody(
      { url: "https://medium.com/@alice/post-two-def" },
      { fetch, sleep: async () => {}, mediumFeedCache },
    );
    expect(b1).toBe("Full body of post one about widgets.");
    expect(b2).toBe("Full body of post two about gadgets.");
    expect(calls).toBe(1);
  });

  it("falls back to a normal page fetch when the feed has no matching item", async () => {
    const fetch = async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/feed/")) {
        return new Response(MEDIUM_FEED, { status: 200 });
      }
      return new Response(
        "<html><body><main><p>Page fallback body.</p></main></body></html>",
        { status: 200 },
      );
    };
    const body = await resolveArticleBody(
      { url: "https://medium.com/@alice/unknown-post" },
      { fetch, sleep: async () => {} },
    );
    expect(body).toBe("Page fallback body.");
  });
});
