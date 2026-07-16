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
 *   一時データで D1・KV・ログに書かない。resolveArticleBody が要約・埋め込み段でこれを使う。
 */

import { XMLParser } from "fast-xml-parser";
import { normalizeUrl } from "../lib/normalize";
import { htmlToText } from "../lib/html";
import { feedParserOptions } from "../lib/xml";
import { fetchWithRetry, type FetchWithRetryOptions } from "../lib/retry";
import { ensureArray, withinWindow, type NormalizedArticle } from "./types";

const USER_AGENT = "ai-curator";

/**
 * 「実本文」とみなす本文長の下限（文字数）。feedSummary スニペットは ~100 字なので、
 * 500 字で「スニペット」と「実本文」を分ける。後段（embedding の本文化・劣化止め）が
 * この閾値を共有する。
 */
export const MIN_BODY_CHARS = 500;

/**
 * ページ本文抽出で常に取り除くブロック（ナビ・フッタ・サイドバー・ヘッダ）。
 * いずれも非 void 要素なので htmlToText の root/exclude に渡してよい（void 要素は不可）。
 */
const BODY_EXCLUDE = ["nav", "footer", "aside", "header"];

interface AtomLink {
  "@_href": string;
  "@_rel"?: string;
  "@_type"?: string;
}

interface RssEnclosure {
  "@_url"?: string;
  "@_type"?: string;
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
  enclosure?: RssEnclosure | RssEnclosure[];
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

const PDF_CONTENT_TYPE = "application/pdf";

/**
 * URL のパスが `.pdf` で終わるか。クエリ・フラグメントは URL パースで path から
 * 除かれるので考慮不要。パース不能な URL は PDF ではないとみなす（false）。
 */
export function isPdfUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return url.pathname.toLowerCase().endsWith(".pdf");
}

/** RSS item が PDF か。link 拡張子・enclosure（url 拡張子 or type）で判定する。 */
function isRssItemPdf(item: RssItem): boolean {
  if (isPdfUrl(String(item.link ?? ""))) {
    return true;
  }
  return ensureArray<RssEnclosure>(item.enclosure).some(
    (enc) =>
      enc["@_type"] === PDF_CONTENT_TYPE || isPdfUrl(String(enc["@_url"] ?? "")),
  );
}

/** Atom entry が PDF か。記事リンク（selectHref と同じ選択）の href 拡張子・type で判定する。 */
function isAtomEntryPdf(entry: AtomEntry): boolean {
  const links = ensureArray<AtomLink>(entry.link);
  const alternate = links.find((l) => l["@_rel"] === "alternate");
  const selected = alternate ?? links[0];
  if (selected === undefined) {
    return false;
  }
  return (
    selected["@_type"] === PDF_CONTENT_TYPE ||
    isPdfUrl(selected["@_href"] ?? "")
  );
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
  // PDF は本文抽出・要約の対象にならないので取り込み段で除外する（issue #10）。
  return Promise.all(
    items
      .filter((item) => !isRssItemPdf(item))
      .map((item) => {
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
  // PDF は本文抽出・要約の対象にならないので取り込み段で除外する（issue #10）。
  return Promise.all(
    entries
      .filter((entry) => !isAtomEntryPdf(entry))
      .map((entry) => {
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
 * Medium の記事 URL から「正規のフィード URL」を導出する。ピュア関数。
 *
 * Medium 本体の HTML 記事ページ（人間向けパス）は Bot に 403 を返すが、フィード
 * （`/feed/*`）は 200 で `content:encoded`（全文）を返す。robots が拒否するのは
 * 学習・大規模収集クローラであり、私的・一過性・本文非保存の要約はフィード利用の
 * 対象外という判断（docs/07_content_based_pipeline_plan.md §アクセスの倫理）。
 *
 *  - `medium.com/@handle/…`         → `https://medium.com/feed/@handle`
 *  - `medium.com/{pub}/…`（`@` 無し）→ `https://medium.com/feed/{pub}`
 *  - `{sub}.medium.com/…`（`www`/裸 `medium.com` 以外）→ `https://{sub}.medium.com/feed`
 *  - それ以外 → null
 *
 * `www.medium.com` は source サブドメインではないので裸 `medium.com` と同じパス規則で扱う。
 */
export function deriveMediumFeedUrl(articleUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(articleUrl);
  } catch {
    return null;
  }
  const host = url.hostname;

  // {sub}.medium.com（www を除く）はサブドメインのフィードを持つ。
  if (host.endsWith(".medium.com") && host !== "www.medium.com") {
    return `https://${host}/feed`;
  }

  // 裸 medium.com / www.medium.com は先頭パスセグメント（@handle か publication）で引く。
  if (host === "medium.com" || host === "www.medium.com") {
    const first = url.pathname.split("/").find((segment) => segment !== "");
    if (first === undefined) {
      return null;
    }
    return `https://medium.com/feed/${first}`;
  }

  return null;
}

/**
 * 取得済み HTML から記事本文を抽出する。抽出カスケード（最初の非空を採用）:
 *  1. `main` の内側（多くの記事ページ）
 *  2. `article` の内側（Medium など main を持たないページ）
 *  3. ページ全体
 * 各段でナビ・フッタ・サイドバー・ヘッダを除外し、要約枠を boilerplate で浪費しない。
 * すべて空なら null。
 */
async function extractArticleBody(html: string): Promise<string | null> {
  const extractors = [
    () => htmlToText(html, { root: "main", exclude: BODY_EXCLUDE }),
    () => htmlToText(html, { root: "article", exclude: BODY_EXCLUDE }),
    () => htmlToText(html, { exclude: BODY_EXCLUDE }),
  ];
  for (const extract of extractors) {
    const text = await extract();
    if (text !== "") {
      return text;
    }
  }
  return null;
}

/**
 * Medium の正規フィード経由で本文を回収する。導出できない（非 Medium）URL は null。
 *
 * フィードはソース単位でキャッシュする（`mediumFeedCache`）。同一著者/publication の
 * 複数記事で 1 回だけ取得する。当日ウィンドウで絞らず `parseFeed` を直呼びし、403 で
 * 弾かれた過去記事の本文も拾う。取得失敗・パース失敗は空配列としてキャッシュし
 * （再取得を避ける）、一致 item 無し／本文無しは null（呼び出し側が通常ページ取得へ）。
 */
async function resolveMediumFeedBody(
  articleUrl: string,
  options?: FetchWithRetryOptions & {
    mediumFeedCache?: Map<string, NormalizedArticle[]>;
  },
): Promise<string | null> {
  const feedUrl = deriveMediumFeedUrl(articleUrl);
  if (feedUrl === null) {
    return null;
  }

  const cache =
    options?.mediumFeedCache ?? new Map<string, NormalizedArticle[]>();
  let articles = cache.get(feedUrl);
  if (articles === undefined) {
    articles = await fetchMediumFeed(feedUrl, options);
    cache.set(feedUrl, articles);
  }

  // parseFeed の url は normalizeUrl 済み。article.url も正規化済みなので直接比較する。
  const match = articles.find((a) => a.url === articleUrl);
  if (match?.body === undefined || match.body === "") {
    return null;
  }
  return match.body;
}

/** Medium フィードを取得してパースする。失敗はすべて空配列（＝本文回収を諦める）。 */
async function fetchMediumFeed(
  feedUrl: string,
  options?: FetchWithRetryOptions,
): Promise<NormalizedArticle[]> {
  let res: Response;
  try {
    res = await fetchWithRetry(
      feedUrl,
      { headers: { "user-agent": USER_AGENT } },
      options,
    );
  } catch {
    return [];
  }
  if (!res.ok) {
    return [];
  }
  try {
    return await parseFeed(await res.text(), feedUrl);
  } catch {
    return [];
  }
}

/**
 * 「実本文」を解決する。返すのは実本文か null のみ（feedSummary スニペットは返さない）。
 * 優先順:
 *  1. インライン全文（parseFeed が body に入れた content:encoded / content）
 *  2. Medium フィード導出 → `content:encoded` 全文（HTML ページを叩かない）
 *  3. 記事 URL を通常取得 → 抽出カスケード（main→article→全体）
 *  4. いずれも取れなければ null
 *
 * feedSummary（~100 字スニペット）は本文ではないので解決チェーンに入れない。スニペットへの
 * フォールバックは呼び出し側の責務（embedding は本文長で本文/スニペットを選び、summarize は
 * 本文 or スニペットに閾値を課す）。これは「ランキングも要約も本文由来」という core value に従う。
 *
 * ネットワークへ出るのは 2・3 のみ。1 に当たれば fetch しない。`mediumFeedCache` は
 * 呼び出し側が 1 step 内で 1 個生成し全記事で共有する（フィードをソース単位でキャッシュ）。
 * 渡されなければ関数内でローカル生成する（＝キャッシュは 1 記事内に閉じる）。
 */
export async function resolveArticleBody(
  article: Pick<NormalizedArticle, "url" | "feedSummary" | "body">,
  options?: FetchWithRetryOptions & {
    mediumFeedCache?: Map<string, NormalizedArticle[]>;
  },
): Promise<string | null> {
  if (article.body !== undefined && article.body !== "") {
    return article.body;
  }

  const mediumBody = await resolveMediumFeedBody(article.url, options);
  if (mediumBody !== null) {
    return mediumBody;
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
  return extractArticleBody(await res.text());
}
