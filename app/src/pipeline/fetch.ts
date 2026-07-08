/**
 * Fetch パイプライン（Cron A）。3 時間ごとに全ソースを取得し、
 * 近傍重複を除いて articles に保存する。
 *
 * 厳守:
 * - 記事本文(body)は D1・KV・ログに書かない。INSERT 列は
 *   url/title/source/published_at/feed_summary/content_hash のみ。
 * - embedding/score は書かない（Cron B の担当）。
 * - 1 ソースの失敗で全体を止めない。全ソース失敗時のみ throw する。
 * - 冪等キーは正規化 URL。ON CONFLICT(url) DO NOTHING で再実行に安全。
 */

import type { Env } from "../index";
import { type Config, loadConfig } from "../config";
import type { NormalizedArticle } from "../adapters/types";
import { simhash, hammingDistance, SIMHASH_DUP_DISTANCE } from "../lib/simhash";
import { fetchReleases } from "../adapters/github";
import { fetchStories } from "../adapters/hn";
import { fetchAuthorFeed, fetchTagFeed } from "../adapters/medium";
import { fetchFowlerFeed } from "../adapters/fowler";

/**
 * 各ソースアダプタの fetch 関数（テストで差し替え可能にするため注入する）。
 * fowler は feed のみ取得する fetchFowlerFeed を使う（Cron A では本文を取得しない）。
 */
export interface Fetchers {
  fetchReleases(owner: string, repo: string): Promise<NormalizedArticle[]>;
  fetchStories(minPoints: number): Promise<NormalizedArticle[]>;
  fetchAuthorFeed(author: string): Promise<NormalizedArticle[]>;
  fetchTagFeed(tag: string): Promise<NormalizedArticle[]>;
  fetchFowlerFeed(): Promise<NormalizedArticle[]>;
}

/** 実行時に使う本物のアダプタ群。 */
const defaultFetchers: Fetchers = {
  fetchReleases: (owner, repo) => fetchReleases(owner, repo),
  fetchStories: (minPoints) => fetchStories(minPoints),
  fetchAuthorFeed: (author) => fetchAuthorFeed(author),
  fetchTagFeed: (tag) => fetchTagFeed(tag),
  fetchFowlerFeed: () => fetchFowlerFeed(),
};

/** 1 ソース分の取得タスク。label は失敗ログ・サマリ用の識別子。 */
export interface SourceTask {
  label: string;
  fetch: () => Promise<NormalizedArticle[]>;
}

/** 実行サマリ（ログにも出す）。件数と失敗ソースのみ。本文・内容は含めない。 */
export interface FetchSummary {
  /** 取得できた記事の総数（成功ソースの合計）。 */
  fetched: number;
  /** 新規 insert 件数（ON CONFLICT で弾かれた分は含めない）。 */
  inserted: number;
  /** 近傍重複としてスキップした件数。 */
  duplicateSkipped: number;
  /** 失敗したソースの label 一覧。 */
  failedSources: string[];
}

export interface FetchPipelineDeps {
  db?: D1Database;
  fetchers?: Fetchers;
  loadConfig?: (env: Env) => Promise<Config>;
}

/** config.sources を、順序を保ったソースタスク列に展開する。 */
export function buildSourceTasks(
  config: Config,
  fetchers: Fetchers,
): SourceTask[] {
  const { sources } = config;
  const tasks: SourceTask[] = [];

  for (const repo of sources.githubRepos) {
    const [owner, name] = repo.split("/");
    tasks.push({
      label: `github:${repo}`,
      fetch: () => fetchers.fetchReleases(owner, name),
    });
  }

  tasks.push({
    label: "hn",
    fetch: () => fetchers.fetchStories(sources.hnMinPoints),
  });

  for (const feed of sources.mediumAuthorFeeds) {
    const author = feed.replace(/^@/, "");
    tasks.push({
      label: `medium:@${author}`,
      fetch: () => fetchers.fetchAuthorFeed(author),
    });
  }

  for (const tag of sources.mediumTagFeeds) {
    tasks.push({
      label: `medium:tag/${tag}`,
      fetch: () => fetchers.fetchTagFeed(tag),
    });
  }

  if (sources.fowlerFeed) {
    tasks.push({ label: "fowler", fetch: () => fetchers.fetchFowlerFeed() });
  }

  return tasks;
}

/** 直近 7 日で保存済みの content_hash（重複判定の初期集合）。 */
const RECENT_HASHES_SQL =
  "SELECT content_hash FROM articles " +
  "WHERE content_hash IS NOT NULL AND created_at >= datetime('now', '-7 days')";

/** 保存する列は url/title/source/published_at/feed_summary/content_hash のみ。 */
const INSERT_SQL =
  "INSERT INTO articles (url, title, source, published_at, feed_summary, content_hash) " +
  "VALUES (?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT(url) DO NOTHING";

/** SimHash の入力（保存対象と揃え、body は含めない）。 */
function hashInput(article: NormalizedArticle): string {
  return `${article.title} ${article.feedSummary ?? ""}`;
}

export async function runFetchPipeline(
  env: Env,
  deps: FetchPipelineDeps = {},
): Promise<FetchSummary> {
  const db = deps.db ?? env.DB;
  const fetchers = deps.fetchers ?? defaultFetchers;
  const load = deps.loadConfig ?? loadConfig;

  const config = await load(env);
  const tasks = buildSourceTasks(config, fetchers);

  // 1. 全ソースを直列 fetch。1 ソースの失敗は握って続行する。
  const articles: NormalizedArticle[] = [];
  const failedSources: string[] = [];
  for (const task of tasks) {
    try {
      articles.push(...(await task.fetch()));
    } catch (err) {
      failedSources.push(task.label);
      console.warn(
        `fetch: source ${task.label} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 全ソース失敗時のみ throw（cron 失敗として observability に出す）。
  if (tasks.length > 0 && failedSources.length === tasks.length) {
    throw new Error(
      `fetch: all ${tasks.length} source(s) failed: ${failedSources.join(", ")}`,
    );
  }

  // 2. 直近 7 日のハッシュを読み、重複判定の初期集合とする。
  const recent = await db
    .prepare(RECENT_HASHES_SQL)
    .all<{ content_hash: string }>();
  const knownHashes = (recent.results ?? []).map((row) => row.content_hash);

  // 3. 各記事を SimHash 化。近傍重複（DB 既存・同一バッチ問わず）はスキップし、
  //    残りを ON CONFLICT DO NOTHING で保存する。
  let inserted = 0;
  let duplicateSkipped = 0;
  for (const article of articles) {
    const hash = simhash(hashInput(article));
    const isDuplicate = knownHashes.some(
      (known) => hammingDistance(known, hash) <= SIMHASH_DUP_DISTANCE,
    );
    if (isDuplicate) {
      duplicateSkipped += 1;
      continue;
    }
    // 同一バッチ内の後続重複も弾けるよう、判定済み集合に加える。
    knownHashes.push(hash);

    const result = await db
      .prepare(INSERT_SQL)
      .bind(
        article.url,
        article.title,
        article.source,
        article.publishedAt,
        article.feedSummary ?? null,
        hash,
      )
      .run();
    inserted += result.meta?.changes ?? 0;
  }

  const summary: FetchSummary = {
    fetched: articles.length,
    inserted,
    duplicateSkipped,
    failedSources,
  };
  console.log(`fetch: ${JSON.stringify(summary)}`);
  return summary;
}
