/**
 * スコアリング（docs/02_specification.md §6）。
 * score = 関心類似 × w1 + 鮮度 × w2 + ソース信頼度 × w3。
 * 各成分は 0〜1（関心類似の cosine のみ理論上 -1〜1）に揃え、重みが素直に効くようにする。
 */

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosine: dimension mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) throw new Error("cosine: zero vector");
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** 公開日時からの経過に対する指数減衰。半減期 halfLifeDays でちょうど 0.5。 */
export function freshnessDecay(
  publishedAt: string,
  now: Date,
  halfLifeDays: number,
): number {
  const ageDays = (now.getTime() - Date.parse(publishedAt)) / MS_PER_DAY;
  if (ageDays <= 0) return 1;
  return Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
}

/**
 * ソース信頼度を解決する。完全一致を優先し、無ければ ":" より前の接頭辞で引く。
 * どちらでも引けない場合は例外（未知ソースはバグとして早期に失敗させる）。
 */
export function resolveSourceTrust(
  source: string,
  table: Readonly<Record<string, number>>,
): number {
  const exact = table[source];
  if (exact !== undefined) return exact;
  const prefix = source.split(":")[0]!;
  const byPrefix = table[prefix];
  if (byPrefix !== undefined) return byPrefix;
  throw new Error(`resolveSourceTrust: unknown source "${source}"`);
}

export interface AxisVector {
  id: string;
  vector: readonly number[];
}

/** 記事ベクトルと各関心軸ベクトルの cosine の最大値と、それを与えた軸（ヒット軸）。 */
export function interestSimilarity(
  articleVector: readonly number[],
  axes: readonly AxisVector[],
): { similarity: number; hitAxisId: string } {
  let best = { similarity: Number.NEGATIVE_INFINITY, hitAxisId: axes[0]!.id };
  for (const axis of axes) {
    const similarity = cosineSimilarity(articleVector, axis.vector);
    if (similarity > best.similarity) best = { similarity, hitAxisId: axis.id };
  }
  return best;
}

export interface ScoreComponents {
  interest: number;
  freshness: number;
  sourceTrust: number;
}

export interface ScoreWeights {
  w1: number;
  w2: number;
  w3: number;
}

export function computeScore(c: ScoreComponents, w: ScoreWeights): number {
  return c.interest * w.w1 + c.freshness * w.w2 + c.sourceTrust * w.w3;
}
