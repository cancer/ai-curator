/**
 * 全文 HTML を含むフィード（Fowler atom の content / Medium の content:encoded）は
 * エスケープされた HTML 中に予約済みエンティティ（&lt; &amp; &#39; など）を数千個含む。
 * fast-xml-parser の既定 maxTotalExpansions=1000 を超えて parse が失敗するため、
 * フラットな展開回数の上限だけを引き上げる。再帰的な DOCTYPE エンティティによる
 * billion-laughs は maxExpansionDepth を既定の厳しい値のまま残すことで防ぐ。
 */
export const FEED_ENTITY_OPTIONS = {
  processEntities: { maxTotalExpansions: 1_000_000, maxExpansionDepth: 10 },
} as const;
