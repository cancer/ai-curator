/**
 * 日次パスのフェーズ関数群（Cloudflare Workflows の各 step から呼ぶ）。
 *
 * オーケストレーションは `pipeline/workflow.ts` の `DailyPass`（WorkflowEntrypoint）が
 * 担い、この module は「1 フェーズ = 1 関数」を提供する。step 間はメモリを跨げず、
 * step の戻り値は永続化される（非 stream 1MiB/step）ため、設計上の厳守事項は次の 2 点:
 *
 * 厳守（原文非永続）:
 * - 記事本文 body・フィード提供要約 feedSummary を D1・KV・ログ・**step の戻り値**に
 *   一切載せない。永続化するのは metadata（url/title/source/published_at）・
 *   content_hash・embedding(+embedding_model)・score・hit_axis・自前生成の
 *   summary/narrative のみ。フェーズ関数の戻り値は件数などのメタ情報だけにする。
 * - 原文が要る処理（embedding の入力に feedSummary、要約の入力に body）は、原文を
 *   取得した同一 step 内でだけ使い、step をまたいで持ち回らない。
 *   - ingest: feed 取得直後に、その場で embedding まで済ませる（feedSummary はこの
 *     step 内メモリで使い捨て）。
 *   - summarize: body は feed_entries を再走査して**リンク先から再取得**する
 *     （前段の body はメモリに残っていないため）。
 *
 * 冪等性（step 再実行 = at-least-once に耐える）:
 * - articles は INSERT ... ON CONFLICT(url) DO NOTHING。
 * - embedding は未生成(NULL)の行だけ処理。
 * - summaries は 1 記事 1 行（article_id UNIQUE）。行が無い記事だけ要約し、
 *   INSERT ... ON CONFLICT(article_id) DO NOTHING。feed_entries の delete→insert では消えない。
 * - feed_entries / feed_trends は当日分を delete してから insert。
 */

import type {
  DigestConfig,
  EmbeddingConfig,
  InterestAxis,
  ScoringConfig,
} from "../config";
import type { NormalizedArticle } from "../adapters/types";
import { simhash, hammingDistance, SIMHASH_DUP_DISTANCE } from "../lib/simhash";
import { embed } from "../lib/embedding";
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
  type DigestMetric,
} from "../lib/summarize";
import { fetchFeed, resolveArticleBody, MIN_BODY_CHARS } from "../adapters/feed";

/** embedding 呼び出しの間隔（レート制御）。 */
const EMBED_SPACING_MS = 150;

/**
 * 各ソースの当日分を取得する関数群（テストで差し替え可能にするため注入する）。
 * windowStart（当日ウィンドウ下限）を受け取り、その範囲内を全件返す。
 */
export interface Fetchers {
  /** 汎用 RSS/Atom フィード。任意の feed URL を扱う。 */
  fetchFeed(feedUrl: string, windowStart: Date): Promise<NormalizedArticle[]>;
}

const defaultFetchers: Fetchers = {
  fetchFeed: (feedUrl, windowStart) => fetchFeed(feedUrl, windowStart),
};

/**
 * 要約段で本文を解決する関数群（テストで差し替え可能）。
 * body は step をまたげないため、要約段では常にリンク先を再取得する
 * （resolveArticleBody に url だけ渡す → インライン body/feedSummary は無く、Medium
 *   フィード導出 → 記事 URL の抽出カスケードに落ちる）。
 */
export interface BodyFetchers {
  resolveArticleBody(article: { url: string }): Promise<string | null>;
}

const defaultBodyFetchers: BodyFetchers = {
  resolveArticleBody: (article) => resolveArticleBody(article),
};

/** 各種待機（既定 setTimeout）。テストで no-op に差し替える。 */
type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 直近 7 日で保存済みの (url, content_hash)（重複判定の初期集合）。
 * url も引くのは、同一 url の再取得（step 再実行や翌日の再取得）を「別記事の近接重複」
 * と誤判定して embedding 対象から落とさないため（自分自身のハッシュは除外して比較する）。
 */
const RECENT_HASHES_SQL =
  "SELECT url, content_hash FROM articles " +
  "WHERE content_hash IS NOT NULL AND created_at >= datetime('now', '-7 days')";

/**
 * 保存する列は url/title/source/published_at/content_hash のみ。
 * feed_summary 列は無い（原文非永続）。
 */
const INSERT_SQL =
  "INSERT INTO articles (url, title, source, published_at, content_hash) " +
  "VALUES (?, ?, ?, ?, ?) " +
  "ON CONFLICT(url) DO NOTHING";

/** 過去 24 時間の記事（フィード作業集合）。feed_summary 列は存在しない。 */
const WORKING_SET_SQL =
  "SELECT id, title, source, url, published_at, embedding, embedding_model " +
  "FROM articles WHERE created_at >= datetime('now', '-1 day')";

// 昇格後は未 embed 軸が embedding=NULL の行として存在する。NULL を除外して引くことで
// JSON.parse(r.embedding) の crash を避け、「未 embed 軸は採点対象外」の現行挙動を保つ。
const AXES_SQL =
  "SELECT axis_id, embedding, embedding_model FROM interest_axes WHERE embedding IS NOT NULL";

/**
 * 過去のフィードに既出の記事 id（当日より前の feed_entries に載ったもの）。
 * 作業集合は「直近 24h に取り込まれた記事」なので、日跨ぎでウィンドウが重なると前日出た
 * 記事が翌日も候補に残り再掲される。既出分を候補から除外して二度と載せない（issue #12）。
 */
const PRIOR_FEED_ARTICLES_SQL =
  "SELECT DISTINCT article_id FROM feed_entries WHERE date < ?";

/**
 * 当日掲載のうち summaries に行が無いエントリ（要約段の対象。title/source/url はメタで
 * 永続済み）。summaries を LEFT JOIN して s.article_id IS NULL に絞るのは、step 再実行時に
 * 要約済みを飛ばして未了分だけ進めるため（ingest の embedding=NULL のみ処理と同じ設計思想）。
 * 要約は summaries に 1 記事 1 行で永続するので、feed_entries の delete→insert では消えない。
 */
const ENTRIES_FOR_DATE_SQL =
  "SELECT fe.article_id AS article_id, a.title AS title, a.source AS source, " +
  "a.url AS url FROM feed_entries fe JOIN articles a ON a.id = fe.article_id " +
  "LEFT JOIN summaries s ON s.article_id = fe.article_id " +
  "WHERE fe.date = ? AND s.article_id IS NULL ORDER BY fe.rank";

/** digest 生成メトリクスの記録（観測用。1 試行 1 行）。 */
const INSERT_DIGEST_METRIC_SQL =
  "INSERT INTO digest_metrics " +
  "(label, model, attempt, ms, finish_reason, completion_tokens, max_tokens, content_len, empty, error) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

/**
 * digest メトリクスを D1 へ保存する。観測は生成本体を壊さないため、書き込み失敗は
 * warn に留めて握り潰す（summarize 側の recordMetric も onMetric 例外を捕捉するが、
 * ここでも二重に保険する）。
 */
async function recordDigestMetric(
  db: D1Database,
  m: DigestMetric,
): Promise<void> {
  try {
    await db
      .prepare(INSERT_DIGEST_METRIC_SQL)
      .bind(
        m.label,
        m.model,
        m.attempt,
        m.ms,
        m.finishReason,
        m.completionTokens,
        m.maxTokens,
        m.contentLen,
        m.empty ? 1 : 0,
        m.error,
      )
      .run();
  } catch (err) {
    console.warn(
      `digest metric persist failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** 当日フィードの hit_axis と title（傾向段の集計元。どちらもメタ）。 */
const TREND_SOURCE_SQL =
  "SELECT a.hit_axis AS hit_axis, a.title AS title FROM feed_entries fe " +
  "JOIN articles a ON a.id = fe.article_id WHERE fe.date = ? ORDER BY fe.rank";

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

/** ingest 段で embedding 対象を引くための最小行（原文は含めない）。 */
interface IngestRow {
  id: number;
  url: string;
  title: string;
  embedding: string | null;
}

/** SimHash の入力（保存対象の title + メモリの feedSummary）。 */
function hashInput(article: NormalizedArticle): string {
  return `${article.title} ${article.feedSummary ?? ""}`;
}

/** embedding 入力は title + "\n" + メモリの feedSummary（本文は足さない）。 */
function embeddingInput(title: string, feedSummary: string | null): string {
  return `${title}\n${feedSummary ?? ""}`;
}

/** ingest フェーズの結果（件数のみ。原文・ハッシュ本体は返さない）。 */
export interface IngestResult {
  feedUrl: string;
  fetched: number;
  inserted: number;
  duplicateSkipped: number;
  embedded: number;
  embedFailed: number;
}

export interface IngestDeps {
  fetchers?: Fetchers;
  embed?: typeof embed;
  sleep?: Sleep;
  /** 本文解決（テストで差し替え可能）。既定は adapters/feed の resolveArticleBody。 */
  resolveArticleBody?: typeof resolveArticleBody;
}

/**
 * 1 フィードの取得〜メタ INSERT〜embedding までを 1 step 内で行う。
 *
 * feedSummary/body はこの step 内メモリでだけ使う（feedSummary=SimHash 入力、
 * body=embedding 入力／本文が MIN_BODY_CHARS 未満のときだけ feedSummary へフォールバック）。
 * どちらも D1・戻り値・ログには載せない。cross-feed の重複判定は D1 の直近ハッシュを都度
 * ロードすることで成立する（先行フィードの INSERT が content_hash を永続済み）。
 *
 * 冪等性（step 再実行 = at-least-once）: INSERT は ON CONFLICT DO NOTHING、embedding は
 * NULL 行だけ処理するので二重書きにならない。加えて、INSERT 後・embedding 前に中断して
 * 再実行された場合も、再取得した同一 url を「別記事の近接重複」と誤判定しない（自分自身の
 * ハッシュは重複比較から除外する）ため、NULL のまま取り残さず再 embedding できる。
 * 1 記事の embedding 失敗はスキップして続行する（次回の再取得でまた NULL 行として拾える）。
 * フィード取得自体の失敗は throw（step のリトライに委ねる。全滅判定は呼び出し側）。
 */
export async function ingestFeed(
  db: D1Database,
  ai: Ai,
  feedUrl: string,
  windowStart: Date,
  embedding: EmbeddingConfig,
  deps: IngestDeps = {},
): Promise<IngestResult> {
  const fetchers = deps.fetchers ?? defaultFetchers;
  const runEmbed = deps.embed ?? embed;
  const sleep = deps.sleep ?? defaultSleep;
  const resolveBody = deps.resolveArticleBody ?? resolveArticleBody;

  const fetched = await fetchers.fetchFeed(feedUrl, windowStart);
  // url → 取得記事。embedding 段で本文解決の入力（インライン body/feedSummary）に使う。
  const articleByUrl = new Map(fetched.map((article) => [article.url, article]));

  // SimHash Dedup → メタのみ INSERT（feed_summary は入れない）。
  const recent = await db
    .prepare(RECENT_HASHES_SQL)
    .all<{ url: string; content_hash: string }>();
  const known = (recent.results ?? []).map((row) => ({
    url: row.url,
    hash: row.content_hash,
  }));

  // url → feedSummary（この step 内でのみ保持。embedding 入力に使い捨てる）。
  const feedSummaryByUrl = new Map<string, string | null>();
  let inserted = 0;
  let duplicateSkipped = 0;
  for (const article of fetched) {
    const hash = simhash(hashInput(article));
    // 弾くのは「別 url の近接重複」だけ。同一 url の再取得（step 再実行・翌日再取得）は
    // 自分自身のハッシュと一致するが重複ではないので、embedding へ進ませる。
    const isDuplicate = known.some(
      (k) =>
        k.url !== article.url &&
        hammingDistance(k.hash, hash) <= SIMHASH_DUP_DISTANCE,
    );
    if (isDuplicate) {
      duplicateSkipped += 1;
      continue;
    }
    known.push({ url: article.url, hash });
    feedSummaryByUrl.set(article.url, article.feedSummary ?? null);
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

  // 取り込んだ（重複でない）記事の行を引き、embedding 未生成のものだけ埋める。
  const urls = [...feedSummaryByUrl.keys()];
  const rows =
    urls.length === 0
      ? []
      : ((
          await db
            .prepare(
              `SELECT id, url, title, embedding FROM articles WHERE url IN (${urls
                .map(() => "?")
                .join(",")})`,
            )
            .bind(...urls)
            .all<IngestRow>()
        ).results ?? []);

  const pending = rows.filter((r) => r.embedding === null);
  // Medium フィードはソース単位でキャッシュする（同一著者/publication は 1 回だけ取得）。
  // ループ外で 1 個生成し、この記事群で共有する。
  const mediumFeedCache = new Map<string, NormalizedArticle[]>();
  let embedded = 0;
  let embedFailed = 0;
  for (let i = 0; i < pending.length; i++) {
    if (i > 0) {
      await sleep(EMBED_SPACING_MS);
    }
    const r = pending[i];
    const feedSummary = feedSummaryByUrl.get(r.url) ?? null;

    // 本文を解決して embedding 入力を決める。本文は step 内メモリのみで、D1・戻り値・ログには
    // 載せない。本文が MIN_BODY_CHARS 以上なら本文で、未満/null なら従来どおり
    // title + feedSummary（スニペット）で埋め込む。body 解決の失敗（fetch 失敗・throw）は
    // embedding を止めず、スニペットへフォールバックする（embedding 自体を失敗させない）。
    const article = articleByUrl.get(r.url);
    let body: string | null = null;
    if (article !== undefined) {
      try {
        body = await resolveBody(article, { mediumFeedCache });
      } catch (err) {
        console.warn(
          `daily: body resolution failed for article ${r.id}; ` +
            `falling back to snippet: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const input =
      body !== null && body.length >= MIN_BODY_CHARS
        ? body
        : embeddingInput(r.title, feedSummary);
    try {
      const result = await runEmbed(
        ai,
        embedding.model,
        input,
        embedding.maxInputChars,
      );
      await db
        .prepare(
          "UPDATE articles SET embedding = ?, embedding_model = ? WHERE id = ?",
        )
        .bind(JSON.stringify(result.vector), embedding.model, r.id)
        .run();
      embedded += 1;
    } catch (err) {
      embedFailed += 1;
      console.warn(
        `daily: embedding failed for article ${r.id}; skipping: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    feedUrl,
    fetched: fetched.length,
    inserted,
    duplicateSkipped,
    embedded,
    embedFailed,
  };
}

/** score フェーズの結果（件数のみ）。 */
export interface ScoreResult {
  candidates: number;
  excludedFromFeed: number;
  feedEntries: number;
}

/**
 * 当日記事（過去 24h）から embedding 済みを候補にして、意味的 dedup → スコアリング
 * → feed_entries を再構築する（当日分 delete → rank 順 insert）。
 *
 * 原文は要らない（vector・メタだけで完結）。当日フィードは delete→insert で冪等。
 */
export async function scoreAndBuildFeed(
  db: D1Database,
  scoring: ScoringConfig,
  embeddingModel: string,
  runAt: Date,
): Promise<ScoreResult> {
  const trustTable: Record<string, number> = { ...scoring.sourceTrust };

  const rows =
    (await db.prepare(WORKING_SET_SQL).all<ArticleRow>()).results ?? [];

  // 既出（過去のフィードに載った）記事は再掲しない（issue #12）。
  const date = runAt.toISOString().slice(0, 10);
  const priorRows =
    (
      await db
        .prepare(PRIOR_FEED_ARTICLES_SQL)
        .bind(date)
        .all<{ article_id: number }>()
    ).results ?? [];
  const priorSet = new Set(priorRows.map((r) => r.article_id));

  // フィード構築対象は embedding を持ち現行モデルで生成され、かつ未既出の記事のみ。
  interface Candidate {
    id: number;
    source: string;
    url: string;
    publishedAt: string;
    vector: number[];
    model: string;
  }
  const candidates: Candidate[] = rows
    .filter(
      (r) =>
        r.embedding !== null &&
        r.embedding_model === embeddingModel &&
        !priorSet.has(r.id),
    )
    .map((r) => ({
      id: r.id,
      source: r.source,
      url: r.url,
      publishedAt: r.published_at,
      vector: JSON.parse(r.embedding as string) as number[],
      model: r.embedding_model as string,
    }));

  // 意味的 Dedup（当日記事同士）。非代表はフィードから除外する。
  const dedupInput: DedupArticle[] = candidates.map((a) => ({
    id: a.id,
    vector: a.vector,
    model: a.model,
    sourceTrust: sourceTrust(a.source, trustTable),
    publishedAt: a.publishedAt,
  }));
  const { keptIds } = clusterArticles(
    dedupInput,
    scoring.semanticDedupThreshold,
  );
  const keptSet = new Set(keptIds);
  const kept = candidates.filter((a) => keptSet.has(a.id));

  // 関心軸ベクトルを読み、各代表記事のスコアと hit_axis を求める。
  const axisRows = (await db.prepare(AXES_SQL).all<AxisRow>()).results ?? [];
  const axisVectors: AxisVector[] = axisRows.map((r) => ({
    axisId: r.axis_id,
    vector: JSON.parse(r.embedding) as number[],
    model: r.embedding_model,
  }));

  interface Scored {
    id: number;
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
        scoring.freshnessHalfLifeDays,
      ),
      sourceTrust: sourceTrust(a.source, trustTable),
    };
    return {
      id: a.id,
      score: score(components, scoring.weights),
      hitAxis: interest.hitAxis,
    };
  });

  for (const s of scored) {
    await db
      .prepare("UPDATE articles SET score = ?, hit_axis = ? WHERE id = ?")
      .bind(s.score, s.hitAxis, s.id)
      .run();
  }

  // feed_entries: スコア降順に rank 1..N。当日分を delete してから insert。
  // date は候補選定時に算出済み（既出除外と同じ日付を使う）。
  const ranked = [...scored].sort((a, b) => b.score - a.score);

  await db.prepare("DELETE FROM feed_entries WHERE date = ?").bind(date).run();
  for (let i = 0; i < ranked.length; i++) {
    await db
      .prepare(
        "INSERT INTO feed_entries (date, article_id, rank) VALUES (?, ?, ?)",
      )
      .bind(date, ranked[i].id, i + 1)
      .run();
  }

  return {
    candidates: candidates.length,
    excludedFromFeed: rows.length - candidates.length,
    feedEntries: ranked.length,
  };
}

/** summarize フェーズの結果（件数のみ）。 */
export interface SummarizeResult {
  summarized: number;
  summaryFailed: number;
}

export interface SummarizeDeps {
  bodyFetchers?: BodyFetchers;
  sleep?: Sleep;
}

/**
 * 当日掲載のうち summaries に行が無い記事を要約して summaries へ書く。body はこの step 内で
 * リンク先から再取得して使い捨てる（前段の body はメモリに残っていない）。1 件の失敗は除外して
 * 続行する。要約は自前生成なので保存してよい。
 *
 * 劣化止め: 再取得した本文が MIN_BODY_CHARS 未満（取得失敗＝空を含む）の記事は要約を作らない
 * （summarizeEntries が閾値でスキップし、summaries 行を作らない → ビューアは要約なしで描画する）。
 * feedSummary は step をまたげず常に null なので、本文を回収できない記事はスニペットからの
 * 退化要約を出す代わりに黙ってスキップされる。
 */
export async function summarizeFeed(
  db: D1Database,
  ai: Ai,
  digest: DigestConfig,
  date: string,
  deps: SummarizeDeps = {},
): Promise<SummarizeResult> {
  const bodyFetchers = deps.bodyFetchers ?? defaultBodyFetchers;

  const entries =
    (
      await db
        .prepare(ENTRIES_FOR_DATE_SQL)
        .bind(date)
        .all<{
          article_id: number;
          title: string;
          source: string;
          url: string;
        }>()
    ).results ?? [];

  const targets: SummaryTarget[] = entries.map((e) => ({
    articleId: e.article_id,
    title: e.title,
    source: e.source,
    url: e.url,
    // feedSummary は step をまたげないため常に null。resolveBody がリンク先を再取得する。
    feedSummary: null,
  }));

  // per-entry: 要約できた 1 件ずつ即 INSERT して部分進捗を永続化する（onSummary）。
  // これで step 再実行時は summaries に行が無い残りだけを処理できる（前進性）。
  // ON CONFLICT DO NOTHING は step の at-least-once 再実行への保険（既に行があれば書かない）。
  const { summaries, failed } = await summarizeEntries(
    ai,
    digest,
    targets,
    (target) => bodyFetchers.resolveArticleBody({ url: target.url }),
    MIN_BODY_CHARS,
    deps.sleep,
    async (articleId, summary) => {
      await db
        .prepare(
          "INSERT INTO summaries (article_id, text, model) VALUES (?, ?, ?) " +
            "ON CONFLICT(article_id) DO NOTHING",
        )
        .bind(articleId, summary, digest.model)
        .run();
    },
    (metric) => recordDigestMetric(db, metric),
  );

  return { summarized: summaries.size, summaryFailed: failed };
}

/** trends フェーズの結果（件数のみ）。 */
export interface TrendsResult {
  trendFailed: number;
}

export interface TrendsDeps {
  sleep?: Sleep;
}

/**
 * 軸ごとに hit_count を集計し、上位タイトルから傾向叙述を生成する。集計元は当日
 * feed_entries（articles.hit_axis / title）を D1 から再走査する。当日分を delete して
 * から insert。narrative 生成は軸ごとに try/catch（1 軸失敗で当日全体を失わない）。
 */
export async function buildTrends(
  db: D1Database,
  ai: Ai,
  digest: DigestConfig,
  interestAxes: InterestAxis[],
  date: string,
  deps: TrendsDeps = {},
): Promise<TrendsResult> {
  const rows =
    (
      await db
        .prepare(TREND_SOURCE_SQL)
        .bind(date)
        .all<{ hit_axis: string | null; title: string }>()
    ).results ?? [];

  await db.prepare("DELETE FROM feed_trends WHERE date = ?").bind(date).run();

  let trendFailed = 0;
  for (const axis of interestAxes) {
    const axisHits = rows.filter((r) => r.hit_axis === axis.id);
    const hitCount = axisHits.length;
    let narrative: string | null = null;
    if (hitCount > 0) {
      try {
        narrative = await summarizeTrend(
          ai,
          digest.model,
          digest.maxOutputTokens,
          axis.label,
          axisHits.slice(0, 10).map((r) => r.title),
          deps.sleep,
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

  return { trendFailed };
}
