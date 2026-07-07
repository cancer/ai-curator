import { describe, expect, test } from "bun:test";
import { loadFixture } from "../fixtures";
import { parseGithubReleases } from "./github";

const { exists, text } = await loadFixture(
  new URL("../../fixtures/github_releases.json", import.meta.url),
);

describe("parseGithubReleases", () => {
  test.skipIf(!exists)("リリースを正規化記事に変換する", () => {
    const articles = parseGithubReleases(JSON.parse(text), "sveltejs/svelte");
    expect(articles.length).toBeGreaterThan(0);
    const first = articles[0]!;
    expect(first.url).toStartWith("https://github.com/sveltejs/svelte/releases/tag/");
    expect(first.title).toContain("svelte@");
    expect(first.source).toBe("github:sveltejs/svelte");
    expect(Date.parse(first.publishedAt)).not.toBeNaN();
    expect(first.body).toContain("Patch Changes");
  });

  test("draft と prerelease を除外する", () => {
    const releases = [
      { html_url: "https://x/1", name: "v1", tag_name: "v1", published_at: "2026-01-01T00:00:00Z", body: "b", draft: true, prerelease: false },
      { html_url: "https://x/2", name: "v2", tag_name: "v2", published_at: "2026-01-01T00:00:00Z", body: "b", draft: false, prerelease: true },
      { html_url: "https://x/3", name: "v3", tag_name: "v3", published_at: "2026-01-01T00:00:00Z", body: "b", draft: false, prerelease: false },
    ];
    const articles = parseGithubReleases(releases, "o/r");
    expect(articles.map((a) => a.title)).toEqual(["v3"]);
  });

  test("name が null なら tag_name を使う", () => {
    const releases = [
      { html_url: "https://x/1", name: null, tag_name: "v9", published_at: "2026-01-01T00:00:00Z", body: null, draft: false, prerelease: false },
    ];
    const articles = parseGithubReleases(releases, "o/r");
    expect(articles[0]!.title).toBe("v9");
    expect(articles[0]!.body).toBeUndefined();
  });
});
