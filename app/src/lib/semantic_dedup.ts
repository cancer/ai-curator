/**
 * 当日記事の意味的重複除去（貪欲クラスタリング）。
 *
 * 未割当記事を入力順に見て、既存クラスタの代表との cosine 類似が閾値以上なら
 * そのクラスタに合流させる。どの代表とも閾値未満なら新しいクラスタを作る。
 * cosine は embedding_model が一致するベクトル同士でのみ意味を持つため、
 * モデルが異なる記事は同一クラスタに合流しない。
 *
 * 代表 = ソース信頼度が最大の記事（同点なら公開日時が新しい方）。
 * 代表はフィードに残し、非代表は除外する（articles テーブルには残す）。
 */

import { cosine } from "./score";

/** クラスタリング対象記事。id は articles.id。 */
export interface DedupArticle {
  id: number;
  vector: number[];
  model: string;
  /** 代表選出用のソース信頼度。 */
  sourceTrust: number;
  /** 代表選出の同点処理用（ISO 8601）。 */
  publishedAt: string;
}

export interface DedupResult {
  /** 各クラスタ代表の id（フィードに残す）。 */
  keptIds: number[];
  /** 非代表の id（フィードから除外）。 */
  excludedIds: number[];
}

interface Cluster {
  members: DedupArticle[];
  representative: DedupArticle;
}

/** a より b の方が代表にふさわしいか（信頼度優先・同点は新しい方）。 */
function prefersOverRepresentative(a: DedupArticle, b: DedupArticle): boolean {
  if (b.sourceTrust !== a.sourceTrust) {
    return b.sourceTrust > a.sourceTrust;
  }
  return b.publishedAt > a.publishedAt;
}

export function clusterArticles(
  articles: DedupArticle[],
  threshold: number,
): DedupResult {
  const clusters: Cluster[] = [];

  for (const article of articles) {
    const target = clusters.find(
      (cluster) =>
        cluster.representative.model === article.model &&
        cosine(article.vector, cluster.representative.vector) >= threshold,
    );

    if (target === undefined) {
      clusters.push({ members: [article], representative: article });
      continue;
    }

    target.members.push(article);
    if (prefersOverRepresentative(target.representative, article)) {
      target.representative = article;
    }
  }

  const keptIds: number[] = [];
  const excludedIds: number[] = [];
  for (const cluster of clusters) {
    for (const member of cluster.members) {
      if (member.id === cluster.representative.id) {
        keptIds.push(member.id);
      } else {
        excludedIds.push(member.id);
      }
    }
  }

  return { keptIds, excludedIds };
}
