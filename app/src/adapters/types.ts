/**
 * ソースアダプタ共通の型と、複数アダプタで使う小さなパース補助。
 *
 * 各アダプタは「純粋な parse 関数（fixture でテスト可能）」と
 * 「fetchWithRetry で取得して parse を呼ぶ fetch 関数」を分離する。
 */

/**
 * 正規化済みの記事。すべてのアダプタはこの形に揃えて返す。
 *
 * body は本文全文であり一時データ。メモリ上でのみ扱い、D1・KV・ログには書かない。
 */
export interface NormalizedArticle {
  /** normalizeUrl 済みの URL */
  url: string;
  title: string;
  /**
   * ソース識別子（例: `feed:{url}`）。
   * sourceTrust は `:` より前で引く（`feed:https://...`→`feed`）。
   */
  source: string;
  /** ISO 8601 */
  publishedAt: string;
  feedSummary?: string;
  /** 本文全文。一時データ。D1 に書いてはならない。 */
  body?: string;
}

/**
 * fast-xml-parser は要素が 1 個なら単一オブジェクト、複数なら配列を返す。
 * 呼び出し側が常に配列として扱えるように正規化する。
 */
export function ensureArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

/**
 * 当日ウィンドウ（publishedAt >= windowStart）の記事だけを残す。
 * feed は取得分からこの関数で当日分に絞る。
 */
export function withinWindow(
  articles: NormalizedArticle[],
  windowStart: Date,
): NormalizedArticle[] {
  return articles.filter(
    (article) => new Date(article.publishedAt) >= windowStart,
  );
}
