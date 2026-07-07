import { XMLParser } from "fast-xml-parser";
import { containsElement, htmlToText } from "../html";
import { normalizeUrl } from "../normalize";
import { fetchWithRetry } from "../retry";
import type { NormalizedArticle } from "../types";
import { FEED_ENTITY_OPTIONS } from "../xml";

interface AtomEntry {
  title: string;
  link: { "@_href": string };
  updated: string;
  content: { "#text": string };
}

export function parseFowlerFeed(xml: string): NormalizedArticle[] {
  const parser = new XMLParser({ ignoreAttributes: false, ...FEED_ENTITY_OPTIONS });
  const parsed = parser.parse(xml);
  const entries: AtomEntry[] = [parsed.feed.entry ?? []].flat();
  return entries.map((entry) => ({
    url: normalizeUrl(entry.link["@_href"]),
    title: entry.title,
    source: "fowler",
    publishedAt: entry.updated,
    feedSummary: htmlToText(entry.content["#text"]),
  }));
}

/**
 * martinfowler.com の記事ページは <main> が本文コンテナ（fixtures/fowler_article.html で確認）。
 * <main> 内には本文本体のほか、タイトル・著者略歴・日付・目次といった記事メタが混在するため、
 * それらを除外して本文本体だけを抽出する。h1 のタイトルは NormalizedArticle.title に別途持つ。
 */
const FOWLER_BOILERPLATE = [
  "h1",
  ".date",
  ".author-list",
  ".author",
  ".tags",
  ".contents",
] as const;

export function extractFowlerBody(html: string): string {
  if (!containsElement(html, "main")) throw new Error("fowler: <main> not found");
  return htmlToText(html, { root: "main", exclude: FOWLER_BOILERPLATE });
}

export async function fetchFowlerFeed(): Promise<NormalizedArticle[]> {
  const res = await fetchWithRetry("https://martinfowler.com/feed.atom");
  if (!res.ok) throw new Error(`fowler feed: HTTP ${res.status}`);
  return parseFowlerFeed(await res.text());
}

export async function fetchFowlerBody(articleUrl: string): Promise<string> {
  const res = await fetchWithRetry(articleUrl, { headers: { "user-agent": "ai-curator-poc" } });
  if (!res.ok) throw new Error(`fowler ${articleUrl}: HTTP ${res.status}`);
  return extractFowlerBody(await res.text());
}
