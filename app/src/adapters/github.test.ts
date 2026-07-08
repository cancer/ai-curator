import { describe, it, expect, vi } from "vitest";
import { parseReleases, fetchReleases, type GitHubRelease } from "./github";
import { githubReleasesRaw } from "../../test/fixtures/github-releases";

const SOURCE = "github:acme/sprocket";

describe("parseReleases", () => {
  it("excludes draft and prerelease releases", () => {
    const articles = parseReleases(githubReleasesRaw, SOURCE);
    expect(articles).toHaveLength(2);
    for (const article of articles) {
      expect(article.title).not.toContain("RC1");
      expect(article.title).not.toBe("Unpublished draft");
    }
  });

  it("uses name as title when present", () => {
    const articles = parseReleases(githubReleasesRaw, SOURCE);
    expect(articles[0].title).toBe("Sprocket 3.0");
  });

  it("falls back to tag_name when name is null", () => {
    const articles = parseReleases(githubReleasesRaw, SOURCE);
    expect(articles[1].title).toBe("v2.9.1");
  });

  it("falls back to tag_name when name is an empty string", () => {
    const articles = parseReleases(
      [
        {
          name: "",
          tag_name: "v1.2.3",
          body: null,
          draft: false,
          prerelease: false,
          published_at: "2025-01-01T00:00:00Z",
          html_url: "https://github.com/acme/sprocket/releases/tag/v1.2.3",
        },
      ],
      SOURCE,
    );
    expect(articles[0].title).toBe("v1.2.3");
  });

  it("maps body, publishedAt, and source", () => {
    const [first] = parseReleases(githubReleasesRaw, SOURCE);
    expect(first.body).toBe(
      "## Sprocket 3.0\n\nAdds the imaginary flux capacitor module.",
    );
    expect(first.publishedAt).toBe("2025-06-01T09:00:00Z");
    expect(first.source).toBe(SOURCE);
  });

  it("normalizes the release html_url (strips tracking params)", () => {
    const [first] = parseReleases(githubReleasesRaw, SOURCE);
    expect(first.url).toBe(
      "https://github.com/acme/sprocket/releases/tag/v3.0.0",
    );
  });
});

describe("fetchReleases — pagination and day window", () => {
  const WINDOW = new Date("2026-07-08T00:00:00.000Z");

  function release(tag: string, publishedAt: string): GitHubRelease {
    return {
      name: tag,
      tag_name: tag,
      body: null,
      draft: false,
      prerelease: false,
      published_at: publishedAt,
      html_url: `https://github.com/o/r/releases/tag/${tag}`,
    };
  }

  function pagedFetch(pages: Record<string, GitHubRelease[]>) {
    return vi.fn(async (url: RequestInfo | URL) => {
      const page = new URL(String(url)).searchParams.get("page") ?? "1";
      return new Response(JSON.stringify(pages[page] ?? []), { status: 200 });
    });
  }

  it("follows multiple pages until a page contains an out-of-window release", async () => {
    // Page 1 is a full page (100) of in-window releases -> keep going.
    const page1 = Array.from({ length: 100 }, (_, i) =>
      release(`p1-${i}`, "2026-07-08T12:00:00Z"),
    );
    // Page 2 mixes one in-window and one older -> collect the fresh one, then stop.
    const page2 = [
      release("p2-fresh", "2026-07-08T06:00:00Z"),
      release("p2-old", "2026-07-01T00:00:00Z"),
    ];
    const fetch = pagedFetch({ "1": page1, "2": page2 });

    const articles = await fetchReleases("o", "r", WINDOW, { fetch });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(articles).toHaveLength(101);
    expect(articles.some((a) => a.url.includes("p2-old"))).toBe(false);
  });

  it("stops on a short page and drops out-of-window releases", async () => {
    const page1 = [
      release("fresh", "2026-07-08T12:00:00Z"),
      release("old", "2026-07-01T00:00:00Z"),
    ];
    const fetch = pagedFetch({ "1": page1 });

    const articles = await fetchReleases("o", "r", WINDOW, { fetch });

    // Short page (2 < 100) and reached window -> single request.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(articles).toHaveLength(1);
    expect(articles[0].url).toContain("fresh");
  });

  it("skips the source (returns []) on a non-ok response", async () => {
    const fetch = vi.fn(async () => new Response("nope", { status: 403 }));
    expect(await fetchReleases("o", "r", WINDOW, { fetch })).toEqual([]);
  });
});
