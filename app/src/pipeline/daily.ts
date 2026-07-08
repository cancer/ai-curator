/**
 * 日次パス（cron 1 本・1 日 1 回）。取得〜要約を単一パスに統合する。
 *
 * 厳守（原文非永続）:
 * - 原文テキスト（記事本文 body・フィード提供の要約/スニペット feedSummary）を
 *   D1・KV・ログに一切書かない。永続化するのは metadata（url/title/source/
 *   published_at）・content_hash・embedding(+embedding_model)・score・hit_axis・
 *   自前生成の summary/narrative のみ。
 * - body / feedSummary は同一パス内でメモリに保持して使い回すだけ。
 *
 * 処理順:
 *  1. loadConfig
 *  2. 全ソース全件取得（当日ウィンドウ）→ NormalizedArticle[]（feedSummary/body をメモリ保持）
 *  3. SimHash Dedup → articles にメタのみ INSERT（ON CONFLICT DO NOTHING）
 *  4. 関心軸同期
 *  5. Embedding（当日ウィンドウ・embedding 未生成のみ。入力はメモリの feedSummary）
 *  6. 意味的 Dedup → スコアリング → feed_entries 当日分 delete→insert
 *  7. 全件要約（body はメモリ or fowler/hn を取得）→ feed_entries.summary
 *  8. 傾向サマリ feed_trends（当日分 delete→insert）
 *
 * レジリエンス: ソース単位 try/catch（全滅時のみ throw）、embedding は per-article
 * スキップ継続、要約は per-item try/catch、narrative は per-axis try/catch。
 */

import type { Env } from "../index";
import { type Config, loadConfig } from "../config";
import type { NormalizedArticle } from "../adapters/types";
import { simhash, hammingDistance, SIMHASH_DUP_DISTANCE } from "../lib/simhash";
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
  summarizeEntries,
  summarizeTrend,
  type SummaryTarget,
} from "../lib/summarize";
import { fetchReleases } from "../adapters/github";
import { fetchStories, fetchArticleBody as fetchHnArticleBody } from "../adapters/hn";
import { fetchAuthorFeed, fetchTagFeed } from "../adapters/medium";
import {
  fetchFowlerFeed,
  fetchArticleBody as fetchFowlerArticleBody,
} from "../adapters/fowler";

/** 当日ウィンドウの長さ（時間）。下限 = 実行時刻 - この時間。 */
const WINDOW_HOURS = 24;

/** embedding 呼び出しの間隔（レート制御）。 */
const EMBED_SPACING_MS = 150;

/**
 * fowler 記事ページの連続 fetch に空ける最小間隔（計画タスク 5(d)
 * 「連続アクセスは 1 秒以上間隔を空ける」）。fowler 以外のソースには不要。
 */
const FOWLER_ARTICLE_SPACING_MS = 1000;

/**
 * 各ソースの当日分を取得する関数群（テストで差し替え可能にするため注入する）。
 * いずれも windowStart（当日ウィンドウ下限）を受け取り、その範囲内を全件返す。
 */
export interface Fetchers {
  fetchReleases(
    owner: string,
    repo: string,
    windowStart: Date,
  ): Promise<NormalizedArticle[]>;
  fetchStories(minPoints: number, windowStart: Date): Promise<NormalizedArticle[]>;
  fetchAuthorFeed(author: string, windowStart: Date): Promise<NormalizedArticle[]>;
  fetchTagFeed(tag: string, windowStart: Date): Promise<NormalizedArticle[]>;
  fetchFowlerFeed(windowStart: Date): Promise<NormalizedArticle[]>;
}

const defaultFetchers: Fetchers = {
  fetchReleases: (owner, repo, windowStart) =>
    fetchReleases(owner, repo, windowStart),
  fetchStories: (minPoints, windowStart) => fetchStories(minPoints, windowStart),
  fetchAuthorFeed: (author, windowStart) => fetchAuthorFeed(author, windowStart),
  fetchTagFeed: (tag, windowStart) => fetchTagFeed(tag, windowStart),
  fetchFowlerFeed: (windowStart) => fetchFowlerFeed(windowStart),
};

/**
 * 要約段でリンク先/記事ページ本文を取得する関数群（テストで差し替え可能）。
 * github の release note と medium 著者本文はメモリにあるためここには含めない
 * （前段でメモリ保持した body を使う）。
 */
export interface BodyFetchers {
  fetchFowlerBody(url: string): Promise<string>;
  fetchHnBody(url: string): Promise<string>;
}

const defaultBodyFetchers: BodyFetchers = {
  fetchFowlerBody: (url) => fetchFowlerArticleBody(url),
  fetchHnBody: (url) => fetchHnArticleBody(url),
};

/** 1 ソース分の取得タスク。label は失敗ログ・サマリ用の識別子。 */
export interface SourceTask {
  label: string;
  fetch: () => Promise<NormalizedArticle[]>;
}

export interface DailyDeps {
  db?: D1Database;
  fetchers?: Fetchers;
  bodyFetchers?: BodyFetchers;
  loadConfig?: (env: Env) => Promise<Config>;
  syncInterestAxes?: typeof syncInterestAxes;
  embed?: typeof embed;
  /** 各種待機（既定 setTimeout）。テストで no-op に差し替える。 */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/** config.sources を、順序を保ったソースタスク列に展開する（windowStart 注入込み）。 */
export function buildSourceTasks(
  config: Config,
  fetchers: Fetchers,
  windowStart: Date,
): SourceTask[] {
  const { sources } = config;
  const tasks: SourceTask[] = [];

  for (const repo of sources.githubRepos) {
    const [owner, name] = repo.split("/");
    tasks.push({
      label: `github:${repo}`,
      fetch: () => fetchers.fetchReleases(owner, name, windowStart),
    });
  }

  tasks.push({
    label: "hn",
    fetch: () => fetchers.fetchStories(sources.hnMinPoints, windowStart),
  });

  for (const feed of sources.mediumAuthorFeeds) {
    const author = feed.replace(/^@/, "");
    tasks.push({
      label: `medium:@${author}`,
      fetch: () => fetchers.fetchAuthorFeed(author, windowStart),
    });
  }

  for (const tag of sources.mediumTagFeeds) {
    tasks.push({
      label: `medium:tag/${tag}`,
      fetch: () => fetchers.fetchTagFeed(tag, windowStart),
    });
  }

  if (sources.fowlerFeed) {
    tasks.push({
      label: "fowler",
      fetch: () => fetchers.fetchFowlerFeed(windowStart),
    });
  }

  return tasks;
}

/** 直近 7 日で保存済みの content_hash（重複判定の初期集合）。 */
const RECENT_HASHES_SQL =
  "SELECT content_hash FROM articles " +
  "WHERE content_hash IS NOT NULL AND created_at >= datetime('now', '-7 days')";

/**
 * 保存する列は url/title/source/published_at/content_hash のみ。
 * feed_summary 列は廃止したので入れない（原文非永続）。
 */
const INSERT_SQL =
  "INSERT INTO articles (url, title, source, published_at, content_hash) " +
  "VALUES (?, ?, ?, ?, ?) " +
  "ON CONFLICT(url) DO NOTHING";

/** 過去 24 時間の記事（フィード作業集合）。feed_summary 列は存在しない。 */
const WORKING_SET_SQL =
  "SELECT id, title, source, url, published_at, embedding, embedding_model " +
  "FROM articles WHERE created_at >= datetime('now', '-1 day')";

const AXES_SQL = "SELECT axis_id, embedding, embedding_model FROM interest_axes";

interface ArticleRow {
  id: number;
  title: string;
  source: string;
  url: string;
  published_at: string;
  embedding: string | null;
  embedding_model: string | null;
}

interface AxisRow {
  axis_id: string;
  embedding: string;
  embedding_model: string;
}

/** embedding が確定した記事（ベクトル + メモリ保持の原文テキスト）。 */
interface EmbeddedArticle {
  id: number;
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  /** メモリ保持のフィード提供テキスト（DB には無い）。 */
  feedSummary: string | null;
  /** メモリ保持の本文（github release note / medium content:encoded）。DB には無い。 */
  body: string | null;
  vector: number[];
  model: string;
}

/** SimHash の入力（保存対象の title + メモリの feedSummary）。 */
function hashInput(article: NormalizedArticle): string {
  return `${article.title} ${article.feedSummary ?? ""}`;
}

/** embedding 入力は title + "\n" + メモリの feedSummary（本文は足さない）。 */
function embeddingInput(title: string, feedSummary: string | null): string {
  return `${title}\n${feedSummary ?? ""}`;
}

/** HN self-post（外部リンクなし）の判定。item ページは要約に使わない。 */
function isHackerNewsItemUrl(url: string): boolean {
  return url.includes("news.ycombinator.com/item");
}

/**
 * 本文リゾルバを作る。単一パスなのでメモリ保持した body（github/medium 著者）が
 * あればそれを使い、無いものだけ取得する:
 * - fowler: 記事ページを抽出。連続 fetch は FOWLER_ARTICLE_SPACING_MS 以上空ける。
 * - hn: 外部リンクを粗抽出（self-post = item ページは取得せず story_text へ）。
 * 取得できない/空は null を返し、summarizeEntries が feedSummary→title に落とす。
 */
export function makeBodyResolver(
  memById: Map<number, { body: string | null }>,
  bodyFetchers: BodyFetchers,
  sleep: (ms: number) => Promise<void>,
): (target: SummaryTarget) => Promise<string | null> {
  let fowlerFetched = false;
  return async (target) => {
    const memory = memById.get(target.articleId);
    if (memory?.body) {
      return memory.body;
    }

    if (target.source === "fowler") {
      if (fowlerFetched) {
        await sleep(FOWLER_ARTICLE_SPACING_MS);
      }
      fowlerFetched = true;
      const body = await bodyFetchers.fetchFowlerBody(target.url);
      return body === "" ? null : body;
    }

    if (target.source === "hn") {
      if (isHackerNewsItemUrl(target.url)) {
        return null;
      }
      const body = await bodyFetchers.fetchHnBody(target.url);
      return body === "" ? null : body;
    }

    return null;
  };
}

export async function runDaily(env: Env, deps: DailyDeps = {}): Promise<void> {
  const db = deps.db ?? env.DB;
  const fetchers = deps.fetchers ?? defaultFetchers;
  const bodyFetchers = deps.bodyFetchers ?? defaultBodyFetchers;
  const load = deps.loadConfig ?? loadConfig;
  const sync = deps.syncInterestAxes ?? syncInterestAxes;
  const runEmbed = deps.embed ?? embed;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date());

  // 実行時刻は 1 回だけ確定させ、window 下限・freshness・feed の date で同じ値を使う。
  const runAt = now();
  const windowStart = new Date(runAt.getTime() - WINDOW_HOURS * 3600 * 1000);

  const config = await load(env);
  const trustTable: Record<string, number> = { ...config.scoring.sourceTrust };

  // 2. 全ソース全件取得。1 ソースの失敗は握って続行、全滅時のみ throw。
  const tasks = buildSourceTasks(config, fetchers, windowStart);
  const fetched: NormalizedArticle[] = [];
  const failedSources: string[] = [];
  for (const task of tasks) {
    try {
      fetched.push(...(await task.fetch()));
    } catch (err) {
      failedSources.push(task.label);
      console.warn(
        `daily: source ${task.label} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (tasks.length > 0 && failedSources.length === tasks.length) {
    throw new Error(
      `daily: all ${tasks.length} source(s) failed: ${failedSources.join(", ")}`,
    );
  }

  // url → 取得済み記事（feedSummary/body をメモリ保持）。後続段はここから引く。
  const memByUrl = new Map<string, NormalizedArticle>();
  for (const article of fetched) {
    memByUrl.set(article.url, article);
  }

  // 3. SimHash Dedup → メタのみ INSERT（feed_summary は入れない）。
  const recent = await db
    .prepare(RECENT_HASHES_SQL)
    .all<{ content_hash: string }>();
  const knownHashes = (recent.results ?? []).map((row) => row.content_hash);

  let inserted = 0;
  let duplicateSkipped = 0;
  for (const article of fetched) {
    const hash = simhash(hashInput(article));
    const isDuplicate = knownHashes.some(
      (known) => hammingDistance(known, hash) <= SIMHASH_DUP_DISTANCE,
    );
    if (isDuplicate) {
      duplicateSkipped += 1;
      continue;
    }
    knownHashes.push(hash);
    const result = await db
      .prepare(INSERT_SQL)
      .bind(
        article.url,
        article.title,
        article.source,
        article.publishedAt,
        hash,
      )
      .run();
    inserted += result.meta?.changes ?? 0;
  }

  // 4. 関心軸同期（seed 変更・モデル変更を検知して upsert）。
  await sync(db, env.AI, config.interestAxes, config.embedding.model);

  // 5. 対象記事ロード（過去 24h の記事全体 = 当日記事）。
  const rows =
    (await db.prepare(WORKING_SET_SQL).all<ArticleRow>()).results ?? [];

  // Embedding: embedding 未生成の記事を 1 件ずつ埋める（150ms 間隔）。入力の
  // feedSummary はメモリ保持値。1 記事の失敗はスキップ継続（embedding は NULL のまま）。
  const pending = rows.filter((r) => r.embedding === null);
  let embedFailed = 0;
  for (let i = 0; i < pending.length; i++) {
    if (i > 0) {
      await sleep(EMBED_SPACING_MS);
    }
    const row = pending[i];
    const feedSummary = memByUrl.get(row.url)?.feedSummary ?? null;
    try {
      const result = await runEmbed(
        env.AI,
        config.embedding.model,
        embeddingInput(row.title, feedSummary),
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
        `daily: embedding failed for article ${row.id}; skipping: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // フィード構築対象は embedding を持ち現行モデルで生成された記事のみ。
  const embedded: EmbeddedArticle[] = rows
    .filter(
      (r) =>
        r.embedding !== null && r.embedding_model === config.embedding.model,
    )
    .map((r) => {
      const memory = memByUrl.get(r.url);
      return {
        id: r.id,
        title: r.title,
        source: r.source,
        url: r.url,
        publishedAt: r.published_at,
        feedSummary: memory?.feedSummary ?? null,
        body: memory?.body ?? null,
        vector: JSON.parse(r.embedding as string) as number[],
        model: r.embedding_model as string,
      };
    });

  // 6. 意味的 Dedup（当日記事同士）。非代表はフィードから除外する。
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

  // スコアリング。関心軸ベクトルを読み、各代表記事のスコアと hit_axis を求める。
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

  // feed_entries 書き込み。スコア降順に rank 1..N。当日分を delete してから insert。
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

  // 7. 全件の要約。本文はメモリ or fowler/hn 取得（失敗は feedSummary→title）。
  const memById = new Map<number, { body: string | null }>(
    embedded.map((a) => [a.id, { body: a.body }]),
  );
  const targets: SummaryTarget[] = ranked.map((s) => ({
    articleId: s.article.id,
    title: s.article.title,
    source: s.article.source,
    url: s.article.url,
    feedSummary: s.article.feedSummary,
  }));
  const { summaries, failed: summaryFailed } = await summarizeEntries(
    env.AI,
    config.digest,
    targets,
    makeBodyResolver(memById, bodyFetchers, sleep),
    sleep,
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
  // narrative 生成は軸ごとに try/catch（1 軸失敗で当日 feed_trends 全体を失わない）。
  await db.prepare("DELETE FROM feed_trends WHERE date = ?").bind(date).run();
  let trendFailed = 0;
  for (const axis of config.interestAxes) {
    const axisHits = ranked.filter((s) => s.hitAxis === axis.id);
    const hitCount = axisHits.length;
    let narrative: string | null = null;
    if (hitCount > 0) {
      try {
        narrative = await summarizeTrend(
          env.AI,
          config.digest.model,
          config.digest.maxOutputTokens,
          axis.label,
          axisHits.slice(0, 10).map((s) => s.article.title),
          sleep,
        );
      } catch (err) {
        trendFailed += 1;
        console.warn(
          `daily: trend narrative failed for axis ${axis.id}; ` +
            `inserting hit_count only: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    await db
      .prepare(
        "INSERT INTO feed_trends (date, axis_id, hit_count, narrative) VALUES (?, ?, ?, ?)",
      )
      .bind(date, axis.id, hitCount, narrative)
      .run();
  }

  console.log(
    `daily: ${JSON.stringify({
      date,
      fetched: fetched.length,
      inserted,
      duplicateSkipped,
      failedSources,
      embedTargets: pending.length,
      embedFailed,
      candidates: embedded.length,
      excludedFromFeed: rows.length - embedded.length,
      feedEntries: ranked.length,
      summarized: summaries.size,
      summaryFailed,
      trendFailed,
    })}`,
  );
}
