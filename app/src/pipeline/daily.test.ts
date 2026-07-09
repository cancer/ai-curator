import { describe, it, expect, vi, afterEach } from "vitest";
import {
  runDaily,
  buildSourceTasks,
  makeBodyResolver,
  type DailyDeps,
  type Fetchers,
  type BodyFetchers,
} from "./daily";
import type { Config } from "../config";
import type { Env } from "../index";
import type { NormalizedArticle } from "../adapters/types";
import type { EmbeddingResult } from "../lib/embedding";
import type { SummaryTarget } from "../lib/summarize";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    interestAxes: [
      { id: "ai", label: "AI" },
      { id: "web", label: "Web" },
    ],
    sources: {
      feeds: [],
      githubRepos: [],
      hnMinPoints: 0,
    },
    scoring: {
      weights: { interest: 0.6, freshness: 0.3, sourceTrust: 0.1 },
      freshnessHalfLifeDays: 7,
      semanticDedupThreshold: 0.9,
      sourceTrust: { github: 1.0, hn: 0.4, feed: 0.7 },
    },
    embedding: { model: "m", maxInputChars: 1000 },
    digest: { model: "d", maxOutputTokens: 300 },
    ...overrides,
  };
}

/** 作業集合として返す articles 行（feed_summary 列は無い）。 */
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

interface Op {
  kind: string;
  args: unknown[];
}

/**
 * SQL をキーワードで大まかにルーティングする in-memory D1 フェイク。
 * - 直近 7 日ハッシュ（content_hash FROM articles）と作業集合（FROM articles）を
 *   区別して返す。
 * - 書き込みは種類ごとに ops に記録する。INSERT INTO articles は url キーで
 *   ON CONFLICT を模して changes を返す。
 */
function makeFakeDb(
  workingSet: ArticleRow[],
  axes: AxisRow[],
  recentHashes: string[] = [],
) {
  const ops: Op[] = [];
  const insertedUrls = new Set<string>();
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
          if (s.includes("content_hash FROM articles")) {
            return {
              results: recentHashes.map((h) => ({ content_hash: h })) as unknown as T[],
              success: true,
              meta: {},
            };
          }
          if (s.includes("FROM articles")) {
            return { results: workingSet as unknown as T[], success: true, meta: {} };
          }
          if (s.includes("FROM interest_axes")) {
            return { results: axes as unknown as T[], success: true, meta: {} };
          }
          return { results: [] as T[], success: true, meta: {} };
        },
        async run() {
          let kind = "other";
          let changes = 1;
          if (/^INSERT INTO articles/i.test(s)) {
            kind = "insert-article";
            const url = this._args[0] as string;
            changes = insertedUrls.has(url) ? 0 : 1;
            insertedUrls.add(url);
          } else if (/^UPDATE articles SET embedding/i.test(s)) kind = "update-embedding";
          else if (/^UPDATE articles SET score/i.test(s)) kind = "update-score";
          else if (/^DELETE FROM feed_entries/i.test(s)) kind = "delete-entries";
          else if (/^INSERT INTO feed_entries/i.test(s)) kind = "insert-entry";
          else if (/^UPDATE feed_entries SET summary/i.test(s)) kind = "update-summary";
          else if (/^DELETE FROM feed_trends/i.test(s)) kind = "delete-trends";
          else if (/^INSERT INTO feed_trends/i.test(s)) kind = "insert-trend";
          ops.push({ kind, args: this._args });
          return { success: true, meta: { changes } };
        },
      };
    },
  };
  return db;
}

function row(overrides: Partial<ArticleRow> = {}): ArticleRow {
  return {
    id: 1,
    title: "t",
    source: "hn",
    url: "https://example.invalid/1",
    published_at: "2026-07-08T00:00:00.000Z",
    embedding: null,
    embedding_model: null,
    ...overrides,
  };
}

/** 呼び出し順にベクトルを返す embed モック（1 記事 1 呼び出し）。 */
function embedReturning(vectors: number[][]): DailyDeps["embed"] {
  let i = 0;
  return vi.fn(async (): Promise<EmbeddingResult> => ({
    vector: vectors[i++],
  })) as DailyDeps["embed"];
}

const noSleep = async () => {};
const now = () => new Date("2026-07-08T21:00:00.000Z");

/** ソースを何も返さない Fetchers（buildSourceTasks/runDaily の既定注入用）。 */
function emptyFetchers(): Fetchers {
  return {
    fetchReleases: vi.fn(async () => []),
    fetchStories: vi.fn(async () => []),
    fetchFeed: vi.fn(async () => []),
  };
}

const noBodyFetchers: BodyFetchers = {
  resolveFeedBody: async () => null,
  fetchHnBody: async () => "",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildSourceTasks", () => {
  it("wires config sources to fetchers with parsed args and injected windowStart", () => {
    const windowStart = new Date("2026-07-08T00:00:00.000Z");
    const config = makeConfig({
      sources: {
        feeds: ["https://a.example/rss", "https://b.example/atom"],
        githubRepos: ["owner/repo1"],
        hnMinPoints: 50,
      },
    });
    const fetchers = emptyFetchers();

    const tasks = buildSourceTasks(config, fetchers, windowStart);
    // 1 github + 1 hn + 2 feeds = 4
    expect(tasks).toHaveLength(4);
    for (const task of tasks) task.fetch();

    expect(fetchers.fetchReleases).toHaveBeenCalledWith("owner", "repo1", windowStart);
    expect(fetchers.fetchStories).toHaveBeenCalledWith(50, windowStart);
    expect(fetchers.fetchFeed).toHaveBeenCalledWith("https://a.example/rss", windowStart);
    expect(fetchers.fetchFeed).toHaveBeenCalledWith("https://b.example/atom", windowStart);
  });
});

describe("makeBodyResolver", () => {
  function target(overrides: Partial<SummaryTarget> = {}): SummaryTarget {
    return {
      articleId: 1,
      title: "t",
      source: "hn",
      url: "https://example.invalid/a",
      feedSummary: null,
      ...overrides,
    };
  }

  it("uses in-memory body without fetching (github release note / feed inline content)", async () => {
    const resolveFeedBody = vi.fn(async () => "should-not-be-called");
    const fetchHnBody = vi.fn(async () => "should-not-be-called");
    const memById = new Map([[7, { body: "MEMORY_BODY" }]]);
    const resolve = makeBodyResolver(memById, { resolveFeedBody, fetchHnBody });

    const body = await resolve(target({ articleId: 7, source: "github:o/r" }));

    expect(body).toBe("MEMORY_BODY");
    expect(resolveFeedBody).not.toHaveBeenCalled();
    expect(fetchHnBody).not.toHaveBeenCalled();
  });

  it("resolves feed articles via resolveFeedBody when no in-memory body", async () => {
    const resolveFeedBody = vi.fn(async () => "FEED_BODY");
    const resolve = makeBodyResolver(new Map(), {
      resolveFeedBody,
      fetchHnBody: async () => "",
    });

    const body = await resolve(
      target({ source: "feed:https://x.example/rss", url: "https://x.example/a" }),
    );

    expect(body).toBe("FEED_BODY");
    expect(resolveFeedBody).toHaveBeenCalledTimes(1);
  });

  it("fetches the external link for hn but skips self-post item pages", async () => {
    const fetchHnBody = vi.fn(async () => "EXTERNAL_BODY");
    const resolve = makeBodyResolver(new Map(), {
      resolveFeedBody: async () => null,
      fetchHnBody,
    });

    const external = await resolve(
      target({ source: "hn", url: "https://example.invalid/post" }),
    );
    const selfPost = await resolve(
      target({ source: "hn", url: "https://news.ycombinator.com/item?id=42" }),
    );

    expect(external).toBe("EXTERNAL_BODY");
    expect(selfPost).toBeNull();
    expect(fetchHnBody).toHaveBeenCalledTimes(1);
  });

  it("returns null when a link fetch yields empty (falls back downstream)", async () => {
    const resolve = makeBodyResolver(new Map(), {
      resolveFeedBody: async () => null,
      fetchHnBody: async () => "",
    });
    const body = await resolve(
      target({ source: "hn", url: "https://example.invalid/x" }),
    );
    expect(body).toBeNull();
  });
});

describe("runDaily — single pass orchestration", () => {
  function normalized(overrides: Partial<NormalizedArticle>): NormalizedArticle {
    return {
      url: "https://example.invalid/x",
      title: "t",
      source: "hn",
      publishedAt: "2026-07-08T00:00:00.000Z",
      ...overrides,
    };
  }

  it("fetches, inserts metadata only, embeds, dedups, scores, writes ranked feed + all-entries summaries + trends", async () => {
    const fetchers = emptyFetchers();
    // Distinct, longer text so SimHash does not treat them as near-duplicates.
    fetchers.fetchStories = vi.fn(async () => [
      normalized({
        url: "u1",
        title: "Imaginary framework reaches version one",
        source: "hn",
        feedSummary: "a self post about testing fictional widgets",
      }),
    ]);
    fetchers.fetchFeed = vi.fn(async () => [
      normalized({
        url: "u2",
        title: "Why my pretend cache never warms up",
        source: "feed:https://feed.example/rss",
        feedSummary: "notes on invented cache warming strategies",
        body: "BODY2",
      }),
    ]);
    fetchers.fetchReleases = vi.fn(async () => [
      normalized({
        url: "u3",
        title: "Sprocket release notes for the flux module",
        source: "github:o/r",
        feedSummary: "adds the imaginary flux capacitor module",
        body: "BODY3",
      }),
    ]);

    // Working set (what the DB returns after insert): the three fetched articles.
    const workingSet = [
      row({ id: 1, title: "t1", source: "hn", url: "u1" }),
      row({ id: 2, title: "t2", source: "feed:https://feed.example/rss", url: "u2" }),
      row({ id: 3, title: "t3", source: "github:o/r", url: "u3" }),
    ];
    const axes: AxisRow[] = [
      { axis_id: "ai", embedding: "[1,0,0]", embedding_model: "m" },
      { axis_id: "web", embedding: "[0,1,0]", embedding_model: "m" },
    ];
    const db = makeFakeDb(workingSet, axes);

    // Distinct vectors -> no dedup. a1~ai, a2~web, a3~orthogonal.
    const embed = embedReturning([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    const aiRun = vi.fn(async () => ({ response: "要約" }));
    const env = { AI: { run: aiRun } } as unknown as Env;

    await runDaily(env, {
      db: db as unknown as D1Database,
      fetchers,
      bodyFetchers: {
        resolveFeedBody: async () => "should-not-be-called",
        fetchHnBody: async () => "HN_LINK_BODY",
      },
      loadConfig: async () =>
        makeConfig({
          sources: {
            feeds: ["https://feed.example/rss"],
            githubRepos: ["o/r"],
            hnMinPoints: 0,
          },
        }),
      syncInterestAxes: vi.fn(async () => {}),
      embed,
      sleep: noSleep,
      now,
    });

    // Metadata inserts: exactly 5 bind args (no feed_summary column).
    const inserts = db.ops.filter((o) => o.kind === "insert-article");
    expect(inserts).toHaveLength(3);
    for (const ins of inserts) expect(ins.args).toHaveLength(5);

    // Embedding saved for all 3 (embedding IS NULL) with model name.
    const embUpdates = db.ops.filter((o) => o.kind === "update-embedding");
    expect(embUpdates).toHaveLength(3);
    expect(embUpdates.some((o) => o.args.includes("[1,0,0]"))).toBe(true);
    expect(embUpdates[0].args).toContain("m");

    // feed_entries: delete before any insert; one per kept article.
    const entryOps = db.ops.filter(
      (o) => o.kind === "delete-entries" || o.kind === "insert-entry",
    );
    expect(entryOps[0].kind).toBe("delete-entries");
    const feedInserts = db.ops.filter((o) => o.kind === "insert-entry");
    expect(feedInserts).toHaveLength(3);
    // Rank by score desc: a2 (web) > a1 (hn) > a3 (orthogonal). args: [date, article_id, rank]
    const byRank = new Map(feedInserts.map((o) => [o.args[2], o.args[1]]));
    expect(byRank.get(1)).toBe(2);
    expect(byRank.get(2)).toBe(1);
    expect(byRank.get(3)).toBe(3);
    expect(feedInserts[0].args[0]).toBe("2026-07-08");

    // All entries summarized (not just top N).
    expect(db.ops.filter((o) => o.kind === "update-summary")).toHaveLength(3);

    // Trends: delete-first then one row per axis with hit counts.
    const trendOps = db.ops.filter(
      (o) => o.kind === "delete-trends" || o.kind === "insert-trend",
    );
    expect(trendOps[0].kind).toBe("delete-trends");
    const trendInserts = db.ops.filter((o) => o.kind === "insert-trend");
    expect(trendInserts).toHaveLength(2);
    const trendByAxis = new Map(trendInserts.map((o) => [o.args[1], o.args[2]]));
    expect(trendByAxis.get("ai")).toBe(2); // a1, a3
    expect(trendByAxis.get("web")).toBe(1); // a2
  });

  it("never persists body or feedSummary to any DB write or console output", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => {
      logs.push(a.join(" "));
    });
    vi.spyOn(console, "warn").mockImplementation((...a) => {
      logs.push(a.join(" "));
    });

    const fetchers = emptyFetchers();
    fetchers.fetchStories = vi.fn(async () => [
      normalized({
        url: "u1",
        title: "t1",
        source: "hn",
        feedSummary: "SENTINEL_FEED_SUMMARY",
        body: "SENTINEL_BODY",
      }),
    ]);
    const workingSet = [row({ id: 1, title: "t1", source: "hn", url: "u1" })];
    const axes: AxisRow[] = [{ axis_id: "ai", embedding: "[1,0,0]", embedding_model: "m" }];
    const db = makeFakeDb(workingSet, axes);
    const env = { AI: { run: vi.fn(async () => ({ response: "要約" })) } } as unknown as Env;

    await runDaily(env, {
      db: db as unknown as D1Database,
      fetchers,
      bodyFetchers: {
        resolveFeedBody: async () => "SENTINEL_BODY",
        fetchHnBody: async () => "SENTINEL_BODY",
      },
      loadConfig: async () =>
        makeConfig({
          sources: {
            feeds: [],
            githubRepos: [],
            hnMinPoints: 0,
          },
        }),
      syncInterestAxes: vi.fn(async () => {}),
      embed: embedReturning([[1, 0, 0]]),
      sleep: noSleep,
      now,
    });

    const writtenArgs = JSON.stringify(db.ops.map((o) => o.args));
    expect(writtenArgs).not.toContain("SENTINEL_BODY");
    expect(writtenArgs).not.toContain("SENTINEL_FEED_SUMMARY");
    const allLogs = logs.join("\n");
    expect(allLogs).not.toContain("SENTINEL_BODY");
    expect(allLogs).not.toContain("SENTINEL_FEED_SUMMARY");
  });

  it("re-run is idempotent: skips embedding for already-embedded articles but rebuilds the feed", async () => {
    const fetchers = emptyFetchers();
    fetchers.fetchStories = vi.fn(async () => [
      normalized({ url: "u1", title: "t1", source: "hn", feedSummary: "s1" }),
    ]);
    // Working set already has an embedding (second-run scenario).
    const workingSet = [
      row({ id: 1, title: "t1", source: "hn", url: "u1", embedding: "[1,0,0]", embedding_model: "m" }),
    ];
    const axes: AxisRow[] = [{ axis_id: "ai", embedding: "[1,0,0]", embedding_model: "m" }];
    const db = makeFakeDb(workingSet, axes);
    const embed = embedReturning([]);
    const env = { AI: { run: vi.fn(async () => ({ response: "要約" })) } } as unknown as Env;

    await runDaily(env, {
      db: db as unknown as D1Database,
      fetchers,
      bodyFetchers: noBodyFetchers,
      loadConfig: async () => makeConfig(),
      syncInterestAxes: vi.fn(async () => {}),
      embed,
      sleep: noSleep,
      now,
    });

    expect(embed).not.toHaveBeenCalled();
    expect(db.ops.filter((o) => o.kind === "update-embedding")).toHaveLength(0);
    // delete-then-insert makes the feed rebuild idempotent.
    const entryOps = db.ops.filter(
      (o) => o.kind === "delete-entries" || o.kind === "insert-entry",
    );
    expect(entryOps[0].kind).toBe("delete-entries");
    expect(db.ops.filter((o) => o.kind === "insert-entry")).toHaveLength(1);
  });

  it("keeps going when one article's embedding fails (skip, no total wipe)", async () => {
    const fetchers = emptyFetchers();
    fetchers.fetchStories = vi.fn(async () => [
      normalized({ url: "u1", title: "落ちる記事", source: "hn", feedSummary: "s1" }),
      normalized({ url: "u2", title: "通る記事", source: "github:o/r", feedSummary: "s2", body: "b" }),
    ]);
    const workingSet = [
      row({ id: 1, title: "落ちる記事", source: "hn", url: "u1" }),
      row({ id: 2, title: "通る記事", source: "github:o/r", url: "u2" }),
    ];
    const axes: AxisRow[] = [{ axis_id: "ai", embedding: "[1,0,0]", embedding_model: "m" }];
    const db = makeFakeDb(workingSet, axes);
    const embed = vi.fn(async (_ai: unknown, _model: string, text: string) => {
      if (text.includes("落ちる")) throw new Error("embedding permanently failed");
      return { vector: [1, 0, 0] };
    }) as unknown as DailyDeps["embed"];
    const env = { AI: { run: vi.fn(async () => ({ response: "要約" })) } } as unknown as Env;

    await runDaily(env, {
      db: db as unknown as D1Database,
      fetchers,
      bodyFetchers: noBodyFetchers,
      loadConfig: async () => makeConfig(),
      syncInterestAxes: vi.fn(async () => {}),
      embed,
      sleep: noSleep,
      now,
    });

    expect(db.ops.filter((o) => o.kind === "update-embedding")).toHaveLength(1);
    const feedInserts = db.ops.filter((o) => o.kind === "insert-entry");
    expect(feedInserts).toHaveLength(1);
    expect(feedInserts[0].args[1]).toBe(2);
  });

  it("keeps going when one article's summary fails (excluded, others still summarized)", async () => {
    const fetchers = emptyFetchers();
    fetchers.fetchStories = vi.fn(async () => [
      normalized({ url: "u1", title: "落ちる記事", source: "hn", feedSummary: "s1" }),
      normalized({ url: "u2", title: "通る記事", source: "hn", feedSummary: "s2" }),
    ]);
    const workingSet = [
      row({ id: 1, title: "落ちる記事", source: "hn", url: "u1" }),
      row({ id: 2, title: "通る記事", source: "hn", url: "u2" }),
    ];
    const axes: AxisRow[] = [{ axis_id: "ai", embedding: "[1,0,0]", embedding_model: "m" }];
    const db = makeFakeDb(workingSet, axes);
    // Article summaries go through AI.run; fail the one for "落ちる".
    const aiRun = vi.fn(
      async (_model: string, input: { messages: { content: string }[] }) => {
        if (input.messages[1].content.includes("落ちる")) {
          throw new Error("LLM permanently failed");
        }
        return { response: "生成テキスト" };
      },
    );
    const env = { AI: { run: aiRun } } as unknown as Env;

    await runDaily(env, {
      db: db as unknown as D1Database,
      fetchers,
      bodyFetchers: noBodyFetchers,
      loadConfig: async () => makeConfig(),
      syncInterestAxes: vi.fn(async () => {}),
      embed: embedReturning([[1, 0, 0], [0, 1, 0]]),
      sleep: noSleep,
      now,
    });

    // Both entries in the feed, but only the surviving one gets a summary UPDATE.
    expect(db.ops.filter((o) => o.kind === "insert-entry")).toHaveLength(2);
    const summaryUpdates = db.ops.filter((o) => o.kind === "update-summary");
    expect(summaryUpdates).toHaveLength(1);
    expect(summaryUpdates[0].args[2]).toBe(2); // article_id 2 survived
  });

  it("throws only when every source fails", async () => {
    const fetchers = emptyFetchers();
    fetchers.fetchStories = vi.fn(async () => {
      throw new Error("hn down");
    });
    const db = makeFakeDb([], []);
    const env = { AI: { run: vi.fn() } } as unknown as Env;

    await expect(
      runDaily(env, {
        db: db as unknown as D1Database,
        fetchers,
        bodyFetchers: noBodyFetchers,
        loadConfig: async () =>
          makeConfig({
            sources: {
              feeds: [],
              githubRepos: [],
              hnMinPoints: 0,
            },
          }),
        syncInterestAxes: vi.fn(async () => {}),
        embed: embedReturning([]),
        sleep: noSleep,
        now,
      }),
    ).rejects.toThrow();
  });
});
