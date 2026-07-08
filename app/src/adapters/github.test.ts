import { describe, it, expect } from "vitest";
import { parseReleases } from "./github";
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
