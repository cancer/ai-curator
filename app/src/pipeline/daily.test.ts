import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ingestFeed,
  scoreAndBuildFeed,
  summarizeFeed,
  buildTrends,
  gateAxisRelevance,
  type Fetchers,
  type IngestDeps,
} from "./daily";
import { sseStream } from "../../test/sse";
import type { judgeAxisRelevance } from "../lib/relevance";
import type {
  DigestConfig,
  EmbeddingConfig,
  InterestAxis,
  ScoringConfig,
} from "../config";
import type { Env } from "../index";
import type { NormalizedArticle } from "../adapters/types";
import type { EmbeddingResult } from "../lib/embedding";

const FEED_URL = "https://feed.example/rss";
const FEED_SRC = `feed:${FEED_URL}`;

const EMBEDDING: EmbeddingConfig = { model: "m", maxInputChars: 1000 };
const DIGEST: DigestConfig = { model: "d", maxOutputTokens: 300 };
const SCORING: ScoringConfig = {
  weights: { interest: 0.6, freshness: 0.3, sourceTrust: 0.1 },
  freshnessHalfLifeDays: 7,
  semanticDedupThreshold: 0.9,
  sourceTrust: { feed: 0.7 },
};

interface Op {
  kind: string;
  args: unknown[];
}

/** ingest 段の記事行（IN-select で返す最小行）。 */
interface StoredArticle {
  id: number;
  url: string;
  title: string;
  embedding: string | null;
}

const noSleep = async () => {};

function ai(run: (...args: never[]) => Promise<unknown>): Env["AI"] {
  return { run } as unknown as Env["AI"];
}

/** 呼び出し順にベクトルを返す embed モック（1 記事 1 呼び出し）。 */
function embedReturning(vectors: number[][]): IngestDeps["embed"] {
  let i = 0;
  return vi.fn(
    async (): Promise<EmbeddingResult> => ({ vector: vectors[i++] }),
  ) as IngestDeps["embed"];
}

function normalized(overrides: Partial<NormalizedArticle>): NormalizedArticle {
  return {
    url: "https://example.invalid/x",
    title: "t",
    source: FEED_SRC,
    publishedAt: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

function feedFetchers(articles: NormalizedArticle[]): Fetchers {
  return { fetchFeed: vi.fn(async () => articles) };
}

/**
 * ingest 用の in-memory D1 フェイク。articles を url→行 で持ち、INSERT で追加、
 * `url IN (...)` SELECT で引き当てる。UPDATE embedding は行に反映する（再実行で
 * 二重 embed しないことを検証できるように）。
 */
function makeIngestDb(
  opts: {
    recentHashes?: { url: string; hash: string }[];
    preexisting?: StoredArticle[];
  } = {},
) {
  const ops: Op[] = [];
  const recentHashes = opts.recentHashes ?? [];
  const articles = new Map<string, StoredArticle>(
    (opts.preexisting ?? []).map((a) => [a.url, { ...a }]),
  );
  let nextId = 100;
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
              results: recentHashes.map((r) => ({
                url: r.url,
                content_hash: r.hash,
              })) as unknown as T[],
            };
          }
          if (s.includes("url IN")) {
            const urls = this._args as string[];
            const rows = urls
              .map((u) => articles.get(u))
              .filter((r): r is StoredArticle => r !== undefined);
            return { results: rows as unknown as T[] };
          }
          return { results: [] as T[] };
        },
        async run() {
          let kind = "other";
          let changes = 1;
          if (/^INSERT INTO articles/i.test(s)) {
            kind = "insert-article";
            const url = this._args[0] as string;
            if (articles.has(url)) {
              changes = 0;
            } else {
              articles.set(url, {
                id: nextId++,
                url,
                title: this._args[1] as string,
                embedding: null,
              });
              changes = 1;
            }
          } else if (/^UPDATE articles SET embedding/i.test(s)) {
            kind = "update-embedding";
            const id = this._args[2];
            for (const row of articles.values()) {
              if (row.id === id) row.embedding = this._args[0] as string;
            }
          }
          ops.push({ kind, args: this._args });
          return { success: true, meta: { changes } };
        },
      };
    },
  };
  return { db: db as unknown as D1Database, ops, articles };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ingestFeed", () => {
  it("inserts metadata only (5 args), embeds NULL rows, returns counts", async () => {
    const { db, ops } = makeIngestDb();
    const fetchers = feedFetchers([
      normalized({
        url: "u1",
        title: "Imaginary framework reaches version one",
        feedSummary: "a post about testing fictional widgets",
      }),
      normalized({
        url: "u2",
        title: "Why my pretend cache never warms up",
        feedSummary: "notes on invented cache warming strategies",
      }),
    ]);
    const embed = embedReturning([
      [1, 0, 0],
      [0, 1, 0],
    ]);

    const result = await ingestFeed(
      db,
      ai(vi.fn()),
      FEED_URL,
      new Date("2026-07-08T00:00:00.000Z"),
      EMBEDDING,
      // snippet-only articles (no real body) → body resolution finds nothing.
      { fetchers, embed, sleep: noSleep, resolveArticleBody: async () => null },
    );

    const inserts = ops.filter((o) => o.kind === "insert-article");
    expect(inserts).toHaveLength(2);
    for (const ins of inserts) expect(ins.args).toHaveLength(5);

    const embUpdates = ops.filter((o) => o.kind === "update-embedding");
    expect(embUpdates).toHaveLength(2);
    expect(embUpdates[0].args).toContain("m"); // embedding_model

    expect(result).toMatchObject({
      feedUrl: FEED_URL,
      fetched: 2,
      inserted: 2,
      duplicateSkipped: 0,
      embedded: 2,
      embedFailed: 0,
    });
  });

  it("skips SimHash near-duplicates of recent hashes (no insert, no embed)", async () => {
    // First compute the hash the code will produce for the article, then seed it
    // as a recent hash so the dedup path triggers.
    const { simhash } = await import("../lib/simhash");
    const article = normalized({
      url: "dup",
      title: "identical title here",
      feedSummary: "identical summary body",
    });
    const hash = simhash(`${article.title} ${article.feedSummary}`);
    // A *different* url already carries this hash → the fetched one is a near-duplicate.
    const { db, ops } = makeIngestDb({
      recentHashes: [{ url: "https://other.invalid/prior", hash }],
    });
    const embed = embedReturning([]);

    const result = await ingestFeed(
      db,
      ai(vi.fn()),
      FEED_URL,
      new Date("2026-07-08T00:00:00.000Z"),
      EMBEDDING,
      { fetchers: feedFetchers([article]), embed, sleep: noSleep },
    );

    expect(ops.filter((o) => o.kind === "insert-article")).toHaveLength(0);
    expect(embed).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      fetched: 1,
      inserted: 0,
      duplicateSkipped: 1,
      embedded: 0,
    });
  });

  it("never writes body or feedSummary to any DB write or console output", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...a) => {
      logs.push(a.join(" "));
    });
    const { db, ops } = makeIngestDb();
    const fetchers = feedFetchers([
      normalized({
        url: "u1",
        title: "t1",
        feedSummary: "SENTINEL_FEED_SUMMARY",
        body: "SENTINEL_BODY",
      }),
    ]);

    await ingestFeed(
      db,
      ai(vi.fn()),
      FEED_URL,
      new Date("2026-07-08T00:00:00.000Z"),
      EMBEDDING,
      { fetchers, embed: embedReturning([[1, 0, 0]]), sleep: noSleep },
    );

    const writtenArgs = JSON.stringify(ops.map((o) => o.args));
    expect(writtenArgs).not.toContain("SENTINEL_BODY");
    expect(writtenArgs).not.toContain("SENTINEL_FEED_SUMMARY");
    expect(logs.join("\n")).not.toContain("SENTINEL_BODY");
    expect(logs.join("\n")).not.toContain("SENTINEL_FEED_SUMMARY");
  });

  it("re-embeds a re-fetched article whose own hash is already persisted (retry safety)", async () => {
    // Simulate an interrupted prior run: A was inserted (hash persisted for its own url)
    // but embedding never ran (embedding NULL). Re-running ingest must NOT treat A as a
    // duplicate of itself, and must embed it.
    const article = normalized({ url: "u1", title: "t1", feedSummary: "s1" });
    const { simhash } = await import("../lib/simhash");
    const hash = simhash(`${article.title} ${article.feedSummary}`);
    const { db, ops } = makeIngestDb({
      recentHashes: [{ url: "u1", hash }], // same url as the fetched article
      preexisting: [{ id: 1, url: "u1", title: "t1", embedding: null }],
    });
    const embed = embedReturning([[1, 0, 0]]);

    const result = await ingestFeed(
      db,
      ai(vi.fn()),
      FEED_URL,
      new Date("2026-07-08T00:00:00.000Z"),
      EMBEDDING,
      {
        fetchers: feedFetchers([article]),
        embed,
        sleep: noSleep,
        resolveArticleBody: async () => null,
      },
    );

    expect(embed).toHaveBeenCalledTimes(1);
    expect(ops.filter((o) => o.kind === "update-embedding")).toHaveLength(1);
    expect(result).toMatchObject({ duplicateSkipped: 0, embedded: 1 });
  });

  it("is idempotent: already-embedded rows are not re-embedded", async () => {
    const { db, ops } = makeIngestDb({
      preexisting: [
        { id: 1, url: "u1", title: "t1", embedding: "[1,0,0]" },
      ],
    });
    const embed = embedReturning([]);

    const result = await ingestFeed(
      db,
      ai(vi.fn()),
      FEED_URL,
      new Date("2026-07-08T00:00:00.000Z"),
      EMBEDDING,
      {
        fetchers: feedFetchers([
          normalized({ url: "u1", title: "t1", feedSummary: "s1" }),
        ]),
        embed,
        sleep: noSleep,
      },
    );

    expect(embed).not.toHaveBeenCalled();
    expect(ops.filter((o) => o.kind === "update-embedding")).toHaveLength(0);
    expect(result.embedded).toBe(0);
  });

  it("keeps going when one article's embedding fails (skip, count it)", async () => {
    const { db, ops } = makeIngestDb();
    const fetchers = feedFetchers([
      normalized({ url: "u1", title: "落ちる記事", feedSummary: "s1" }),
      normalized({ url: "u2", title: "通る記事", feedSummary: "s2" }),
    ]);
    const embed = vi.fn(
      async (_ai: unknown, _model: string, text: string) => {
        if (text.includes("落ちる")) throw new Error("embed failed");
        return { vector: [1, 0, 0] };
      },
    ) as IngestDeps["embed"];

    const result = await ingestFeed(
      db,
      ai(vi.fn()),
      FEED_URL,
      new Date("2026-07-08T00:00:00.000Z"),
      EMBEDDING,
      { fetchers, embed, sleep: noSleep, resolveArticleBody: async () => null },
    );

    expect(ops.filter((o) => o.kind === "update-embedding")).toHaveLength(1);
    expect(result).toMatchObject({ embedded: 1, embedFailed: 1 });
  });

  it("throws when the feed fetch fails (step retry / all-fail handled by caller)", async () => {
    const { db } = makeIngestDb();
    const fetchers: Fetchers = {
      fetchFeed: vi.fn(async () => {
        throw new Error("feed down");
      }),
    };

    await expect(
      ingestFeed(
        db,
        ai(vi.fn()),
        FEED_URL,
        new Date("2026-07-08T00:00:00.000Z"),
        EMBEDDING,
        { fetchers, embed: embedReturning([]), sleep: noSleep },
      ),
    ).rejects.toThrow("feed down");
  });

  /** 埋め込み入力（text）を記録する embed モック（1 記事 1 呼び出し）。 */
  function embedCapturing(texts: string[]): IngestDeps["embed"] {
    return vi.fn(async (_ai: unknown, _model: string, text: string) => {
      texts.push(text);
      return { vector: [1, 0, 0] };
    }) as IngestDeps["embed"];
  }

  it("embeds the resolved inline body when it meets the minimum length", async () => {
    const { db } = makeIngestDb();
    const body = "本文".repeat(300); // 600 chars ≥ MIN_BODY_CHARS
    const texts: string[] = [];

    await ingestFeed(
      db,
      ai(vi.fn()),
      FEED_URL,
      new Date("2026-07-08T00:00:00.000Z"),
      EMBEDDING,
      {
        fetchers: feedFetchers([
          normalized({ url: "u1", title: "T", feedSummary: "短い要約", body }),
        ]),
        embed: embedCapturing(texts),
        sleep: noSleep,
      },
    );

    // The full-text body drives the embedding input (not title + feedSummary).
    expect(texts).toEqual([body]);
  });

  it("falls back to title+feedSummary for embedding when there is no body", async () => {
    const { db } = makeIngestDb();
    const texts: string[] = [];

    await ingestFeed(
      db,
      ai(vi.fn()),
      FEED_URL,
      new Date("2026-07-08T00:00:00.000Z"),
      EMBEDDING,
      {
        fetchers: feedFetchers([
          normalized({ url: "u1", title: "T", feedSummary: "snippet" }),
        ]),
        embed: embedCapturing(texts),
        sleep: noSleep,
        // No real body for a snippet-only article → embedding uses title + feedSummary.
        resolveArticleBody: async () => null,
      },
    );

    expect(texts).toEqual(["T\nsnippet"]);
  });

  it("falls back to the snippet when the resolved body is below the minimum length", async () => {
    const { db } = makeIngestDb();
    const texts: string[] = [];

    await ingestFeed(
      db,
      ai(vi.fn()),
      FEED_URL,
      new Date("2026-07-08T00:00:00.000Z"),
      EMBEDDING,
      {
        fetchers: feedFetchers([
          normalized({
            url: "u1",
            title: "T",
            feedSummary: "snip",
            body: "tiny body",
          }),
        ]),
        embed: embedCapturing(texts),
        sleep: noSleep,
      },
    );

    expect(texts).toEqual(["T\nsnip"]);
  });

  it("keeps embedding with the snippet when body resolution throws", async () => {
    const { db } = makeIngestDb();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const texts: string[] = [];
    const resolveArticleBody = vi.fn(async () => {
      throw new Error("body fetch failed");
    }) as IngestDeps["resolveArticleBody"];

    const result = await ingestFeed(
      db,
      ai(vi.fn()),
      FEED_URL,
      new Date("2026-07-08T00:00:00.000Z"),
      EMBEDDING,
      {
        fetchers: feedFetchers([
          normalized({ url: "u1", title: "T", feedSummary: "snip" }),
        ]),
        embed: embedCapturing(texts),
        sleep: noSleep,
        resolveArticleBody,
      },
    );

    expect(texts).toEqual(["T\nsnip"]);
    expect(result).toMatchObject({ embedded: 1, embedFailed: 0 });
  });

  it("uses a resolved long body for embedding but never persists it", async () => {
    const { db, ops } = makeIngestDb();
    const body = "SENTINEL_BODY ".repeat(50); // ≥ MIN_BODY_CHARS, carries the sentinel
    const texts: string[] = [];

    await ingestFeed(
      db,
      ai(vi.fn()),
      FEED_URL,
      new Date("2026-07-08T00:00:00.000Z"),
      EMBEDDING,
      {
        fetchers: feedFetchers([
          normalized({ url: "u1", title: "T", feedSummary: "snip", body }),
        ]),
        embed: embedCapturing(texts),
        sleep: noSleep,
      },
    );

    // The body drove the embedding input...
    expect(texts[0]).toContain("SENTINEL_BODY");
    // ...but it is never written to D1 (only the vector + model are).
    expect(JSON.stringify(ops.map((o) => o.args))).not.toContain(
      "SENTINEL_BODY",
    );
  });

  it("shares one Medium feed cache across all articles in the feed", async () => {
    const { db } = makeIngestDb();
    const caches: unknown[] = [];
    const resolveArticleBody = vi.fn(
      async (_article: unknown, opts?: { mediumFeedCache?: unknown }) => {
        caches.push(opts?.mediumFeedCache);
        return null;
      },
    ) as IngestDeps["resolveArticleBody"];

    await ingestFeed(
      db,
      ai(vi.fn()),
      FEED_URL,
      new Date("2026-07-08T00:00:00.000Z"),
      EMBEDDING,
      {
        fetchers: feedFetchers([
          normalized({ url: "u1", title: "T1", feedSummary: "s1" }),
          normalized({ url: "u2", title: "T2", feedSummary: "s2" }),
        ]),
        embed: embedReturning([
          [1, 0, 0],
          [0, 1, 0],
        ]),
        sleep: noSleep,
        resolveArticleBody,
      },
    );

    expect(caches).toHaveLength(2);
    expect(caches[0]).toBeInstanceOf(Map);
    expect(caches[0]).toBe(caches[1]); // one instance shared across the loop
  });
});

/** score / summarize / trends 用の、SQL キーワードでルーティングする D1 フェイク。 */
interface WorkingRow {
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
interface EntryRow {
  article_id: number;
  title: string;
  source: string;
  url: string;
  /** テスト内部の絞り込み用（ENTRIES_FOR_DATE_SQL の `s.article_id IS NULL` を模す）。 */
  summary?: string | null;
}
interface TrendRow {
  hit_axis: string | null;
  title: string;
}
interface GateRow {
  article_id: number;
  title: string;
  summary_text: string;
  axis_label: string;
}

function makeReadDb(reads: {
  workingSet?: WorkingRow[];
  axes?: AxisRow[];
  entries?: EntryRow[];
  trendRows?: TrendRow[];
  priorFeedArticleIds?: number[];
  gateRows?: GateRow[];
}) {
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
          if (s.includes("hit_axis AS hit_axis")) {
            return { results: (reads.trendRows ?? []) as unknown as T[] };
          }
          if (s.includes("axis_label")) {
            return { results: (reads.gateRows ?? []) as unknown as T[] };
          }
          if (s.includes("feed_entries fe JOIN")) {
            // `s.article_id IS NULL` を含むクエリ（要約段）は未要約エントリだけ返す。
            const entries = reads.entries ?? [];
            const rows = s.includes("s.article_id IS NULL")
              ? entries.filter((e) => e.summary == null)
              : entries;
            return { results: rows as unknown as T[] };
          }
          if (s.includes("FROM interest_axes")) {
            return { results: (reads.axes ?? []) as unknown as T[] };
          }
          if (s.includes("DISTINCT article_id FROM feed_entries")) {
            const rows = (reads.priorFeedArticleIds ?? []).map((id) => ({
              article_id: id,
            }));
            return { results: rows as unknown as T[] };
          }
          if (s.includes("FROM articles")) {
            return { results: (reads.workingSet ?? []) as unknown as T[] };
          }
          return { results: [] as T[] };
        },
        async run() {
          let kind = "other";
          if (/^UPDATE articles SET score/i.test(s)) kind = "update-score";
          else if (/^DELETE FROM feed_entries/i.test(s)) kind = "delete-entries";
          else if (/^INSERT INTO feed_entries/i.test(s)) kind = "insert-entry";
          else if (/^INSERT INTO summaries/i.test(s)) kind = "insert-summary";
          else if (/^DELETE FROM feed_trends/i.test(s)) kind = "delete-trends";
          else if (/^INSERT INTO feed_trends/i.test(s)) kind = "insert-trend";
          else if (/^UPDATE articles SET axis_relevant/i.test(s))
            kind = "update-axis-relevant";
          ops.push({ kind, args: this._args });
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  };
  return { db: db as unknown as D1Database, ops };
}

function workingRow(overrides: Partial<WorkingRow> = {}): WorkingRow {
  return {
    id: 1,
    title: "t",
    source: FEED_SRC,
    url: "https://example.invalid/1",
    published_at: "2026-07-08T00:00:00.000Z",
    embedding: null,
    embedding_model: null,
    ...overrides,
  };
}

describe("scoreAndBuildFeed", () => {
  it("dedups, scores, and rebuilds feed_entries (delete-first, ranked)", async () => {
    const workingSet = [
      workingRow({
        id: 1,
        url: "u1",
        embedding: "[1,0,0]",
        embedding_model: "m",
        published_at: "2026-07-07T21:00:00.000Z",
      }),
      workingRow({
        id: 2,
        url: "u2",
        embedding: "[0,1,0]",
        embedding_model: "m",
        published_at: "2026-07-08T21:00:00.000Z",
      }),
      workingRow({
        id: 3,
        url: "u3",
        embedding: "[0,0,1]",
        embedding_model: "m",
        published_at: "2026-07-08T00:00:00.000Z",
      }),
    ];
    const axes: AxisRow[] = [
      { axis_id: "ai", embedding: "[1,0,0]", embedding_model: "m" },
      { axis_id: "web", embedding: "[0,1,0]", embedding_model: "m" },
    ];
    const { db, ops } = makeReadDb({ workingSet, axes });

    const result = await scoreAndBuildFeed(
      db,
      SCORING,
      "m",
      new Date("2026-07-08T21:00:00.000Z"),
    );

    const entryOps = ops.filter(
      (o) => o.kind === "delete-entries" || o.kind === "insert-entry",
    );
    expect(entryOps[0].kind).toBe("delete-entries");
    const feedInserts = ops.filter((o) => o.kind === "insert-entry");
    expect(feedInserts).toHaveLength(3);
    // Rank by score desc: a2 (web, freshest) > a1 (ai, older) > a3 (orthogonal).
    const byRank = new Map(feedInserts.map((o) => [o.args[2], o.args[1]]));
    expect(byRank.get(1)).toBe(2);
    expect(byRank.get(2)).toBe(1);
    expect(byRank.get(3)).toBe(3);
    expect(feedInserts[0].args[0]).toBe("2026-07-08");
    expect(result).toMatchObject({
      candidates: 3,
      excludedFromFeed: 0,
      feedEntries: 3,
    });
  });

  it("excludes rows without a current-model embedding", async () => {
    const workingSet = [
      workingRow({ id: 1, url: "u1", embedding: null }),
      workingRow({
        id: 2,
        url: "u2",
        embedding: "[1,0,0]",
        embedding_model: "old-model",
      }),
      workingRow({
        id: 3,
        url: "u3",
        embedding: "[0,1,0]",
        embedding_model: "m",
      }),
    ];
    const { db, ops } = makeReadDb({ workingSet, axes: [] });

    const result = await scoreAndBuildFeed(
      db,
      SCORING,
      "m",
      new Date("2026-07-08T21:00:00.000Z"),
    );

    expect(ops.filter((o) => o.kind === "insert-entry")).toHaveLength(1);
    expect(result).toMatchObject({ candidates: 1, excludedFromFeed: 2 });
  });

  it("excludes articles already surfaced in a prior day's feed (#12)", async () => {
    const workingSet = [
      workingRow({
        id: 1,
        url: "u1",
        embedding: "[1,0,0]",
        embedding_model: "m",
      }),
      workingRow({
        id: 2,
        url: "u2",
        embedding: "[0,1,0]",
        embedding_model: "m",
      }),
    ];
    const { db, ops } = makeReadDb({
      workingSet,
      axes: [],
      priorFeedArticleIds: [1],
    });

    const result = await scoreAndBuildFeed(
      db,
      SCORING,
      "m",
      new Date("2026-07-08T21:00:00.000Z"),
    );

    const feedInserts = ops.filter((o) => o.kind === "insert-entry");
    expect(feedInserts).toHaveLength(1);
    expect(feedInserts[0].args[1]).toBe(2);
    expect(result).toMatchObject({ candidates: 1, feedEntries: 1 });
  });
});

describe("summarizeFeed", () => {
  const entries: EntryRow[] = [
    { article_id: 1, title: "t1", source: FEED_SRC, url: "https://x/1" },
    { article_id: 2, title: "t2", source: FEED_SRC, url: "https://x/2" },
  ];

  // 実本文の長さ（≥ MIN_BODY_CHARS）。閾値未満だと task G の劣化止めでスキップされる。
  const LONG_BODY = "本文".repeat(300); // 600 chars

  it("re-fetches body per entry and writes generated summaries", async () => {
    const { db, ops } = makeReadDb({ entries });
    const resolveArticleBody = vi.fn(async () => LONG_BODY);

    const result = await summarizeFeed(db, ai(vi.fn(async () => sseStream("要約"))), DIGEST, "2026-07-08", {
      bodyFetchers: { resolveArticleBody },
      sleep: noSleep,
    });

    // body was re-fetched (never carried from a prior step) for each entry.
    expect(resolveArticleBody).toHaveBeenCalledTimes(2);
    expect(resolveArticleBody).toHaveBeenCalledWith({ url: "https://x/1" });
    const inserts = ops.filter((o) => o.kind === "insert-summary");
    expect(inserts).toHaveLength(2);
    // INSERT bind order is (article_id, text, model); model comes from digest.model.
    expect(inserts[0].args[2]).toBe(DIGEST.model);
    expect(result).toMatchObject({ summarized: 2, summaryFailed: 0 });
  });

  it("does not persist the re-fetched body (only the generated summary)", async () => {
    const { db, ops } = makeReadDb({ entries: [entries[0]] });
    const body = "SENTINEL_BODY ".repeat(50); // ≥ MIN_BODY_CHARS, carries the sentinel

    await summarizeFeed(db, ai(vi.fn(async () => sseStream("要約"))), DIGEST, "2026-07-08", {
      bodyFetchers: { resolveArticleBody: async () => body },
      sleep: noSleep,
    });

    const writtenArgs = JSON.stringify(ops.map((o) => o.args));
    expect(writtenArgs).not.toContain("SENTINEL_BODY");
    expect(writtenArgs).toContain("要約");
  });

  it("keeps going when one entry's summary fails", async () => {
    const { db, ops } = makeReadDb({ entries });
    const run = vi.fn(
      async (_model: string, input: { messages: { content: string }[] }) => {
        if (input.messages[1].content.includes("FAIL")) {
          throw new Error("LLM failed");
        }
        return sseStream("生成テキスト");
      },
    );

    const result = await summarizeFeed(db, ai(run), DIGEST, "2026-07-08", {
      bodyFetchers: {
        resolveArticleBody: async ({ url }) =>
          url.endsWith("/1") ? `FAIL ${LONG_BODY}` : `ok ${LONG_BODY}`,
      },
      sleep: noSleep,
    });

    expect(ops.filter((o) => o.kind === "insert-summary")).toHaveLength(1);
    expect(result).toMatchObject({ summarized: 1, summaryFailed: 1 });
  });

  it("does not emit a summary when the body is below the minimum length (degradation stop)", async () => {
    const { db, ops } = makeReadDb({ entries: [entries[0]] });
    const run = vi.fn(async () => sseStream("要約"));

    const result = await summarizeFeed(db, ai(run), DIGEST, "2026-07-08", {
      bodyFetchers: { resolveArticleBody: async () => "tiny snippet" },
      sleep: noSleep,
    });

    // Below MIN_BODY_CHARS → no LLM call, no summaries row (viewer renders no summary).
    expect(run).not.toHaveBeenCalled();
    expect(ops.filter((o) => o.kind === "insert-summary")).toHaveLength(0);
    expect(result).toMatchObject({ summarized: 0, summaryFailed: 0 });
  });

  it("is retry-progressive: processes only NULL-summary entries (skips already-summarized)", async () => {
    // Simulate a prior partial run: entry 2 already has a summary; only entry 1 is NULL.
    const mixed: EntryRow[] = [
      { article_id: 1, title: "t1", source: FEED_SRC, url: "https://x/1", summary: null },
      { article_id: 2, title: "t2", source: FEED_SRC, url: "https://x/2", summary: "既存要約" },
    ];
    const { db, ops } = makeReadDb({ entries: mixed });
    const resolveArticleBody = vi.fn(async () => LONG_BODY);

    const result = await summarizeFeed(
      db,
      ai(vi.fn(async () => sseStream("要約"))),
      DIGEST,
      "2026-07-08",
      { bodyFetchers: { resolveArticleBody }, sleep: noSleep },
    );

    // Only the un-summarized entry is touched (no re-work of entry 2).
    expect(resolveArticleBody).toHaveBeenCalledTimes(1);
    expect(resolveArticleBody).toHaveBeenCalledWith({ url: "https://x/1" });
    const inserts = ops.filter((o) => o.kind === "insert-summary");
    expect(inserts).toHaveLength(1);
    expect(inserts[0].args[0]).toBe(1);
    expect(result).toMatchObject({ summarized: 1, summaryFailed: 0 });
  });

  it("persists each summary immediately (per-entry UPDATE, not batched at the end)", async () => {
    // The UPDATE for entry 1 must happen before entry 2 is even fetched — proving
    // partial progress is durable if the step is interrupted mid-loop.
    const order: string[] = [];
    const resolveArticleBody = vi.fn(async ({ url }: { url: string }) => {
      order.push(`fetch:${url}`);
      return LONG_BODY;
    });
    const entries2: EntryRow[] = [
      { article_id: 1, title: "t1", source: FEED_SRC, url: "https://x/1" },
      { article_id: 2, title: "t2", source: FEED_SRC, url: "https://x/2" },
    ];
    const { db } = makeReadDb({ entries: entries2 });
    // Wrap prepare to record UPDATE order interleaved with fetches.
    const realPrepare = db.prepare.bind(db);
    (db as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      const stmt = realPrepare(sql) as {
        bind: (...a: unknown[]) => unknown;
        run: () => Promise<unknown>;
      };
      if (/^INSERT INTO summaries/i.test(sql.trim())) {
        const origBind = stmt.bind.bind(stmt);
        stmt.bind = (...a: unknown[]) => {
          order.push(`update:${a[0]}`);
          return origBind(...a);
        };
      }
      return stmt;
    };

    await summarizeFeed(
      db,
      ai(vi.fn(async () => sseStream("要約"))),
      DIGEST,
      "2026-07-08",
      { bodyFetchers: { resolveArticleBody }, sleep: noSleep },
    );

    // entry 1 fetched → entry 1 updated → entry 2 fetched → entry 2 updated.
    expect(order).toEqual([
      "fetch:https://x/1",
      "update:1",
      "fetch:https://x/2",
      "update:2",
    ]);
  });
});

describe("buildTrends", () => {
  const axesConfig: InterestAxis[] = [
    { id: "ai", label: "AI" },
    { id: "web", label: "Web" },
  ];

  it("counts per axis and inserts trends (delete-first)", async () => {
    const trendRows: TrendRow[] = [
      { hit_axis: "ai", title: "a1" },
      { hit_axis: "web", title: "a2" },
      { hit_axis: "ai", title: "a3" },
    ];
    const { db, ops } = makeReadDb({ trendRows });

    const result = await buildTrends(
      db,
      ai(vi.fn(async () => sseStream("傾向"))),
      DIGEST,
      axesConfig,
      "2026-07-08",
      { sleep: noSleep },
    );

    const trendOps = ops.filter(
      (o) => o.kind === "delete-trends" || o.kind === "insert-trend",
    );
    expect(trendOps[0].kind).toBe("delete-trends");
    const inserts = ops.filter((o) => o.kind === "insert-trend");
    expect(inserts).toHaveLength(2);
    const byAxis = new Map(inserts.map((o) => [o.args[1], o.args[2]]));
    expect(byAxis.get("ai")).toBe(2);
    expect(byAxis.get("web")).toBe(1);
    expect(inserts[0].args[0]).toBe("2026-07-08");
    expect(result).toEqual({ trendFailed: 0 });
  });

  it("inserts hit_count only when narrative generation fails", async () => {
    const trendRows: TrendRow[] = [{ hit_axis: "ai", title: "a1" }];
    const { db, ops } = makeReadDb({ trendRows });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await buildTrends(
      db,
      ai(
        vi.fn(async () => {
          throw new Error("LLM failed");
        }),
      ),
      DIGEST,
      axesConfig,
      "2026-07-08",
      { sleep: noSleep },
    );

    const inserts = ops.filter((o) => o.kind === "insert-trend");
    // ai axis: hit_count 1, narrative null (failed). web axis: hit_count 0.
    const aiInsert = inserts.find((o) => o.args[1] === "ai");
    expect(aiInsert?.args[2]).toBe(1);
    expect(aiInsert?.args[3]).toBeNull();
    expect(result).toEqual({ trendFailed: 1 });
  });
});

describe("gateAxisRelevance", () => {
  const rawSummary = (text: string) => JSON.stringify({ v: 1, raw: text });

  it("marks a relevant article (axis_relevant = 1)", async () => {
    const gateRows: GateRow[] = [
      { article_id: 1, title: "t1", summary_text: rawSummary("s1"), axis_label: "AI" },
    ];
    const { db, ops } = makeReadDb({ gateRows });
    const judge = vi.fn(async () => true);

    const result = await gateAxisRelevance(db, ai(vi.fn()), DIGEST, "2026-07-08", {
      judge,
      sleep: noSleep,
    });

    const updates = ops.filter((o) => o.kind === "update-axis-relevant");
    expect(updates).toHaveLength(1);
    expect(updates[0].args).toEqual([1, 1]);
    expect(result).toEqual({ judged: 1, irrelevant: 0, judgeFailed: 0 });
  });

  it("marks an irrelevant article (axis_relevant = 0)", async () => {
    const gateRows: GateRow[] = [
      { article_id: 1, title: "t1", summary_text: rawSummary("s1"), axis_label: "AI" },
    ];
    const { db, ops } = makeReadDb({ gateRows });
    const judge = vi.fn(async () => false);

    const result = await gateAxisRelevance(db, ai(vi.fn()), DIGEST, "2026-07-08", {
      judge,
      sleep: noSleep,
    });

    const updates = ops.filter((o) => o.kind === "update-axis-relevant");
    expect(updates).toHaveLength(1);
    expect(updates[0].args).toEqual([0, 1]);
    expect(result).toEqual({ judged: 1, irrelevant: 1, judgeFailed: 0 });
  });

  it("passes the decoded summary plaintext (not the stored JSON) to judge", async () => {
    const structured = JSON.stringify({
      v: 1,
      audience: "aud",
      overview: "全体の要約テキスト",
      thesis: "命題テキスト",
      conclusion: "結論テキスト",
    });
    const gateRows: GateRow[] = [
      { article_id: 1, title: "t1", summary_text: structured, axis_label: "AI" },
    ];
    const { db } = makeReadDb({ gateRows });
    const judge = vi.fn<typeof judgeAxisRelevance>(async () => true);

    await gateAxisRelevance(db, ai(vi.fn()), DIGEST, "2026-07-08", {
      judge,
      sleep: noSleep,
    });

    expect(judge).toHaveBeenCalledTimes(1);
    const [, , axisLabel, title, summaryText] = judge.mock.calls[0];
    expect(axisLabel).toBe("AI");
    expect(title).toBe("t1");
    expect(summaryText).not.toContain('"v":1');
    expect(summaryText).toContain("全体の要約テキスト");
    expect(summaryText).toContain("命題テキスト");
    expect(summaryText).toContain("結論テキスト");
  });

  it("continues when one article's judge call fails, leaving axis_relevant NULL (fail-open)", async () => {
    const gateRows: GateRow[] = [
      { article_id: 1, title: "t1", summary_text: rawSummary("s1"), axis_label: "AI" },
      { article_id: 2, title: "t2", summary_text: rawSummary("s2"), axis_label: "AI" },
    ];
    const { db, ops } = makeReadDb({ gateRows });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const judge = vi
      .fn()
      .mockRejectedValueOnce(new Error("judge failed"))
      .mockResolvedValueOnce(true);

    const result = await gateAxisRelevance(db, ai(vi.fn()), DIGEST, "2026-07-08", {
      judge,
      sleep: noSleep,
    });

    const updates = ops.filter((o) => o.kind === "update-axis-relevant");
    expect(updates).toHaveLength(1);
    expect(updates[0].args).toEqual([1, 2]);
    expect(result).toEqual({ judged: 1, irrelevant: 0, judgeFailed: 1 });
  });

  it("only targets entries with hit_axis set, unjudged, and a summary (query-level; verified via gateRows contract)", async () => {
    // The SQL itself filters (hit_axis IS NOT NULL AND axis_relevant IS NULL AND
    // s.text IS NOT NULL); this test verifies gateAxisRelevance processes exactly what
    // the query returns, without additional in-memory filtering that could diverge.
    const gateRows: GateRow[] = [
      { article_id: 5, title: "t5", summary_text: rawSummary("s5"), axis_label: "Web" },
    ];
    const { db, ops } = makeReadDb({ gateRows });
    const judge = vi.fn(async () => true);

    const result = await gateAxisRelevance(db, ai(vi.fn()), DIGEST, "2026-07-08", {
      judge,
      sleep: noSleep,
    });

    expect(judge).toHaveBeenCalledTimes(1);
    expect(ops.filter((o) => o.kind === "update-axis-relevant")).toHaveLength(1);
    expect(result.judged).toBe(1);
  });
});
