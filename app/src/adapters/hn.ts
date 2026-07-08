/**
 * Hacker News (Algolia) アダプタ。source=`hn`。
 *
 * GET https://hn.algolia.com/api/v1/search_by_date
 *   ?tags=story&numericFilters=points>{minPoints}&hitsPerPage=30
 * - points フィルタは API に任せる（クライアント側で再フィルタしない）
 * - url が null の self-post は item?id にフォールバック
 * - 本文は取得しない（リンク先外部サイトは対象外）
 */

import { normalizeUrl } from "../lib/normalize";
import { fetchWithRetry, type FetchWithRetryOptions } from "../lib/retry";
import type { NormalizedArticle } from "./types";

/** Algolia search hit のうちアダプタが参照するフィールド。 */
export interface HnHit {
  objectID: string;
  title: string;
  url: string | null;
  points: number;
  created_at: string;
  story_text?: string | null;
}

export interface HnSearchResponse {
  hits: HnHit[];
}

const SOURCE = "hn";

export function parseStories(response: HnSearchResponse): NormalizedArticle[] {
  return response.hits.map((hit) => ({
    url: normalizeUrl(
      hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
    ),
    title: hit.title,
    source: SOURCE,
    publishedAt: hit.created_at,
    feedSummary: hit.story_text ?? undefined,
  }));
}

export async function fetchStories(
  minPoints: number,
  options?: FetchWithRetryOptions,
): Promise<NormalizedArticle[]> {
  const url =
    `https://hn.algolia.com/api/v1/search_by_date?tags=story` +
    `&numericFilters=${encodeURIComponent(`points>${minPoints}`)}` +
    `&hitsPerPage=30`;
  const res = await fetchWithRetry(url, undefined, options);

  if (!res.ok) {
    console.warn(`hn: search returned ${res.status}; skipping`);
    return [];
  }

  const response = (await res.json()) as HnSearchResponse;
  return parseStories(response);
}
