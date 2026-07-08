import type { GitHubRelease } from "../../src/adapters/github";

/**
 * GitHub Releases API レスポンスを模した合成データ（すべて架空）。
 *
 * - name あり / name=null（tag_name フォールバック検証）
 * - draft:true と prerelease:true を含む（除外検証）
 */
export const githubReleasesRaw: GitHubRelease[] = [
  {
    name: "Sprocket 3.0",
    tag_name: "v3.0.0",
    body: "## Sprocket 3.0\n\nAdds the imaginary flux capacitor module.",
    draft: false,
    prerelease: false,
    published_at: "2025-06-01T09:00:00Z",
    html_url: "https://github.com/acme/sprocket/releases/tag/v3.0.0?utm_source=feed",
  },
  {
    name: null,
    tag_name: "v2.9.1",
    body: "Patch for the fictional widget parser.",
    draft: false,
    prerelease: false,
    published_at: "2025-05-20T12:30:00Z",
    html_url: "https://github.com/acme/sprocket/releases/tag/v2.9.1",
  },
  {
    name: "Sprocket 3.1 RC1",
    tag_name: "v3.1.0-rc1",
    body: "Release candidate.",
    draft: false,
    prerelease: true,
    published_at: "2025-06-10T08:00:00Z",
    html_url: "https://github.com/acme/sprocket/releases/tag/v3.1.0-rc1",
  },
  {
    name: "Unpublished draft",
    tag_name: "v3.2.0",
    body: "Not ready yet.",
    draft: true,
    prerelease: false,
    published_at: "2025-06-15T08:00:00Z",
    html_url: "https://github.com/acme/sprocket/releases/tag/v3.2.0",
  },
];
