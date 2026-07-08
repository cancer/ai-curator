/**
 * GitHub Releases アダプタ。source=`github:owner/repo`。
 *
 * GET https://api.github.com/repos/{owner}/{repo}/releases?per_page=100&page=N
 * - user-agent ヘッダ必須（無いと 403）
 * - draft / prerelease は除外
 * - 当日ウィンドウ内のリリースを全件取得する。GitHub は新しい順に返すため、
 *   window を下回るリリースに達したページで打ち切る（先頭 10 件で切らない）。
 * - 未認証レート制限は 60 req/h/IP。429/403 はリトライ対象外（fetchWithRetry は
 *   4xx を即時返すので !res.ok を検知して警告し、そのソースはスキップして続行）
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
const PER_PAGE = 100;
/**
 * ページ送りの安全上限。当日 1 リポジトリで PER_PAGE×MAX_PAGES=1000 件を超える
 * リリースは現実にありえないため、window 停止条件が効かない異常時の無限ループ防止。
 */
const MAX_PAGES = 10;

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
  windowStart: Date,
  options?: FetchWithRetryOptions,
): Promise<NormalizedArticle[]> {
  const source = `github:${owner}/${repo}`;
  const collected: NormalizedArticle[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=${PER_PAGE}&page=${page}`;
    const res = await fetchWithRetry(
      url,
      { headers: { "user-agent": USER_AGENT } },
      options,
    );

    if (!res.ok) {
      console.warn(
        `github: ${owner}/${repo} returned ${res.status} (rate limit?); skipping`,
      );
      break;
    }

    const releases = (await res.json()) as GitHubRelease[];
    if (releases.length === 0) {
      break;
    }

    const articles = parseReleases(releases, source);
    collected.push(...articles.filter((a) => new Date(a.publishedAt) >= windowStart));

    // window を下回る公開リリース（draft/prerelease は除外済み）に達したら、
    // 以降のページはさらに古いため打ち切る。満杯でないページも最終ページ。
    const reachedWindow = articles.some(
      (a) => new Date(a.publishedAt) < windowStart,
    );
    if (reachedWindow || releases.length < PER_PAGE) {
      break;
    }
  }

  return collected;
}
