import { describe, it, expect } from "vitest";
import { renderFeedPage, UNCATEGORIZED } from "./index";
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
  const config = opts.config ?? baseConfig();

  // hit_axis → その軸の category（未設定は undefined）。JOIN interest_axes を模す。
  const axisCategory = new Map(
    config.interestAxes.map((a) => [a.id, a.category] as const),
  );
  // 記事の実効カテゴリ: hit_axis が null、または軸に category が無ければ「未分類」(null)。
  const entryCat = (e: EntryRow): string | null =>
    e.hit_axis === null ? null : (axisCategory.get(e.hit_axis) ?? null);
  const trendCat = (t: TrendRow): string | null =>
    axisCategory.get(t.axis_id) ?? null;

  // 発行 SQL の述語からフィルタのモードと束縛カテゴリを読み取る。
  // named 版は bind(date, category, ...)、all/uncat 版は bind(date, ...) で
  // category を束縛しない — ここを取り違えると offset/limit の位置がずれる。
  type Mode =
    | { kind: "all" }
    | { kind: "named"; cat: unknown }
    | { kind: "uncat" };
  function modeOf(s: string, args: unknown[]): Mode {
    if (/ax\.category = \?/.test(s)) return { kind: "named", cat: args[1] };
    if (/ax\.category IS NULL/.test(s)) return { kind: "uncat" };
    return { kind: "all" };
  }
  const keepEntry = (e: EntryRow, m: Mode): boolean =>
    m.kind === "all"
      ? true
      : m.kind === "named"
        ? entryCat(e) === m.cat
        : entryCat(e) === null;
  const keepTrend = (t: TrendRow, m: Mode): boolean =>
    m.kind === "all"
      ? true
      : m.kind === "named"
        ? trendCat(t) === m.cat
        : trendCat(t) === null;

  // body 述語: with は要約あり(s.article_id IS NOT NULL→summary!=null)、
  // without は要約なし(IS NULL→summary==null)。entries/COUNT に同一適用（offset 整合）。
  // trends には s.article_id が無いので null（body 非対応）。
  const bodyOf = (s: string): "with" | "without" | null =>
    /s\.article_id IS NOT NULL/.test(s)
      ? "with"
      : /s\.article_id IS NULL/.test(s)
        ? "without"
        : null;
  const keepBody = (e: EntryRow, b: "with" | "without" | null): boolean =>
    b === "with"
      ? e.summary !== null
      : b === "without"
        ? e.summary === null
        : true;

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
            // COUNT は ENTRIES と同一述語で数える（offset 破綻・空ページ防止）。
            const m = modeOf(s, this._args);
            const b = bodyOf(s);
            const total = entries.filter(
              (e) => keepEntry(e, m) && keepBody(e, b),
            ).length;
            return { total } as unknown as T;
          }
          return null;
        },
        async all<T>() {
          if (s.includes("FROM feed_trends")) {
            const m = modeOf(s, this._args);
            const sorted = [...(opts.trends ?? [])]
              .filter((t) => keepTrend(t, m))
              .sort((a, b) => b.hit_count - a.hit_count);
            return { results: sorted as unknown as T[], success: true, meta: {} };
          }
          // loadConfig: 設定は D1 の interest_axes / feed_source から読む。
          if (s.includes("FROM interest_axes")) {
            const rows = config.interestAxes.map((a) => ({
              axis_id: a.id,
              label: a.label,
              category: a.category ?? null,
            }));
            return { results: rows as unknown as T[], success: true, meta: {} };
          }
          if (s.includes("FROM feed_source")) {
            const rows = config.sources.feeds.map((url) => ({ url }));
            return { results: rows as unknown as T[], success: true, meta: {} };
          }
          // entries: all/uncat は bind(date, limit, offset)、named は bind(date, cat, limit, offset)。
          // body 述語はリテラルなので bind 順序に影響しない。
          const m = modeOf(s, this._args);
          const b = bodyOf(s);
          const limitIdx = m.kind === "named" ? 2 : 1;
          const limit = this._args[limitIdx] as number;
          const offset = this._args[limitIdx + 1] as number;
          const filtered = entries.filter(
            (e) => keepEntry(e, m) && keepBody(e, b),
          );
          const slice = filtered.slice(offset, offset + limit);
          return { results: slice as unknown as T[], success: true, meta: {} };
        },
      };
    },
  };
  const env = {
    DB: db,
    AI: {},
  } as unknown as Env;
  return env;
}

function entryRow(over: Partial<EntryRow> = {}): EntryRow {
  return {
    feed_entry_id: over.rank ?? 1,
    rank: 1,
    // 既定フィード（本文要約=with）で行が残るよう、既定で非 null 要約を持たせる。
    // 「要約なし」を試すケースは summary:null を明示する。
    summary: "SUMMARY",
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

  describe("category filter", () => {
    // ai/web=技術, life=生活, misc=カテゴリ無し（未分類扱い）。
    function categorizedConfig(): Config {
      return {
        ...baseConfig(),
        interestAxes: [
          { id: "ai", label: "AI", category: "技術" },
          { id: "web", label: "Web", category: "技術" },
          { id: "life", label: "暮らし", category: "生活" },
          { id: "misc", label: "雑多" },
        ],
      };
    }

    // 技術×2(ai,web) / 生活×1(life) / 未分類×2(hit_axis null, misc=カテゴリ無し)。
    const mixed = [
      entryRow({ rank: 1, feed_entry_id: 1, hit_axis: "ai" }),
      entryRow({ rank: 2, feed_entry_id: 2, hit_axis: "life" }),
      entryRow({ rank: 3, feed_entry_id: 3, hit_axis: "web" }),
      entryRow({ rank: 4, feed_entry_id: 4, hit_axis: null }),
      entryRow({ rank: 5, feed_entry_id: 5, hit_axis: "misc" }),
    ];

    const enc = encodeURIComponent;

    it("renders a nav of distinct categories plus an unclassified link", async () => {
      const env = makeEnv({
        maxDate: "2026-07-08",
        entries: mixed,
        config: categorizedConfig(),
      });
      const html = await (await renderFeedPage(env, 1, null)).text();
      // distinct: 技術 のリンクは 1 個だけ（ai/web が同一カテゴリ）。
      const tech = new RegExp(`href="/\\?category=${enc("技術")}"`, "g");
      expect((html.match(tech) ?? []).length).toBe(1);
      expect(html).toContain(`href="/?category=${enc("生活")}"`);
      // 未分類 は専用リンク（センチネル）。
      expect(html).toContain(`href="/?category=${UNCATEGORIZED}"`);
      expect(html).toContain("未分類");
    });

    it("marks the current category as active (rendered as text, not a link)", async () => {
      const env = makeEnv({
        maxDate: "2026-07-08",
        entries: mixed,
        config: categorizedConfig(),
      });
      const html = await (await renderFeedPage(env, 1, "技術")).text();
      // 現在のカテゴリはリンクにしない（strong で現在地を示す）。
      expect(html).toContain("<strong>技術</strong>");
      expect(html).not.toContain(`href="/?category=${enc("技術")}"`);
      // すべて は選択解除リンクとして残る。
      expect(html).toContain('href="/"');
    });

    it("filters entries and counts them under the same predicate (named category)", async () => {
      const env = makeEnv({
        maxDate: "2026-07-08",
        entries: mixed,
        config: categorizedConfig(),
      });
      const html = await (await renderFeedPage(env, 1, "技術")).text();
      // 技術(ai/web)だけが出る。
      expect(html).toContain('href="/r/1"');
      expect(html).toContain('href="/r/3"');
      expect(html).not.toContain('href="/r/2"');
      expect(html).not.toContain('href="/r/4"');
      expect(html).not.toContain('href="/r/5"');
      // COUNT も同じ述語なので総件数は 2。
      expect(html).toContain("全2件");
    });

    it("filters to unclassified entries (null hit_axis or axis without a category)", async () => {
      const env = makeEnv({
        maxDate: "2026-07-08",
        entries: mixed,
        config: categorizedConfig(),
      });
      const html = await (await renderFeedPage(env, 1, UNCATEGORIZED)).text();
      expect(html).toContain('href="/r/4"'); // hit_axis null
      expect(html).toContain('href="/r/5"'); // misc: カテゴリ未設定
      expect(html).not.toContain('href="/r/1"');
      expect(html).toContain("全2件");
    });

    it("filters trends to the selected category", async () => {
      const env = makeEnv({
        maxDate: "2026-07-08",
        entries: mixed,
        config: categorizedConfig(),
        trends: [
          { axis_id: "ai", hit_count: 3, narrative: "AI話題" },
          { axis_id: "life", hit_count: 5, narrative: "暮らし話題" },
        ],
      });
      const html = await (await renderFeedPage(env, 1, "技術")).text();
      expect(html).toContain("AI話題");
      expect(html).not.toContain("暮らし話題");
    });

    it("preserves the category in pagination links", async () => {
      const many = Array.from({ length: 25 }, (_, i) =>
        entryRow({ rank: i + 1, feed_entry_id: i + 1, hit_axis: "ai" }),
      );
      const env = makeEnv({
        maxDate: "2026-07-08",
        entries: many,
        config: categorizedConfig(),
      });
      const html = await (await renderFeedPage(env, 1, "技術")).text();
      expect(html).toContain(`href="/?category=${enc("技術")}&page=2"`);
      expect(html).toContain("全25件");
    });

    it("leaves the feed unfiltered when no category is given (unchanged behavior)", async () => {
      const env = makeEnv({
        maxDate: "2026-07-08",
        entries: mixed,
        config: categorizedConfig(),
      });
      const html = await (await renderFeedPage(env, 1, null)).text();
      // 全 5 件がそのまま出る。
      expect(html).toContain("全5件");
      expect(html).toContain('href="/r/1"');
      expect(html).toContain('href="/r/4"');
    });
  });

  describe("body filter", () => {
    const enc = encodeURIComponent;

    // ai/web=技術 のカテゴリ付き config（category×body 合成の検証用）。
    function categorizedConfig(): Config {
      return {
        ...baseConfig(),
        interestAxes: [
          { id: "ai", label: "AI", category: "技術" },
          { id: "web", label: "Web", category: "技術" },
          { id: "life", label: "暮らし", category: "生活" },
        ],
      };
    }

    // 要約あり×2(id1,3) / 要約なし×2(id2,4)。既定=with は要約あり、without は要約なしだけ。
    const withAndWithout = [
      entryRow({ rank: 1, feed_entry_id: 1, summary: "S1" }),
      entryRow({ rank: 2, feed_entry_id: 2, summary: null }),
      entryRow({ rank: 3, feed_entry_id: 3, summary: "S3" }),
      entryRow({ rank: 4, feed_entry_id: 4, summary: null }),
    ];

    it("(a) defaults to the with-body feed: only summarized entries, none without", async () => {
      const env = makeEnv({ maxDate: "2026-07-08", entries: withAndWithout });
      const html = await (await renderFeedPage(env, 1)).text();
      expect(html).toContain('href="/r/1"');
      expect(html).toContain('href="/r/3"');
      expect(html).not.toContain('href="/r/2"');
      expect(html).not.toContain('href="/r/4"');
      // COUNT も with 述語なので総件数は 2（要約ありのみ）。
      expect(html).toContain("全2件");
    });

    it("(b) body=without shows only entries without a summary and hides summarized ones", async () => {
      const env = makeEnv({ maxDate: "2026-07-08", entries: withAndWithout });
      const html = await (await renderFeedPage(env, 1, null, "without")).text();
      expect(html).toContain('href="/r/2"');
      expect(html).toContain('href="/r/4"');
      expect(html).not.toContain('href="/r/1"');
      expect(html).not.toContain('href="/r/3"');
      expect(html).toContain("全2件");
      // 本文なしフィードなので要約行は一切出ない。
      expect(html).not.toContain('class="summary"');
    });

    it("(c) keeps COUNT and entries under the same without predicate across pages", async () => {
      // 要約なし×25 と、without には出ない要約あり×3 を混ぜる。
      const entries = [
        ...Array.from({ length: 25 }, (_, i) =>
          entryRow({ rank: i + 1, feed_entry_id: i + 1, summary: null }),
        ),
        ...Array.from({ length: 3 }, (_, i) =>
          entryRow({ rank: 100 + i, feed_entry_id: 100 + i, summary: "S" }),
        ),
      ];
      const env = makeEnv({ maxDate: "2026-07-08", entries });
      const html = await (await renderFeedPage(env, 2, null, "without")).text();
      // 総件数は without の 25 件のみ（要約ありは数えない）。
      expect(html).toContain("全25件");
      expect(html).toContain("2 / 2");
      // page 2 は 21..25。offset 整合で id21 は出て id1 は出ない。
      expect(html).toContain('href="/r/21"');
      expect(html).not.toContain('href="/r/1"');
    });

    it("(d) composes category and body filters together", async () => {
      const entries = [
        entryRow({ rank: 1, feed_entry_id: 1, hit_axis: "ai", summary: "S" }),
        entryRow({ rank: 2, feed_entry_id: 2, hit_axis: "web", summary: null }),
        entryRow({ rank: 3, feed_entry_id: 3, hit_axis: "life", summary: "S" }),
      ];
      const env = makeEnv({
        maxDate: "2026-07-08",
        entries,
        config: categorizedConfig(),
      });
      const html = await (await renderFeedPage(env, 1, "技術", "with")).text();
      // 技術かつ要約あり = id1 のみ。id2(技術だが要約なし)・id3(要約ありだが生活)は除外。
      expect(html).toContain('href="/r/1"');
      expect(html).not.toContain('href="/r/2"');
      expect(html).not.toContain('href="/r/3"');
      expect(html).toContain("全1件");
    });

    it("(e) preserves category and body in pagination links (order category→body→page)", async () => {
      const entries = Array.from({ length: 25 }, (_, i) =>
        entryRow({
          rank: i + 1,
          feed_entry_id: i + 1,
          hit_axis: "ai",
          summary: null,
        }),
      );
      const env = makeEnv({
        maxDate: "2026-07-08",
        entries,
        config: categorizedConfig(),
      });
      const html = await (await renderFeedPage(env, 1, "技術", "without")).text();
      expect(html).toContain(`href="/?category=${enc("技術")}&body=without&page=2"`);
      expect(html).toContain("全25件");
    });

    it("(f) renders a body toggle nav that preserves the category and marks the active one", async () => {
      const env = makeEnv({
        maxDate: "2026-07-08",
        entries: withAndWithout,
        config: categorizedConfig(),
      });
      const html = await (await renderFeedPage(env, 1, "技術", "without")).text();
      // 選択中(本文なし)は strong、非選択(本文要約)は現在 category を保持したリンク。
      expect(html).toContain("<strong>本文なし</strong>");
      expect(html).toContain("本文要約");
      expect(html).toContain(`href="/?category=${enc("技術")}"`);
    });
  });
});
