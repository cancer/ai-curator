/**
 * Medium (RSS) アダプタ。
 *
 * 著者 feed  https://medium.com/feed/@{author}  source=`medium:@author`
 *   - <content:encoded> に本文全文。htmlToText で body に。<description> → feedSummary。
 * タグ feed  https://medium.com/feed/tag/{tag}   source=`medium:tag/{tag}`
 *   - <description> のスニペットのみ（body なし）。
 *
 * 記事ページの直接 fetch は実装しない（ボットチャレンジで不可能）。
 * pubDate は RFC 2822 → ISO 8601。url は ?source=rss--- が付くため正規化必須。
 */

import { XMLParser } from "fast-xml-parser";
import { normalizeUrl } from "../lib/normalize";
import { htmlToText } from "../lib/html";
import { feedParserOptions } from "../lib/xml";
import { fetchWithRetry, type FetchWithRetryOptions } from "../lib/retry";
import { ensureArray, type NormalizedArticle } from "./types";

interface RssItem {
  title: string;
  link: string;
  pubDate: string;
  description?: string;
  "content:encoded"?: string;
}

const USER_AGENT = "ai-curator";

function items(xml: string): RssItem[] {
  const parsed = new XMLParser(feedParserOptions).parse(xml);
  return ensureArray<RssItem>(parsed?.rss?.channel?.item);
}

function commonFields(item: RssItem, source: string): NormalizedArticle {
  return {
    url: normalizeUrl(String(item.link)),
    title: String(item.title),
    source,
    publishedAt: new Date(String(item.pubDate)).toISOString(),
    feedSummary: item.description,
  };
}

export async function parseAuthorFeed(
  xml: string,
  author: string,
): Promise<NormalizedArticle[]> {
  const source = `medium:@${author}`;
  return Promise.all(
    items(xml).map(async (item) => {
      const encoded = item["content:encoded"];
      return {
        ...commonFields(item, source),
        body: encoded === undefined ? undefined : await htmlToText(encoded),
      };
    }),
  );
}

export function parseTagFeed(xml: string, tag: string): NormalizedArticle[] {
  const source = `medium:tag/${tag}`;
  return items(xml).map((item) => commonFields(item, source));
}

export async function fetchAuthorFeed(
  author: string,
  options?: FetchWithRetryOptions,
): Promise<NormalizedArticle[]> {
  const res = await fetchWithRetry(
    `https://medium.com/feed/@${author}`,
    { headers: { "user-agent": USER_AGENT } },
    options,
  );
  if (!res.ok) {
    console.warn(`medium: @${author} feed returned ${res.status}; skipping`);
    return [];
  }
  return parseAuthorFeed(await res.text(), author);
}

export async function fetchTagFeed(
  tag: string,
  options?: FetchWithRetryOptions,
): Promise<NormalizedArticle[]> {
  const res = await fetchWithRetry(
    `https://medium.com/feed/tag/${tag}`,
    { headers: { "user-agent": USER_AGENT } },
    options,
  );
  if (!res.ok) {
    console.warn(`medium: tag/${tag} feed returned ${res.status}; skipping`);
    return [];
  }
  return parseTagFeed(await res.text(), tag);
}
