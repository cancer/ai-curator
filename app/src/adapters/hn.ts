/**
 * Hacker News (Algolia) アダプタ。source=`hn`。
 *
 * GET https://hn.algolia.com/api/v1/search_by_date
 *   ?tags=story&numericFilters=points>{minPoints},created_at_i>{windowStart}
 *   &hitsPerPage=100&page=N
 * - points / 当日ウィンドウのフィルタは API に任せる（クライアント側で再フィルタしない）
 * - 当日ウィンドウ内を nbPages まで全ページ取得する（先頭 30 件で切らない）
 * - url が null の self-post は item?id にフォールバック
 * - リンク先本文は fetchArticleBody で要約段が粗抽出する（取得失敗時は空を返す）
 */

import { normalizeUrl } from "../lib/normalize";
import { htmlToText } from "../lib/html";
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
  /** Algolia の総ページ数。ページ送りの停止条件に使う。 */
  nbPages?: number;
}

const SOURCE = "hn";
const USER_AGENT = "ai-curator";
const HITS_PER_PAGE = 100;

/**
 * リンク先本文の粗抽出で採用する最小文字数。これ未満はボットブロック・
 * ペイウォール・SPA スケルトン等のスタブとみなし空を返す（呼び出し側が
 * story_text→タイトルにフォールバックできるようにする）。
 */
const MIN_BODY_CHARS = 200;

export function parseStories(
  response: HnSearchResponse,
): Promise<NormalizedArticle[]> {
  // story_text は生 HTML のことがある。SimHash/Embedding 入力を Medium と
  // 揃えるため plain text 化する（生 HTML が混ざる非対称を解消）。
  return Promise.all(
    response.hits.map(async (hit) => ({
      url: normalizeUrl(
        hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID}`,
      ),
      title: hit.title,
      source: SOURCE,
      publishedAt: hit.created_at,
      feedSummary:
        hit.story_text == null ? undefined : await htmlToText(hit.story_text),
    })),
  );
}

export async function fetchStories(
  minPoints: number,
  windowStart: Date,
  options?: FetchWithRetryOptions,
): Promise<NormalizedArticle[]> {
  const sinceEpoch = Math.floor(windowStart.getTime() / 1000);
  const filters = `points>${minPoints},created_at_i>${sinceEpoch}`;
  const collected: NormalizedArticle[] = [];

  let page = 0;
  let nbPages = 1;
  do {
    const url =
      `https://hn.algolia.com/api/v1/search_by_date?tags=story` +
      `&numericFilters=${encodeURIComponent(filters)}` +
      `&hitsPerPage=${HITS_PER_PAGE}&page=${page}`;
    const res = await fetchWithRetry(url, undefined, options);

    if (!res.ok) {
      console.warn(`hn: search returned ${res.status}; skipping`);
      break;
    }

    const response = (await res.json()) as HnSearchResponse;
    collected.push(...(await parseStories(response)));
    nbPages = response.nbPages ?? 1;
    page++;
  } while (page < nbPages);

  return collected;
}

/**
 * リンク先の外部ページを粗いタグ除去（root/exclude なしの htmlToText）で本文化する。
 * 任意サイト向けの個別抽出はしない。取得失敗・非 HTML・本文が極端に短い場合は
 * 空文字を返し、呼び出し側が story_text→タイトルにフォールバックできるようにする。
 * この本文取得は要約段でのみ使う。
 */
export async function fetchArticleBody(
  url: string,
  options?: FetchWithRetryOptions,
): Promise<string> {
  let res: Response;
  try {
    res = await fetchWithRetry(
      url,
      { headers: { "user-agent": USER_AGENT } },
      options,
    );
  } catch {
    return "";
  }

  if (!res.ok) {
    return "";
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    return "";
  }

  const text = await htmlToText(await res.text());
  return text.length < MIN_BODY_CHARS ? "" : text;
}
