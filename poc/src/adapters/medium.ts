import { XMLParser } from "fast-xml-parser";
import { htmlToText } from "../html";
import { normalizeUrl } from "../normalize";
import { fetchWithRetry } from "../retry";
import type { NormalizedArticle } from "../types";
import { FEED_ENTITY_OPTIONS } from "../xml";

interface MediumItem {
  title: string;
  link: string;
  pubDate: string;
  description?: string;
  "content:encoded"?: string;
}

/**
 * Medium の RSS feed をパースする。
 * 著者 feed は content:encoded に本文全文を含む（テンプレ抽出）。
 * タグ feed は description の snippet のみ（メタ収集用）。
 */
export function parseMediumFeed(xml: string, source: string): NormalizedArticle[] {
  const parser = new XMLParser(FEED_ENTITY_OPTIONS);
  const parsed = parser.parse(xml);
  const items: MediumItem[] = [parsed.rss.channel.item ?? []].flat();
  return items.map((item) => {
    const fullHtml = item["content:encoded"];
    return {
      url: normalizeUrl(item.link),
      title: item.title,
      source,
      publishedAt: new Date(item.pubDate).toISOString(),
      feedSummary: item.description ? htmlToText(item.description) : undefined,
      body: fullHtml ? htmlToText(fullHtml) : undefined,
    };
  });
}

export async function fetchMediumFeed(
  feedPath: string,
  source: string,
): Promise<NormalizedArticle[]> {
  const res = await fetchWithRetry(`https://medium.com/feed/${feedPath}`);
  if (!res.ok) throw new Error(`Medium ${feedPath}: HTTP ${res.status}`);
  return parseMediumFeed(await res.text(), source);
}
