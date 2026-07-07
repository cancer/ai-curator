/**
 * 正規化済み記事。docs/02_specification.md §3 の共通スキーマに対応する。
 * body は法務方針 (docs/01_requirements.md NFR-2) により永続化禁止。
 * パイプライン処理中のみメモリに保持する。
 */
export interface NormalizedArticle {
  url: string;
  title: string;
  source: string;
  publishedAt: string;
  feedSummary?: string;
  body?: string;
}
