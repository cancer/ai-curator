import { describe, it, expect, vi } from "vitest";
import { runFeedBuilder, type FeedBuilderDeps } from "./feed";
import type { Config } from "../config";
import type { Env } from "../index";
import type { NormalizedArticle } from "../adapters/types";
import type { EmbeddingResult } from "../lib/embedding";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    interestAxes: [
      { id: "ai", label: "AI", seedText: "ai" },
      { id: "web", label: "Web", seedText: "web" },
    ],
    sources: {
      githubRepos: [],
      hnMinPoints: 0,
      mediumAuthorFeeds: [],
      mediumTagFeeds: [],
      fowlerFeed: false,
    },
    scoring: {
      weights: { interest: 0.6, freshness: 0.3, sourceTrust: 0.1 },
      freshnessHalfLifeDays: 7,
      semanticDedupThreshold: 0.9,
      sourceTrust: { github: 1.0, fowler: 0.9, medium: 0.6, hn: 0.4 },
    },
    embedding: { model: "m", maxInputChars: 1000 },
    digest: { model: "d", summaryTopN: 10, maxOutputTokens: 300 },
    ...overrides,
  };
}

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

interface Op {
  kind: string;
  args: unknown[];
}

/**
 * SQL をキーワードで大まかにルーティングする in-memory D1 フェイク。
 * SELECT は seed した行を返し、書き込みは種類ごとに ops に記録する。
 */
function makeFakeDb(articles: ArticleRow[], axes: AxisRow[]) {
  const ops: Op[] = [];
  const db = {
    ops,
    prepare(sql: string) {
      const s = sql.replace(/\s+/g, " ").trim();
      return {
        _args: [] as unknown[],
        bind(...args: unknown[]) {
          this._args = args;
          return this;
        },
        async all<T>() {
          if (s.includes("FROM articles")) {
            return { results: articles as unknown as T[], success: true, meta: {} };
          }
          if (s.includes("FROM interest_axes")) {
            return { results: axes as unknown as T[], success: true, meta: {} };
          }
          return { results: [] as T[], success: true, meta: {} };
        },
        async run() {
          let kind = "other";
          if (/^UPDATE articles SET embedding/i.test(s)) kind = "update-embedding";
          else if (/^UPDATE articles SET score/i.test(s)) kind = "update-score";
          else if (/^DELETE FROM feed_entries/i.test(s)) kind = "delete-entries";
          else if (/^INSERT INTO feed_entries/i.test(s)) kind = "insert-entry";
          else if (/^UPDATE feed_entries SET summary/i.test(s)) kind = "update-summary";
          else if (/^DELETE FROM feed_trends/i.test(s)) kind = "delete-trends";
          else if (/^INSERT INTO feed_trends/i.test(s)) kind = "insert-trend";
          ops.push({ kind, args: this._args });
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  };
  return db;
}

function articleRow(overrides: Partial<ArticleRow> = {}): ArticleRow {
  return {
    id: 1,
    title: "t",
    source: "hn",
    url: "https://example.invalid/1",
    published_at: "2026-07-08T00:00:00.000Z",
    feed_summary: "s",
    embedding: null,
    embedding_model: null,
    ...overrides,
  };
}

/** 呼び出し順にベクトルを返す embed モック（1 記事 1 呼び出し）。 */
function embedReturning(vectors: number[][]): FeedBuilderDeps["embed"] {
  let i = 0;
  return vi.fn(async (): Promise<EmbeddingResult> => ({
    vector: vectors[i++],
  })) as FeedBuilderDeps["embed"];
}

const noSleep = async () => {};
const now = () => new Date("2026-07-08T21:00:00.000Z");

describe("runFeedBuilder — end-to-end orchestration", () => {
  it("embeds null-embedding articles, dedups, scores, writes ranked feed_entries and trends", async () => {
    const articles = [
      articleRow({ id: 1, title: "t1", source: "hn", url: "u1", feed_summary: "s1" }),
      articleRow({ id: 2, title: "t2", source: "medium:@alice", url: "u2", feed_summary: "s2" }),
      articleRow({ id: 3, title: "t3", source: "github:o/r", url: "u3", feed_summary: "s3" }),
    ];
    const axes: AxisRow[] = [
      { axis_id: "ai", embedding: "[1,0,0]", embedding_model: "m" },
      { axis_id: "web", embedding: "[0,1,0]", embedding_model: "m" },
    ];
    const db = makeFakeDb(articles, axes);

    // Distinct vectors -> no dedup. a1~ai, a2~web, a3~orthogonal.
    const embed = embedReturning([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);

    const aiRun = vi.fn(async () => ({ response: "要約" }));
    const env = { AI: { run: aiRun } } as unknown as Env;

    const deps: FeedBuilderDeps = {
      db: db as unknown as D1Database,
      loadConfig: async () => makeConfig(),
      syncInterestAxes: vi.fn(async () => {}),
      embed,
      sleep: noSleep,
      bodyFetchers: {
        fetchReleases: async () => [
          { url: "u3", title: "t3", source: "github:o/r", publishedAt: "x", body: "body3" },
        ] as NormalizedArticle[],
        fetchAuthorFeed: async () => [
          { url: "u2", title: "t2", source: "medium:@alice", publishedAt: "x", body: "body2" },
        ] as NormalizedArticle[],
        fetchArticleBody: async () => "should-not-be-called",
      },
      now,
    };

    await runFeedBuilder(env, deps);

    // Embedding saved for all 3 (embedding IS NULL).
    const embUpdates = db.ops.filter((o) => o.kind === "update-embedding");
    expect(embUpdates).toHaveLength(3);
    // Stored as JSON array + model, article id present.
    expect(embUpdates[0].args).toContain("m");
    expect(embUpdates.some((o) => o.args.includes("[1,0,0]"))).toBe(true);

    // feed_entries: delete before any insert.
    const entryOps = db.ops.filter(
      (o) => o.kind === "delete-entries" || o.kind === "insert-entry",
    );
    expect(entryOps[0].kind).toBe("delete-entries");
    const inserts = db.ops.filter((o) => o.kind === "insert-entry");
    expect(inserts).toHaveLength(3);

    // Rank order by score desc: a2 (0.96) > a1 (0.94) > a3 (0.4).
    // insert args: [date, article_id, rank]
    const byRank = new Map(inserts.map((o) => [o.args[2], o.args[1]]));
    expect(byRank.get(1)).toBe(2);
    expect(byRank.get(2)).toBe(1);
    expect(byRank.get(3)).toBe(3);

    // date is the UTC date from now().
    expect(inserts[0].args[0]).toBe("2026-07-08");

    // score/hit_axis updated for each kept article.
    expect(db.ops.filter((o) => o.kind === "update-score")).toHaveLength(3);

    // Summaries written (top N).
    expect(db.ops.filter((o) => o.kind === "update-summary")).toHaveLength(3);

    // Trends: delete-first then one row per axis.
    const trendOps = db.ops.filter(
      (o) => o.kind === "delete-trends" || o.kind === "insert-trend",
    );
    expect(trendOps[0].kind).toBe("delete-trends");
    const trendInserts = db.ops.filter((o) => o.kind === "insert-trend");
    expect(trendInserts).toHaveLength(2);
    // hit_count: ai=2 (a1,a3), web=1 (a2). insert args: [date, axis_id, hit_count, narrative]
    const trendByAxis = new Map(trendInserts.map((o) => [o.args[1], o.args[2]]));
    expect(trendByAxis.get("ai")).toBe(2);
    expect(trendByAxis.get("web")).toBe(1);
  });

  it("never persists article body to any write (body stays in memory only)", async () => {
    const articles = [
      articleRow({ id: 3, title: "t3", source: "github:o/r", url: "u3", feed_summary: "s3" }),
    ];
    const axes: AxisRow[] = [{ axis_id: "ai", embedding: "[1,0,0]", embedding_model: "m" }];
    const db = makeFakeDb(articles, axes);

    const env = { AI: { run: vi.fn(async () => ({ response: "要約" })) } } as unknown as Env;
    await runFeedBuilder(env, {
      db: db as unknown as D1Database,
      loadConfig: async () => makeConfig(),
      syncInterestAxes: vi.fn(async () => {}),
      embed: embedReturning([[1, 0, 0]]),
      sleep: noSleep,
      bodyFetchers: {
        fetchReleases: async () =>
          [{ url: "u3", title: "t3", source: "github:o/r", publishedAt: "x", body: "SECRET_BODY" }] as NormalizedArticle[],
        fetchAuthorFeed: async () => [],
        fetchArticleBody: async () => "SECRET_BODY",
      },
      now,
    });

    const allWrittenArgs = JSON.stringify(db.ops.map((o) => o.args));
    expect(allWrittenArgs).not.toContain("SECRET_BODY");
  });

  it("re-run is idempotent: works over all past-24h articles even when embeddings already exist", async () => {
    // Second-run scenario: embeddings already populated -> embed step does nothing,
    // but the feed is still rebuilt from the full working set.
    const articles = [
      articleRow({
        id: 1,
        title: "t1",
        source: "hn",
        url: "u1",
        embedding: "[1,0,0]",
        embedding_model: "m",
      }),
    ];
    const axes: AxisRow[] = [{ axis_id: "ai", embedding: "[1,0,0]", embedding_model: "m" }];
    const db = makeFakeDb(articles, axes);
    const embed = embedReturning([]);

    const env = { AI: { run: vi.fn(async () => ({ response: "要約" })) } } as unknown as Env;
    await runFeedBuilder(env, {
      db: db as unknown as D1Database,
      loadConfig: async () => makeConfig(),
      syncInterestAxes: vi.fn(async () => {}),
      embed,
      sleep: noSleep,
      bodyFetchers: {
        fetchReleases: async () => [],
        fetchAuthorFeed: async () => [],
        fetchArticleBody: async () => "x",
      },
      now,
    });

    // Nothing to embed (all already embedded), but feed still built from the working set.
    expect(embed).not.toHaveBeenCalled();
    expect(db.ops.filter((o) => o.kind === "update-embedding")).toHaveLength(0);
    expect(db.ops.filter((o) => o.kind === "insert-entry")).toHaveLength(1);
  });

  it("excludes semantic duplicates from the feed (representative kept)", async () => {
    const articles = [
      articleRow({ id: 1, title: "t1", source: "hn", url: "u1", feed_summary: "s1" }),
      articleRow({ id: 2, title: "t2", source: "github:o/r", url: "u2", feed_summary: "s2" }),
    ];
    const axes: AxisRow[] = [{ axis_id: "ai", embedding: "[1,0,0]", embedding_model: "m" }];
    const db = makeFakeDb(articles, axes);
    // Identical vectors -> duplicates. github (trust 1.0) beats hn (0.4) as representative.
    const embed = embedReturning([
      [1, 0, 0],
      [1, 0, 0],
    ]);

    const env = { AI: { run: vi.fn(async () => ({ response: "要約" })) } } as unknown as Env;
    await runFeedBuilder(env, {
      db: db as unknown as D1Database,
      loadConfig: async () => makeConfig(),
      syncInterestAxes: vi.fn(async () => {}),
      embed,
      sleep: noSleep,
      bodyFetchers: {
        fetchReleases: async () =>
          [{ url: "u2", title: "t2", source: "github:o/r", publishedAt: "x", body: "b" }] as NormalizedArticle[],
        fetchAuthorFeed: async () => [],
        fetchArticleBody: async () => "x",
      },
      now,
    });

    const inserts = db.ops.filter((o) => o.kind === "insert-entry");
    // Only the representative (github, id 2) is in the feed.
    expect(inserts).toHaveLength(1);
    expect(inserts[0].args[1]).toBe(2);
    // Both still embedded (dedup does not delete from articles).
    expect(db.ops.filter((o) => o.kind === "update-embedding")).toHaveLength(2);
  });

  it("keeps building the feed when one article's embedding fails (skip, no total wipe)", async () => {
    const articles = [
      articleRow({ id: 1, title: "落ちる記事", source: "hn", url: "u1", feed_summary: "s1" }),
      articleRow({ id: 2, title: "通る記事", source: "github:o/r", url: "u2", feed_summary: "s2" }),
    ];
    const axes: AxisRow[] = [{ axis_id: "ai", embedding: "[1,0,0]", embedding_model: "m" }];
    const db = makeFakeDb(articles, axes);

    // id 1 の embedding は永続的に失敗し、id 2 は成功する。
    const embed = vi.fn(async (_ai: unknown, _model: string, text: string) => {
      if (text.includes("落ちる")) {
        throw new Error("embedding permanently failed");
      }
      return { vector: [1, 0, 0] };
    }) as unknown as FeedBuilderDeps["embed"];

    const env = { AI: { run: vi.fn(async () => ({ response: "要約" })) } } as unknown as Env;

    // Must not throw even though one article failed.
    await runFeedBuilder(env, {
      db: db as unknown as D1Database,
      loadConfig: async () => makeConfig(),
      syncInterestAxes: vi.fn(async () => {}),
      embed,
      sleep: noSleep,
      bodyFetchers: {
        fetchReleases: async () =>
          [{ url: "u2", title: "通る記事", source: "github:o/r", publishedAt: "x", body: "b" }] as NormalizedArticle[],
        fetchAuthorFeed: async () => [],
        fetchArticleBody: async () => "x",
      },
      now,
    });

    // Only the successful article was embedded and added to the feed.
    expect(db.ops.filter((o) => o.kind === "update-embedding")).toHaveLength(1);
    const inserts = db.ops.filter((o) => o.kind === "insert-entry");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].args[1]).toBe(2);
  });

  it("keeps building trends when one axis's narrative fails (null narrative, no total reject)", async () => {
    const articles = [
      articleRow({ id: 1, title: "t1", source: "github:o/r", url: "u1", feed_summary: "s1" }),
    ];
    // Two axes so both get hit_count rows; article aligns with ai axis only.
    const axes: AxisRow[] = [
      { axis_id: "ai", embedding: "[1,0,0]", embedding_model: "m" },
      { axis_id: "web", embedding: "[0,1,0]", embedding_model: "m" },
    ];
    const db = makeFakeDb(articles, axes);

    // Text generation (summarizeArticle / summarizeTrend) both go through AI.run.
    // Fail only the trend call for the "ai" axis; article summaries must still work.
    const aiRun = vi.fn(async (_model: string, input: { messages: { content: string }[] }) => {
      const userContent = input.messages[1].content;
      if (userContent.includes("テーマ: AI")) {
        throw new Error("trend narrative permanently failed");
      }
      return { response: "生成テキスト" };
    });
    const env = { AI: { run: aiRun } } as unknown as Env;

    // Must not throw even though the "ai" axis narrative failed.
    await runFeedBuilder(env, {
      db: db as unknown as D1Database,
      loadConfig: async () => makeConfig(),
      syncInterestAxes: vi.fn(async () => {}),
      embed: embedReturning([[1, 0, 0]]),
      sleep: noSleep,
      bodyFetchers: {
        fetchReleases: async () =>
          [{ url: "u1", title: "t1", source: "github:o/r", publishedAt: "x", body: "b" }] as NormalizedArticle[],
        fetchAuthorFeed: async () => [],
        fetchArticleBody: async () => "x",
      },
      now,
    });

    // Both axes still get a feed_trends row (delete-first, then per-axis insert).
    const trendOps = db.ops.filter(
      (o) => o.kind === "delete-trends" || o.kind === "insert-trend",
    );
    expect(trendOps[0].kind).toBe("delete-trends");
    const trendInserts = db.ops.filter((o) => o.kind === "insert-trend");
    expect(trendInserts).toHaveLength(2);
    // ai axis: hit_count 1 but narrative null (generation failed); insert args: [date, axis_id, hit_count, narrative]
    const ai = trendInserts.find((o) => o.args[1] === "ai")!;
    expect(ai.args[2]).toBe(1);
    expect(ai.args[3]).toBeNull();
  });
});
