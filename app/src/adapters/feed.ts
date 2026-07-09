/**
 * 汎用 RSS/Atom フィードアダプタ。source=`feed:{feedUrl}`。
 *
 * 任意のフィード URL（config.sources.feeds）を 1 本のパーサで扱う。RSS（`<item>`）と
 * Atom（`<entry>`）の両方言に対応する。従来の medium/fowler 専用アダプタはこれに統合した。
 *
 * 各記事:
 * - title / url = link を normalizeUrl / publishedAt = pubDate|updated を ISO 8601
 * - feedSummary = `content:encoded` → `content` → `description`/`summary` の最初に
 *   あるものを htmlToText（埋め込み・SimHash 入力／要約フォールバックに使う一時データ）
 * - body = `content:encoded` → `content` の htmlToText（インライン本文がある場合のみ）。
 *   一時データで D1・KV・ログに書かない。resolveFeedBody が要約段でこれを使う。
 */

import { XMLParser } from "fast-xml-parser";
import { normalizeUrl } from "../lib/normalize";
import { htmlToText } from "../lib/html";
import { feedParserOptions } from "../lib/xml";
import { fetchWithRetry, type FetchWithRetryOptions } from "../lib/retry";
import { ensureArray, withinWindow, type NormalizedArticle } from "./types";

const USER_AGENT = "ai-curator";

interface AtomLink {
  "@_href": string;
  "@_rel"?: string;
}

interface AtomText {
  "#text"?: string;
}

interface RssItem {
  title?: string | AtomText;
  link?: string;
  pubDate?: string;
  description?: string;
  "content:encoded"?: string;
}

interface AtomEntry {
  title?: string | AtomText;
  link?: AtomLink | AtomLink[];
  updated?: string;
  published?: string;
  content?: string | AtomText;
  summary?: string | AtomText;
}

/** string | { "#text": ... } のどちらでもテキストを取り出す。未定義は "" 。 */
function textOf(value: string | AtomText | undefined): string {
  if (value === undefined) {
    return "";
  }
  return typeof value === "string" ? value : (value["#text"] ?? "");
}

/** Atom entry の複数 link から本文リンク（rel=alternate、無ければ先頭）の href を選ぶ。 */
export function selectHref(link: AtomLink | AtomLink[] | undefined): string {
  const links = ensureArray<AtomLink>(link);
  if (links.length === 0) {
    throw new Error("feed: entry has no link");
  }
  const alternate = links.find((l) => l["@_rel"] === "alternate");
  return (alternate ?? links[0])["@_href"];
}

/**
 * 記事 1 件を正規化する。feedSummary はインライン全文→要約スニペットの優先順で
 * 最初にあるものを、body はインライン全文（content:encoded / content）があるときだけ
 * 設定する。どちらも htmlToText 済み。
 */
async function normalize(args: {
  title: string;
  link: string;
  publishedAt: string;
  feedUrl: string;
  fullContentHtml: string | undefined;
  descriptionHtml: string | undefined;
}): Promise<NormalizedArticle> {
  const { title, link, publishedAt, feedUrl, fullContentHtml, descriptionHtml } =
    args;

  const summaryHtml = fullContentHtml ?? descriptionHtml;

  return {
    url: normalizeUrl(link),
    title,
    source: `feed:${feedUrl}`,
    publishedAt: new Date(publishedAt).toISOString(),
    feedSummary:
      summaryHtml === undefined ? undefined : await htmlToText(summaryHtml),
    body:
      fullContentHtml === undefined
        ? undefined
        : await htmlToText(fullContentHtml),
  };
}

async function parseRss(
  channel: unknown,
  feedUrl: string,
): Promise<NormalizedArticle[]> {
  const items = ensureArray<RssItem>(
    (channel as { item?: RssItem | RssItem[] })?.item,
  );
  return Promise.all(
    items.map((item) => {
      const encoded = item["content:encoded"];
      const description = item.description;
      // content:encoded が無ければ description をインライン全文候補とはしない
      // （description は要約スニペット扱い）。RSS に別 content 要素は無い。
      return normalize({
        title: textOf(item.title),
        link: String(item.link ?? ""),
        publishedAt: String(item.pubDate ?? ""),
        feedUrl,
        fullContentHtml: encoded ?? undefined,
        descriptionHtml: description ?? undefined,
      });
    }),
  );
}

async function parseAtom(
  feed: { entry?: AtomEntry | AtomEntry[] },
  feedUrl: string,
): Promise<NormalizedArticle[]> {
  const entries = ensureArray<AtomEntry>(feed?.entry);
  return Promise.all(
    entries.map((entry) => {
      const content = textOf(entry.content) || undefined;
      const summary = textOf(entry.summary) || undefined;
      return normalize({
        title: textOf(entry.title),
        link: selectHref(entry.link),
        publishedAt: String(entry.updated ?? entry.published ?? ""),
        feedUrl,
        fullContentHtml: content,
        descriptionHtml: summary,
      });
    }),
  );
}

/**
 * RSS（`<rss><channel>`）と Atom（`<feed>`）の両方をパースする。
 * どちらでもない XML は throw（フィード構造の異常検知）。
 */
export function parseFeed(
  xml: string,
  feedUrl: string,
): Promise<NormalizedArticle[]> {
  const parsed = new XMLParser(feedParserOptions).parse(xml) as {
    rss?: { channel?: unknown };
    feed?: { entry?: AtomEntry | AtomEntry[] };
  };

  if (parsed?.rss?.channel !== undefined) {
    return parseRss(parsed.rss.channel, feedUrl);
  }
  if (parsed?.feed !== undefined) {
    return parseAtom(parsed.feed, feedUrl);
  }
  throw new Error(`feed: ${feedUrl} is neither RSS nor Atom`);
}

/**
 * フィードを取得してパースする。feed は非ページングなので、取得分から当日
 * ウィンドウ内に絞る。取得失敗（!res.ok）はそのフィードをスキップ（警告のみ）。
 */
export async function fetchFeed(
  feedUrl: string,
  windowStart: Date,
  options?: FetchWithRetryOptions,
): Promise<NormalizedArticle[]> {
  const res = await fetchWithRetry(
    feedUrl,
    { headers: { "user-agent": USER_AGENT } },
    options,
  );
  if (!res.ok) {
    console.warn(`feed: ${feedUrl} returned ${res.status}; skipping`);
    return [];
  }
  return withinWindow(await parseFeed(await res.text(), feedUrl), windowStart);
}

/**
 * 要約用の本文を解決する。優先順（計画 B）:
 *  1. インライン全文（parseFeed が body に入れた content:encoded / content）
 *  2. feedSummary（description/summary スニペット）
 *  3. 記事 URL を fetch → 粗い htmlToText（root/exclude なし）
 *  4. いずれも取れなければ null
 *
 * ネットワークへ出るのは 3 のみ。呼び出し側が連続 fetch の間隔を制御できるよう、
 * 実際に fetch したかを返り値では区別しないが、1・2 に当たれば fetch しない。
 */
export async function resolveFeedBody(
  article: Pick<NormalizedArticle, "url" | "feedSummary" | "body">,
  options?: FetchWithRetryOptions,
): Promise<string | null> {
  if (article.body !== undefined && article.body !== "") {
    return article.body;
  }
  if (article.feedSummary !== undefined && article.feedSummary !== "") {
    return article.feedSummary;
  }

  let res: Response;
  try {
    res = await fetchWithRetry(
      article.url,
      { headers: { "user-agent": USER_AGENT } },
      options,
    );
  } catch {
    return null;
  }
  if (!res.ok) {
    return null;
  }
  const body = await htmlToText(await res.text());
  return body === "" ? null : body;
}
