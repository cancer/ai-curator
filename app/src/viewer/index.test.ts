import { describe, it, expect } from "vitest";
import { renderFeedPage } from "./index";
import type { Env } from "../index";
import type { Config } from "../config";

interface EntryRow {
  feed_entry_id: number;
  rank: number;
  summary: string | null;
  title: string;
  source: string;
  published_at: string;
  url: string;
  hit_axis: string | null;
  vote: string | null;
}

interface TrendRow {
  axis_id: string;
  hit_count: number;
  narrative: string | null;
}

function baseConfig(): Config {
  return {
    interestAxes: [
      { id: "ai", label: "AI関連" },
      { id: "web-fw", label: "Web FW" },
    ],
    sources: {
      feeds: [],
    },
    scoring: {
      weights: { interest: 0.6, freshness: 0.3, sourceTrust: 0.1 },
      freshnessHalfLifeDays: 7,
      semanticDedupThreshold: 0.9,
      sourceTrust: { feed: 0.7 },
    },
    embedding: { model: "m", maxInputChars: 1000 },
    digest: { model: "d", maxOutputTokens: 300 },
  };
}

/**
 * feed の表示に必要な 3 クエリ(MAX(date)/feed_trends/entries join)だけを扱う
 * in-memory D1 フェイク。entries は rank 昇順で持ち、bind の limit/offset を適用する。
 */
function makeEnv(opts: {
  maxDate: string | null;
  trends?: TrendRow[];
  entries?: EntryRow[];
  config?: Config;
}) {
  const entries = [...(opts.entries ?? [])].sort((a, b) => a.rank - b.rank);
  const db = {
    prepare(sql: string) {
      const s = sql.replace(/\s+/g, " ").trim();
      return {
        _args: [] as unknown[],
        bind(...args: unknown[]) {
          this._args = args;
          return this;
        },
        async first<T>(): Promise<T | null> {
          if (s.includes("MAX(date)")) {
            return { date: opts.maxDate } as unknown as T;
          }
          if (s.includes("COUNT(*)")) {
            return { total: entries.length } as unknown as T;
          }
          return null;
        },
        async all<T>() {
          if (s.includes("FROM feed_trends")) {
            const sorted = [...(opts.trends ?? [])].sort(
              (a, b) => b.hit_count - a.hit_count,
            );
            return { results: sorted as unknown as T[], success: true, meta: {} };
          }
          // entries: bind(date, limit, offset)
          const limit = this._args[1] as number;
          const offset = this._args[2] as number;
          const slice = entries.slice(offset, offset + limit);
          return { results: slice as unknown as T[], success: true, meta: {} };
        },
      };
    },
  };
  const config = opts.config ?? baseConfig();
  const env = {
    DB: db,
    AI: {},
    CONFIG: { get: async () => JSON.stringify(config) },
  } as unknown as Env;
  return env;
}

function entryRow(over: Partial<EntryRow> = {}): EntryRow {
  return {
    feed_entry_id: over.rank ?? 1,
    rank: 1,
    summary: null,
    title: "title",
    source: "hn",
    published_at: "2026-07-08T00:00:00.000Z",
    url: "https://example.invalid/a",
    hit_axis: null,
    vote: null,
    ...over,
  };
}

describe("renderFeedPage", () => {
  it("renders an empty state when no feed exists", async () => {
    const env = makeEnv({ maxDate: null });
    const res = await renderFeedPage(env, 1);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("まだフィードがありません");
  });

  it("renders trends: label, count, narrative; omits narrative line when null", async () => {
    const env = makeEnv({
      maxDate: "2026-07-08",
      trends: [
        { axis_id: "ai", hit_count: 3, narrative: "AIが話題" },
        { axis_id: "web-fw", hit_count: 0, narrative: null },
      ],
      entries: [entryRow({ rank: 1, feed_entry_id: 1 })],
    });
    const html = await (await renderFeedPage(env, 1)).text();
    expect(html).toContain("AI関連");
    expect(html).toContain("AIが話題");
    expect(html).toContain("Web FW");
    // zero-hit 軸も件数付きで表示する
    expect(html).toContain("0");
  });

  it("lists entries in rank order with title linked to /r/{id}", async () => {
    const env = makeEnv({
      maxDate: "2026-07-08",
      entries: [
        entryRow({ rank: 2, feed_entry_id: 20, title: "SECOND" }),
        entryRow({ rank: 1, feed_entry_id: 10, title: "FIRST" }),
      ],
    });
    const html = await (await renderFeedPage(env, 1)).text();
    expect(html.indexOf("FIRST")).toBeLessThan(html.indexOf("SECOND"));
    expect(html).toContain('href="/r/10"');
    expect(html).toContain('href="/r/20"');
  });

  it("omits the summary line when summary is null", async () => {
    const env = makeEnv({
      maxDate: "2026-07-08",
      entries: [
        entryRow({ rank: 1, feed_entry_id: 1, summary: "HAS_SUMMARY" }),
        entryRow({ rank: 2, feed_entry_id: 2, summary: null }),
      ],
    });
    const html = await (await renderFeedPage(env, 1)).text();
    expect(html).toContain("HAS_SUMMARY");
    // summary 行は非 null の 1 件だけ
    expect((html.match(/class="summary"/g) ?? []).length).toBe(1);
  });

  it("renders a structured summary as labelled sections", async () => {
    const structured = JSON.stringify({
      v: 1,
      audience: "読者A",
      overview: "要約B",
      thesis: "命題C",
      conclusion: "結論D",
    });
    const env = makeEnv({
      maxDate: "2026-07-08",
      entries: [entryRow({ rank: 1, feed_entry_id: 1, summary: structured })],
    });
    const html = await (await renderFeedPage(env, 1)).text();
    // 4 見出しと各本文がセクションとして出る。
    expect(html).toContain("summary-section");
    for (const label of ["想定対象読者", "全体の要約", "命題", "結論"]) {
      expect(html).toContain(label);
    }
    for (const body of ["読者A", "要約B", "命題C", "結論D"]) {
      expect(html).toContain(body);
    }
    // コンテナは 1 個。
    expect((html.match(/class="summary"/g) ?? []).length).toBe(1);
  });

  it("resolves hit_axis to its label and shows source and primary url", async () => {
    const env = makeEnv({
      maxDate: "2026-07-08",
      entries: [
        entryRow({
          rank: 1,
          feed_entry_id: 1,
          source: "medium:@bob",
          hit_axis: "ai",
          url: "https://example.invalid/primary",
        }),
      ],
    });
    const html = await (await renderFeedPage(env, 1)).text();
    expect(html).toContain("AI関連");
    expect(html).toContain("medium:@bob");
    expect(html).toContain("https://example.invalid/primary");
  });

  it("escapes title, narrative and url to prevent XSS", async () => {
    const env = makeEnv({
      maxDate: "2026-07-08",
      trends: [{ axis_id: "ai", hit_count: 1, narrative: "<b>x</b>" }],
      entries: [
        entryRow({
          rank: 1,
          feed_entry_id: 1,
          title: "<script>alert(1)</script>",
          url: 'https://x/"onmouseover',
        }),
      ],
    });
    const html = await (await renderFeedPage(env, 1)).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;");
  });

  describe("vote state", () => {
    it("renders both votes unpressed when there is no stored vote", async () => {
      const env = makeEnv({
        maxDate: "2026-07-08",
        entries: [entryRow({ rank: 1, feed_entry_id: 1, vote: null })],
      });
      const html = await (await renderFeedPage(env, 1)).text();
      // 両ボタンとも未選択で描画される。
      expect(html).toContain(
        '<button data-entry-id="1" data-kind="up" aria-pressed="false"',
      );
      expect(html).toContain(
        '<button data-entry-id="1" data-kind="down" aria-pressed="false"',
      );
    });

    it("marks the up button pressed and the down button unpressed for an up vote", async () => {
      const env = makeEnv({
        maxDate: "2026-07-08",
        entries: [entryRow({ rank: 1, feed_entry_id: 1, vote: "up" })],
      });
      const html = await (await renderFeedPage(env, 1)).text();
      expect(html).toContain(
        '<button data-entry-id="1" data-kind="up" aria-pressed="true"',
      );
      expect(html).toContain(
        '<button data-entry-id="1" data-kind="down" aria-pressed="false"',
      );
    });

    it("marks the down button pressed for a down vote", async () => {
      const env = makeEnv({
        maxDate: "2026-07-08",
        entries: [entryRow({ rank: 1, feed_entry_id: 1, vote: "down" })],
      });
      const html = await (await renderFeedPage(env, 1)).text();
      expect(html).toContain(
        '<button data-entry-id="1" data-kind="down" aria-pressed="true"',
      );
      expect(html).toContain(
        '<button data-entry-id="1" data-kind="up" aria-pressed="false"',
      );
    });
  });

  describe("pagination", () => {
    const forty = Array.from({ length: 40 }, (_, i) =>
      entryRow({ rank: i + 1, feed_entry_id: i + 1, title: `T${i + 1}` }),
    );

    it("page 1 shows ranks 1-20, a 次へ link to page 2, no 前へ, and the totals", async () => {
      const env = makeEnv({ maxDate: "2026-07-08", entries: forty });
      const html = await (await renderFeedPage(env, 1)).text();
      expect(html).toContain("T1");
      expect(html).toContain("T20");
      expect(html).not.toContain(">T21<");
      // 次へ は page 2 へ、前へ は最初のページなので出さない
      expect(html).toContain('href="/?page=2"');
      expect(html).not.toContain('href="/?page=0"');
      // 総ページ数・総件数・現在ページを表示する
      expect(html).toContain("1 / 2");
      expect(html).toContain("全40件");
      // 「もっと見る」は廃止した
      expect(html).not.toContain("もっと見る");
    });

    it("page 2 shows ranks 21-40, a 前へ link to page 1, and no 次へ on the last page", async () => {
      const env = makeEnv({ maxDate: "2026-07-08", entries: forty });
      const html = await (await renderFeedPage(env, 2)).text();
      expect(html).toContain("T21");
      expect(html).toContain("T40");
      expect(html).not.toContain(">T20<");
      expect(html).toContain('href="/?page=1"');
      expect(html).not.toContain('href="/?page=3"');
      expect(html).toContain("2 / 2");
      expect(html).toContain("全40件");
    });

    it("clamps a non-positive or non-numeric page to 1", async () => {
      const env = makeEnv({ maxDate: "2026-07-08", entries: forty });
      const html = await (await renderFeedPage(env, 0)).text();
      expect(html).toContain("T1");
      expect(html).toContain("1 / 2");
    });

    it("clamps a page beyond the last to the last page", async () => {
      const env = makeEnv({ maxDate: "2026-07-08", entries: forty });
      const html = await (await renderFeedPage(env, 999)).text();
      expect(html).toContain("T21");
      expect(html).toContain("T40");
      expect(html).toContain("2 / 2");
      expect(html).not.toContain('href="/?page=1000"');
    });

    it("shows a single page with neither 前へ nor 次へ when entries fit one page", async () => {
      const env = makeEnv({
        maxDate: "2026-07-08",
        entries: forty.slice(0, 5),
      });
      const html = await (await renderFeedPage(env, 1)).text();
      expect(html).toContain("1 / 1");
      expect(html).toContain("全5件");
      expect(html).not.toContain('href="/?page=2"');
      expect(html).not.toContain('href="/?page=0"');
    });
  });
});
