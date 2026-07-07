import { normalizeUrl } from "../normalize";
import { fetchWithRetry } from "../retry";
import type { NormalizedArticle } from "../types";

interface HnHit {
  objectID: string;
  title: string;
  url: string | null;
  story_text?: string | null;
  created_at: string;
}

export function parseHnResponse(response: { hits: HnHit[] }): NormalizedArticle[] {
  return response.hits.map((hit) => ({
    url: normalizeUrl(hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`),
    title: hit.title,
    source: "hn",
    publishedAt: hit.created_at,
    feedSummary: hit.story_text ?? undefined,
  }));
}

export async function fetchHnStories(minPoints: number): Promise<NormalizedArticle[]> {
  const url = `https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=points%3E${minPoints}&hitsPerPage=30`;
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`HN Algolia: HTTP ${res.status}`);
  return parseHnResponse(await res.json());
}
