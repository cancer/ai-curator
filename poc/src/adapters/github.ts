import { normalizeUrl } from "../normalize";
import { fetchWithRetry } from "../retry";
import type { NormalizedArticle } from "../types";

interface GithubRelease {
  html_url: string;
  name: string | null;
  tag_name: string;
  published_at: string;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
}

export function parseGithubReleases(
  releases: GithubRelease[],
  repo: string,
): NormalizedArticle[] {
  return releases
    .filter((r) => !r.draft && !r.prerelease)
    .map((r) => ({
      url: normalizeUrl(r.html_url),
      title: r.name ?? r.tag_name,
      source: `github:${repo}`,
      publishedAt: r.published_at,
      body: r.body ?? undefined,
    }));
}

export async function fetchGithubReleases(repo: string): Promise<NormalizedArticle[]> {
  const res = await fetchWithRetry(`https://api.github.com/repos/${repo}/releases?per_page=10`, {
    headers: { "user-agent": "ai-curator-poc" },
  });
  if (!res.ok) throw new Error(`GitHub ${repo}: HTTP ${res.status}`);
  return parseGithubReleases(await res.json(), repo);
}
