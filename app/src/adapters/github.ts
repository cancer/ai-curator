/**
 * GitHub Releases アダプタ。source=`github:owner/repo`。
 *
 * GET https://api.github.com/repos/{owner}/{repo}/releases?per_page=10
 * - user-agent ヘッダ必須（無いと 403）
 * - draft / prerelease は除外
 * - 未認証レート制限は 60 req/h/IP。429/403 はリトライ対象外（fetchWithRetry は
 *   4xx を即時返すので !res.ok を検知して警告し、空配列として扱う）
 */

import { normalizeUrl } from "../lib/normalize";
import { fetchWithRetry, type FetchWithRetryOptions } from "../lib/retry";
import type { NormalizedArticle } from "./types";

/** GitHub Releases API のうちアダプタが参照するフィールド。 */
export interface GitHubRelease {
  name: string | null;
  tag_name: string;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  html_url: string;
}

const USER_AGENT = "ai-curator";

export function parseReleases(
  releases: GitHubRelease[],
  source: string,
): NormalizedArticle[] {
  return releases
    .filter((release) => !release.draft && !release.prerelease)
    .map((release) => ({
      url: normalizeUrl(release.html_url),
      // name が空文字 "" のときも tag_name にフォールバックさせる（?? では素通りする）。
      title: release.name || release.tag_name,
      source,
      publishedAt: release.published_at,
      body: release.body ?? undefined,
    }));
}

export async function fetchReleases(
  owner: string,
  repo: string,
  options?: FetchWithRetryOptions,
): Promise<NormalizedArticle[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=10`;
  const res = await fetchWithRetry(
    url,
    { headers: { "user-agent": USER_AGENT } },
    options,
  );

  if (!res.ok) {
    console.warn(
      `github: ${owner}/${repo} returned ${res.status} (rate limit?); skipping`,
    );
    return [];
  }

  const releases = (await res.json()) as GitHubRelease[];
  return parseReleases(releases, `github:${owner}/${repo}`);
}
