import { describe, it, expect, vi } from "vitest";
import { runFetchPipeline, buildSourceTasks, type Fetchers } from "./fetch";
import type { Config } from "../config";
import type { Env } from "../index";
import type { NormalizedArticle } from "../adapters/types";
import { simhash } from "../lib/simhash";

/** テスト用の最小 Config。sources だけがパイプラインの分岐に効く。 */
function makeConfig(sources: Partial<Config["sources"]>): Config {
  return {
    interestAxes: [],
    sources: {
      githubRepos: [],
      hnMinPoints: 0,
      mediumAuthorFeeds: [],
      mediumTagFeeds: [],
      fowlerFeed: false,
      ...sources,
    },
    scoring: {
      weights: { interest: 0.6, freshness: 0.3, sourceTrust: 0.1 },
      freshnessHalfLifeDays: 7,
      semanticDedupThreshold: 0.9,
      sourceTrust: { github: 1, fowler: 1, medium: 1, hn: 1 },
    },
    embedding: { model: "m", maxInputChars: 100 },
    digest: { model: "m", summaryTopN: 10, maxOutputTokens: 100 },
  };
}

/**
 * env.DB の in-memory フェイク。
 * - all() は「直近 7 日の content_hash」クエリ用に seed した行を返す。
 * - run() は articles を url キーで保持し、ON CONFLICT(url) DO NOTHING を模して
 *   meta.changes（新規=1 / 既存=0）を返す。
 */
function makeFakeDb(recentHashes: string[] = []) {
  const byUrl = new Map<string, unknown[]>();
  const insertSqls: string[] = [];
  const db = {
    byUrl,
    insertSqls,
    prepare(sql: string) {
      return {
        sql,
        args: [] as unknown[],
        bind(...args: unknown[]) {
          this.args = args;
          return this;
        },
        async all() {
          return {
            results: recentHashes.map((h) => ({ content_hash: h })),
            success: true,
            meta: {},
          };
        },
        async run() {
          insertSqls.push(sql);
          const url = this.args[0] as string;
          let changes = 0;
          if (!byUrl.has(url)) {
            byUrl.set(url, this.args);
            changes = 1;
          }
          return { success: true, meta: { changes } };
        },
      };
    },
  };
  return db;
}

function article(overrides: Partial<NormalizedArticle> = {}): NormalizedArticle {
  return {
    url: "https://example.invalid/a",
    title: "Some title",
    source: "hn",
    publishedAt: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

/** 呼ばれない fetcher（呼ばれたら test が壊れるように throw）。 */
function unusedFetchers(): Fetchers {
  const fail = () => {
    throw new Error("unexpected fetcher call");
  };
  return {
    fetchReleases: fail as unknown as Fetchers["fetchReleases"],
    fetchStories: fail as unknown as Fetchers["fetchStories"],
    fetchAuthorFeed: fail as unknown as Fetchers["fetchAuthorFeed"],
    fetchTagFeed: fail as unknown as Fetchers["fetchTagFeed"],
    fetchFowlerFeed: fail as unknown as Fetchers["fetchFowlerFeed"],
  };
}

describe("buildSourceTasks", () => {
  it("maps config sources to the right fetchers with parsed args", () => {
    const config = makeConfig({
      githubRepos: ["owner/repo1"],
      hnMinPoints: 50,
      mediumAuthorFeeds: ["@author1"],
      mediumTagFeeds: ["tag-name"],
      fowlerFeed: true,
    });
    const fetchers: Fetchers = {
      fetchReleases: vi.fn(async () => []),
      fetchStories: vi.fn(async () => []),
      fetchAuthorFeed: vi.fn(async () => []),
      fetchTagFeed: vi.fn(async () => []),
      fetchFowlerFeed: vi.fn(async () => []),
    };

    const tasks = buildSourceTasks(config, fetchers);
    // github + hn + medium-author + medium-tag + fowler = 5
    expect(tasks).toHaveLength(5);

    // Invoke each task to assert argument wiring.
    for (const task of tasks) {
      task.fetch();
    }
    expect(fetchers.fetchReleases).toHaveBeenCalledWith("owner", "repo1");
    expect(fetchers.fetchStories).toHaveBeenCalledWith(50);
    // Leading "@" is stripped for the author handle.
    expect(fetchers.fetchAuthorFeed).toHaveBeenCalledWith("author1");
    expect(fetchers.fetchTagFeed).toHaveBeenCalledWith("tag-name");
    expect(fetchers.fetchFowlerFeed).toHaveBeenCalled();
  });

  it("omits sources that are empty / disabled", () => {
    const config = makeConfig({ hnMinPoints: 10 });
    const tasks = buildSourceTasks(config, unusedFetchers());
    expect(tasks).toHaveLength(1);
    expect(tasks[0].label).toContain("hn");
  });
});

describe("runFetchPipeline — persistence", () => {
  it("inserts new articles with exactly url/title/source/published_at/feed_summary/content_hash and ON CONFLICT DO NOTHING (no body column)", async () => {
    const db = makeFakeDb();
    const fetchers = unusedFetchers();
    fetchers.fetchStories = async () => [
      article({ url: "https://example.invalid/x", title: "Hello", feedSummary: "world" }),
    ];
    const config = makeConfig({ hnMinPoints: 10 });

    const summary = await runFetchPipeline({ DB: db } as unknown as Env, {
      loadConfig: async () => config,
      fetchers,
    });

    expect(summary.inserted).toBe(1);
    expect(summary.fetched).toBe(1);
    expect(summary.duplicateSkipped).toBe(0);
    // The insert SQL must scope to the allowed columns and be idempotent on url.
    const sql = db.insertSqls[0];
    expect(sql).toContain("INSERT INTO articles");
    expect(sql).toContain("ON CONFLICT(url) DO NOTHING");
    expect(sql).not.toMatch(/\bbody\b/);
    // Stored row has no body value (bind arg count == 6 columns).
    const row = db.byUrl.get("https://example.invalid/x") as unknown[];
    expect(row).toHaveLength(6);
    expect(row).not.toContain("world-should-not-be-body");
  });

  it("is idempotent: re-running the same fetch does not grow the table", async () => {
    const db = makeFakeDb();
    const fetchers = unusedFetchers();
    fetchers.fetchStories = async () => [article({ url: "https://example.invalid/dup" })];
    const config = makeConfig({ hnMinPoints: 10 });
    const env = { DB: db } as unknown as Env;

    const first = await runFetchPipeline(env, { loadConfig: async () => config, fetchers });
    const second = await runFetchPipeline(env, { loadConfig: async () => config, fetchers });

    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(0); // ON CONFLICT DO NOTHING
    expect(db.byUrl.size).toBe(1);
  });
});

describe("runFetchPipeline — dedup by SimHash", () => {
  it("skips an article whose hash is within hamming ≤3 of a recent DB hash", async () => {
    const recent = simhash("Breaking news about widgets ");
    const db = makeFakeDb([recent]);
    const fetchers = unusedFetchers();
    fetchers.fetchStories = async () => [
      article({ url: "https://example.invalid/new", title: "Breaking news about widgets", feedSummary: "" }),
    ];
    const config = makeConfig({ hnMinPoints: 10 });

    const summary = await runFetchPipeline({ DB: db } as unknown as Env, {
      loadConfig: async () => config,
      fetchers,
    });

    expect(summary.duplicateSkipped).toBe(1);
    expect(summary.inserted).toBe(0);
    expect(db.byUrl.size).toBe(0);
  });

  it("skips a same-batch near-duplicate (second occurrence)", async () => {
    const db = makeFakeDb();
    const fetchers = unusedFetchers();
    fetchers.fetchStories = async () => [
      article({ url: "https://example.invalid/1", title: "identical headline text", feedSummary: "" }),
      article({ url: "https://example.invalid/2", title: "identical headline text", feedSummary: "" }),
    ];
    const config = makeConfig({ hnMinPoints: 10 });

    const summary = await runFetchPipeline({ DB: db } as unknown as Env, {
      loadConfig: async () => config,
      fetchers,
    });

    expect(summary.fetched).toBe(2);
    expect(summary.inserted).toBe(1);
    expect(summary.duplicateSkipped).toBe(1);
    expect(db.byUrl.size).toBe(1);
  });
});

describe("runFetchPipeline — source failure handling", () => {
  it("continues when one source fails and still inserts the others", async () => {
    const db = makeFakeDb();
    const fetchers = unusedFetchers();
    fetchers.fetchReleases = async () => {
      throw new Error("github down");
    };
    fetchers.fetchStories = async () => [article({ url: "https://example.invalid/ok" })];
    const config = makeConfig({ githubRepos: ["o/r"], hnMinPoints: 10 });

    const summary = await runFetchPipeline({ DB: db } as unknown as Env, {
      loadConfig: async () => config,
      fetchers,
    });

    expect(summary.inserted).toBe(1);
    expect(summary.failedSources).toHaveLength(1);
    expect(summary.failedSources[0]).toContain("github");
  });

  it("throws only when every source fails", async () => {
    const db = makeFakeDb();
    const fetchers = unusedFetchers();
    fetchers.fetchReleases = async () => {
      throw new Error("github down");
    };
    fetchers.fetchStories = async () => {
      throw new Error("hn down");
    };
    const config = makeConfig({ githubRepos: ["o/r"], hnMinPoints: 10 });

    await expect(
      runFetchPipeline({ DB: db } as unknown as Env, {
        loadConfig: async () => config,
        fetchers,
      }),
    ).rejects.toThrow();
  });

  it("processes sources sequentially in config order", async () => {
    const db = makeFakeDb();
    const order: string[] = [];
    const fetchers = unusedFetchers();
    fetchers.fetchReleases = async () => {
      order.push("github");
      return [];
    };
    fetchers.fetchStories = async () => {
      order.push("hn");
      return [];
    };
    const config = makeConfig({ githubRepos: ["o/r"], hnMinPoints: 10 });

    await runFetchPipeline({ DB: db } as unknown as Env, {
      loadConfig: async () => config,
      fetchers,
    });

    expect(order).toEqual(["github", "hn"]);
  });
});
