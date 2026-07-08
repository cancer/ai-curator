/**
 * martinfowler.com アダプタ。source=`fowler`。
 *
 * feed: https://martinfowler.com/feed.atom（Atom）
 *   entry の link@href / title / updated（→publishedAt ISO）/
 *   content（HTML → htmlToText → feedSummary）。feedSummary は非永続（DB・KV・
 *   ログに書かない）ため切り詰めない。埋め込み入力は下流で maxInputChars に
 *   切り詰められる。url は link@href を正規化。
 * 記事本文: 記事 URL を fetch（user-agent 付与）し、<main> の内側から
 *   ナビ・見出し等を除いて抽出する。連続アクセスの間隔制御は呼び出し側が担う。
 *   <main> が見つからない（抽出結果が空）ページは throw（サイト構造変更の検知）。
 */

import { XMLParser } from "fast-xml-parser";
import { normalizeUrl } from "../lib/normalize";
import { htmlToText } from "../lib/html";
import { feedParserOptions } from "../lib/xml";
import { fetchWithRetry, type FetchWithRetryOptions } from "../lib/retry";
import { ensureArray, withinWindow, type NormalizedArticle } from "./types";

interface AtomLink {
  "@_href": string;
  "@_rel"?: string;
}

interface AtomText {
  "#text"?: string;
}

interface AtomEntry {
  title: string;
  link: AtomLink | AtomLink[];
  updated: string;
  content?: string | AtomText;
}

const SOURCE = "fowler";
const USER_AGENT = "ai-curator";

/** 記事本文抽出。<main> 内から本文以外の定型要素を除外する。 */
const ARTICLE_ROOT = "main";
const ARTICLE_EXCLUDE = [
  "h1",
  ".date",
  ".author-list",
  ".author",
  ".tags",
  ".contents",
];

/** entry の複数 link から本文リンク（rel=alternate、無ければ先頭）の href を選ぶ。 */
export function selectHref(link: AtomLink | AtomLink[]): string {
  const links = ensureArray<AtomLink>(link);
  if (links.length === 0) {
    throw new Error("fowler: entry has no link");
  }
  const alternate = links.find((l) => l["@_rel"] === "alternate");
  return (alternate ?? links[0])["@_href"];
}

function contentText(content: AtomEntry["content"]): string {
  if (content === undefined) {
    return "";
  }
  return typeof content === "string" ? content : (content["#text"] ?? "");
}

export async function parseFeed(xml: string): Promise<NormalizedArticle[]> {
  const parsed = new XMLParser(feedParserOptions).parse(xml);
  const entries = ensureArray<AtomEntry>(parsed?.feed?.entry);

  return Promise.all(
    entries.map(async (entry) => ({
      url: normalizeUrl(selectHref(entry.link)),
      title: String(entry.title),
      source: SOURCE,
      publishedAt: new Date(String(entry.updated)).toISOString(),
      feedSummary: await htmlToText(contentText(entry.content)),
    })),
  );
}

/**
 * 記事 HTML から本文を抽出する。<main> が無い（抽出結果が空）ページは
 * サイト構造変更とみなして throw する。
 */
export async function extractArticleBody(html: string): Promise<string> {
  const body = await htmlToText(html, {
    root: ARTICLE_ROOT,
    exclude: ARTICLE_EXCLUDE,
  });
  if (body === "") {
    throw new Error("fowler: <main> not found or empty; site structure changed");
  }
  return body;
}

export async function fetchArticleBody(
  url: string,
  options?: FetchWithRetryOptions,
): Promise<string> {
  const res = await fetchWithRetry(
    url,
    { headers: { "user-agent": USER_AGENT } },
    options,
  );
  if (!res.ok) {
    throw new Error(`fowler: article ${url} returned ${res.status}`);
  }
  return extractArticleBody(await res.text());
}

/**
 * feed のみを取得する（記事本文は取得しない）。feedSummary は埋まるが body は
 * 付かない。本文取得は日次パスの要約段が fetchArticleBody で行う。feed は非
 * ページングなので、取得分から当日ウィンドウ内に絞る。
 */
export async function fetchFowlerFeed(
  windowStart: Date,
  options?: FetchWithRetryOptions,
): Promise<NormalizedArticle[]> {
  const res = await fetchWithRetry(
    "https://martinfowler.com/feed.atom",
    { headers: { "user-agent": USER_AGENT } },
    options,
  );
  if (!res.ok) {
    console.warn(`fowler: feed returned ${res.status}; skipping`);
    return [];
  }
  return withinWindow(await parseFeed(await res.text()), windowStart);
}
