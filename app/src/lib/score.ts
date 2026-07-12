/**
 * スコアリングの純粋関数群（Cron B が使う）。
 *
 * score = interest×w.interest + freshness×w.freshness + sourceTrust×w.sourceTrust
 * （重みは config.scoring.weights。既定は 0.6 / 0.3 / 0.1）。
 *
 * cosine は embedding_model が一致するベクトル同士でのみ意味を持つ。
 * モデル不一致の軸は interestScore で比較対象から除外する。
 */

import type { ScoringWeights } from "../config";

/** 関心軸のベクトル。model は生成に使った embedding モデル名。 */
export interface AxisVector {
  axisId: string;
  vector: number[];
  model: string;
}

export interface InterestResult {
  /** 各軸との cosine の最大値（比較対象が無ければ 0）。 */
  interest: number;
  /** 最大 cosine を与えた軸 id（比較対象が無ければ null）。 */
  hitAxis: string | null;
}

export interface ScoreComponents {
  interest: number;
  freshness: number;
  sourceTrust: number;
}

/** コサイン類似度。次元不一致・どちらかがゼロベクトルなら 0。 */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 公開日時から現在までの経過による指数減衰。0.5 ^ (経過日数 / 半減期日数)。 */
export function freshness(
  publishedAt: string,
  now: Date,
  halfLifeDays: number,
): number {
  // 未来日時の publishedAt で freshness > 1 になるのを防ぐため 0 でクランプする。
  const elapsedDays = Math.max(
    0,
    (now.getTime() - new Date(publishedAt).getTime()) / DAY_MS,
  );
  return Math.pow(0.5, elapsedDays / halfLifeDays);
}

/** source 文字列の ':' より前を種別とし、信頼度表から引く。未知種別は 0。 */
export function sourceTrust(
  source: string,
  trust: Record<string, number>,
): number {
  const kind = source.split(":")[0];
  return trust[kind] ?? 0;
}

/**
 * 記事ベクトルと各関心軸ベクトルの cosine 最大値と、それを与えた軸 id。
 * embedding_model が一致する軸のみを比較する。
 */
export function interestScore(
  articleVector: number[],
  articleModel: string,
  axes: AxisVector[],
): InterestResult {
  let interest = 0;
  let hitAxis: string | null = null;
  for (const axis of axes) {
    if (axis.model !== articleModel) {
      continue;
    }
    const sim = cosine(articleVector, axis.vector);
    if (hitAxis === null || sim > interest) {
      interest = sim;
      hitAxis = axis.axisId;
    }
  }
  return { interest, hitAxis };
}

/** 3 成分を重み付き線形結合した総合スコア。 */
export function score(
  components: ScoreComponents,
  weights: ScoringWeights,
): number {
  return (
    weights.interest * components.interest +
    weights.freshness * components.freshness +
    weights.sourceTrust * components.sourceTrust
  );
}
