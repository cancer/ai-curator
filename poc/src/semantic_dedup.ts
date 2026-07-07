/**
 * 意味的 Dedup（docs/02_specification.md §4-2）。Embedding 後に cosine 類似が閾値以上の
 * 記事をクラスタ化し、クラスタごとに priority 最大の 1 本を代表として残す。
 * 件数は 1 日分に絞られる前提のため、素朴な全ペア比較で足りる（docs/03_design.md §2.3）。
 */
import { cosineSimilarity } from "./score";

export function semanticDedup<T>(
  items: readonly T[],
  toVector: (item: T) => readonly number[],
  threshold: number,
  priority: (item: T) => number,
): T[] {
  const clusters: T[][] = [];
  for (const item of items) {
    const vector = toVector(item);
    const cluster = clusters.find((c) =>
      c.some((member) => cosineSimilarity(vector, toVector(member)) >= threshold),
    );
    if (cluster) {
      cluster.push(item);
    } else {
      clusters.push([item]);
    }
  }
  return clusters.map((cluster) =>
    cluster.reduce((best, item) =>
      priority(item) > priority(best) ? item : best,
    ),
  );
}
