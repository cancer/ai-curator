/**
 * Feed Builder パイプライン（Cron B）。1 日 1 回、過去 24 時間の記事から
 * フィード（feed_entries）と軸別の傾向（feed_trends）を構築する。
 *
 * 厳守:
 * - 記事本文(body)は D1・KV・ログに書かない。body は要約生成のため一時的に
 *   メモリで扱うのみ。保存してよいのは自前生成の要約(feed_entries.summary)・
 *   傾向叙述(feed_trends.narrative)・自前計算の embedding/score/hit_axis のみ。
 * - embedding は JSON 数値配列 + embedding_model を併記する。
 * - 同日再実行に備え feed_entries / feed_trends は当日分を delete してから insert。
 *
 * 処理順:
 *  1. 関心軸同期  2. 対象記事ロード  3. Embedding（未生成のみ）
 *  4. 意味的 Dedup  5. スコアリング  6. feed_entries 書き込み
 *  7. 上位要約  8. 傾向サマリ
 *
 * 「対象記事」= step3 の embedding 対象（過去 24h かつ embedding IS NULL）。
 * 「当日記事」= フィードの作業集合（過去 24h の記事全体）。両者を分けるのは、
 * 同日再実行時に embedding は既に埋まっていても、当日記事全体から
 * フィードを再構築できる必要があるため（idempotency）。
 */

import type { Env } from "../index";
import { type Config, loadConfig } from "../config";
import type { NormalizedArticle } from "../adapters/types";
import { embed, syncInterestAxes } from "../lib/embedding";
import {
  type AxisVector,
  freshness,
  interestScore,
  score,
  sourceTrust,
} from "../lib/score";
import { clusterArticles, type DedupArticle } from "../lib/semantic_dedup";
import {
  summarizeTopEntries,
  summarizeTrend,
  type SummaryTarget,
} from "../lib/summarize";
import { fetchReleases } from "../adapters/github";
import { fetchAuthorFeed } from "../adapters/medium";
import { fetchArticleBody } from "../adapters/fowler";

/** 本文再取得アダプタ（テストで差し替え可能にするため注入する）。 */
export interface BodyFetchers {
  fetchReleases(owner: string, repo: string): Promise<NormalizedArticle[]>;
  fetchAuthorFeed(author: string): Promise<NormalizedArticle[]>;
  fetchArticleBody(url: string): Promise<string>;
}

const defaultBodyFetchers: BodyFetchers = {
  fetchReleases: (owner, repo) => fetchReleases(owner, repo),
  fetchAuthorFeed: (author) => fetchAuthorFeed(author),
  fetchArticleBody: (url) => fetchArticleBody(url),
};

export interface FeedBuilderDeps {
  db?: D1Database;
  loadConfig?: (env: Env) => Promise<Config>;
  syncInterestAxes?: typeof syncInterestAxes;
  embed?: typeof embed;
  /** 記事間の待機（既定 150ms）。テストで no-op に差し替える。 */
  sleep?: (ms: number) => Promise<void>;
  bodyFetchers?: BodyFetchers;
  now?: () => Date;
}

/** embedding 呼び出しの間隔（レート制御）。 */
const EMBED_SPACING_MS = 150;

/** 過去 24 時間の記事（フィード作業集合）。body 列は存在しないため取得しない。 */
const WORKING_SET_SQL =
  "SELECT id, title, source, url, published_at, feed_summary, embedding, embedding_model " +
  "FROM articles WHERE created_at >= datetime('now', '-1 day')";

const AXES_SQL = "SELECT axis_id, embedding, embedding_model FROM interest_axes";

interface ArticleRow {
  id: number;
  title: string;
  source: string;
  url: string;
  published_at: string;
  feed_summary: string | null;
  embedding: string | null;
  embedding_model: string | null;
}

interface AxisRow {
  axis_id: string;
  embedding: string;
  embedding_model: string;
}

/** embedding が確定した記事（ベクトルはパース済み）。 */
interface EmbeddedArticle {
  id: number;
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  feedSummary: string | null;
  vector: number[];
  model: string;
}

/** embedding 入力は title + "\n" + feedSummary（本文は足さない）。 */
function embeddingInput(row: { title: string; feed_summary: string | null }): string {
  return `${row.title}\n${row.feed_summary ?? ""}`;
}

/** source と url から本文を再取得する。取得できない種別・不一致は null。 */
async function resolveBody(
  target: SummaryTarget,
  fetchers: BodyFetchers,
): Promise<string | null> {
  const { source, url } = target;

  if (source.startsWith("github:")) {
    const [owner, repo] = source.slice("github:".length).split("/");
    const releases = await fetchers.fetchReleases(owner, repo);
    return releases.find((r) => r.url === url)?.body ?? null;
  }

  if (source === "fowler") {
    return fetchers.fetchArticleBody(url);
  }

  if (source.startsWith("medium:@")) {
    const author = source.slice("medium:@".length);
    const articles = await fetchers.fetchAuthorFeed(author);
    return articles.find((a) => a.url === url)?.body ?? null;
  }

  // hn / medium:tag は本文が無い。feedSummary へフォールバックさせる。
  return null;
}

export async function runFeedBuilder(
  env: Env,
  deps: FeedBuilderDeps = {},
): Promise<void> {
  const db = deps.db ?? env.DB;
  const load = deps.loadConfig ?? loadConfig;
  const sync = deps.syncInterestAxes ?? syncInterestAxes;
  const runEmbed = deps.embed ?? embed;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const fetchers = deps.bodyFetchers ?? defaultBodyFetchers;
  const now = deps.now ?? (() => new Date());
  // 実行時刻は 1 回だけ確定させ、freshness と feed の date で同じ値を使う。
  const runAt = now();

  const config = await load(env);
  // 種別→信頼度の表。score.ts は汎用の Record を受けるため一度だけ変換する。
  const trustTable: Record<string, number> = { ...config.scoring.sourceTrust };

  // 1. 関心軸同期（seed 変更・モデル変更を検知して upsert）。
  await sync(db, env.AI, config.interestAxes, config.embedding.model);

  // 2. 対象記事ロード（過去 24h の記事全体 = 当日記事）。
  const rows =
    (await db.prepare(WORKING_SET_SQL).all<ArticleRow>()).results ?? [];

  // 3. Embedding: embedding が未生成の記事を 1 件ずつ埋める（150ms 間隔）。
  //    1 記事の失敗（embed のリトライ後もエラー）はログに残してスキップし、
  //    embedding は NULL のまま。全記事失敗でも throw せず継続する
  //    （Cron A の「1 ソース失敗で止めない」と同じレジリエンス方針）。
  const pending = rows.filter((r) => r.embedding === null);
  let embedFailed = 0;
  for (let i = 0; i < pending.length; i++) {
    if (i > 0) {
      await sleep(EMBED_SPACING_MS);
    }
    const row = pending[i];
    try {
      const result = await runEmbed(
        env.AI,
        config.embedding.model,
        embeddingInput(row),
        config.embedding.maxInputChars,
      );
      const vectorJson = JSON.stringify(result.vector);
      await db
        .prepare(
          "UPDATE articles SET embedding = ?, embedding_model = ? WHERE id = ?",
        )
        .bind(vectorJson, config.embedding.model, row.id)
        .run();
      row.embedding = vectorJson;
      row.embedding_model = config.embedding.model;
    } catch (err) {
      embedFailed += 1;
      console.warn(
        `feed: embedding failed for article ${row.id}; skipping: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // フィード構築対象は embedding を持ち、かつ現行モデルで生成された記事のみ。
  // 埋め込めなかった記事（embedding NULL）と、モデル不一致で cosine 比較
  // できない記事は今日のフィードから除外する（articles には残す）。
  const embedded: EmbeddedArticle[] = rows
    .filter(
      (r) =>
        r.embedding !== null && r.embedding_model === config.embedding.model,
    )
    .map((r) => ({
      id: r.id,
      title: r.title,
      source: r.source,
      url: r.url,
      publishedAt: r.published_at,
      feedSummary: r.feed_summary,
      vector: JSON.parse(r.embedding as string) as number[],
      model: r.embedding_model as string,
    }));

  // 4. 意味的 Dedup（当日記事同士）。非代表はフィードから除外する。
  const dedupInput: DedupArticle[] = embedded.map((a) => ({
    id: a.id,
    vector: a.vector,
    model: a.model,
    sourceTrust: sourceTrust(a.source, trustTable),
    publishedAt: a.publishedAt,
  }));
  const { keptIds } = clusterArticles(
    dedupInput,
    config.scoring.semanticDedupThreshold,
  );
  const keptSet = new Set(keptIds);
  const kept = embedded.filter((a) => keptSet.has(a.id));

  // 5. スコアリング。関心軸ベクトルを読み、各代表記事のスコアと hit_axis を求める。
  const axisRows = (await db.prepare(AXES_SQL).all<AxisRow>()).results ?? [];
  const axisVectors: AxisVector[] = axisRows.map((r) => ({
    axisId: r.axis_id,
    vector: JSON.parse(r.embedding) as number[],
    model: r.embedding_model,
  }));

  interface Scored {
    article: EmbeddedArticle;
    score: number;
    hitAxis: string | null;
  }
  const scored: Scored[] = kept.map((a) => {
    const interest = interestScore(a.vector, a.model, axisVectors);
    const components = {
      interest: interest.interest,
      freshness: freshness(
        a.publishedAt,
        runAt,
        config.scoring.freshnessHalfLifeDays,
      ),
      sourceTrust: sourceTrust(a.source, trustTable),
    };
    return {
      article: a,
      score: score(components, config.scoring.weights),
      hitAxis: interest.hitAxis,
    };
  });

  for (const s of scored) {
    await db
      .prepare("UPDATE articles SET score = ?, hit_axis = ? WHERE id = ?")
      .bind(s.score, s.hitAxis, s.article.id)
      .run();
  }

  // 6. feed_entries 書き込み。スコア降順に rank 1..N。当日分を delete してから insert。
  const ranked = [...scored].sort((a, b) => b.score - a.score);
  const date = runAt.toISOString().slice(0, 10);

  await db.prepare("DELETE FROM feed_entries WHERE date = ?").bind(date).run();
  for (let i = 0; i < ranked.length; i++) {
    await db
      .prepare(
        "INSERT INTO feed_entries (date, article_id, rank) VALUES (?, ?, ?)",
      )
      .bind(date, ranked[i].article.id, i + 1)
      .run();
  }

  // 7. 上位 N 件の要約。本文を再取得（失敗は feedSummary フォールバック）して LLM 要約。
  const topTargets: SummaryTarget[] = ranked
    .slice(0, config.digest.summaryTopN)
    .map((s) => ({
      articleId: s.article.id,
      title: s.article.title,
      source: s.article.source,
      url: s.article.url,
      feedSummary: s.article.feedSummary,
    }));
  const { summaries } = await summarizeTopEntries(
    env.AI,
    config.digest,
    topTargets,
    (target) => resolveBody(target, fetchers),
  );
  for (const [articleId, summary] of summaries) {
    await db
      .prepare(
        "UPDATE feed_entries SET summary = ? WHERE date = ? AND article_id = ?",
      )
      .bind(summary, date, articleId)
      .run();
  }

  // 8. 傾向サマリ。軸ごとに hit_count を集計し、上位タイトルから叙述を生成する。
  await db.prepare("DELETE FROM feed_trends WHERE date = ?").bind(date).run();
  for (const axis of config.interestAxes) {
    const axisHits = ranked.filter((s) => s.hitAxis === axis.id);
    const hitCount = axisHits.length;
    const narrative =
      hitCount === 0
        ? null
        : await summarizeTrend(
            env.AI,
            config.digest.model,
            config.digest.maxOutputTokens,
            axis.label,
            axisHits.slice(0, 10).map((s) => s.article.title),
          );
    await db
      .prepare(
        "INSERT INTO feed_trends (date, axis_id, hit_count, narrative) VALUES (?, ?, ?, ?)",
      )
      .bind(date, axis.id, hitCount, narrative)
      .run();
  }

  console.log(
    `feed: ${JSON.stringify({
      date,
      embedTargets: pending.length,
      embedFailed,
      candidates: embedded.length,
      excludedFromFeed: rows.length - embedded.length,
      feedEntries: ranked.length,
      summarized: summaries.size,
    })}`,
  );
}
