import { describe, it, expect } from "vitest";
import {
  loadConfig,
  saveConfig,
  loadUserConfigForForm,
  SYSTEM_CONFIG,
  EMPTY_USER_CONFIG,
  type UserConfig,
} from "./config";
import type { Env } from "./index";

// 設定は D1 の正規化テーブルに置く（KV blob は廃止）。
// - interest_axes: 源泉列 axis_id/label（/settings が書く）＋
//   派生列 seed_hash/embedding/embedding_model（cron が埋める）
// - feed_source: url を 1 本 1 行
const validUser: UserConfig = {
  interestAxes: [
    { id: "web-fw", label: "Web フレームワーク" },
    { id: "ai", label: "AI" },
  ],
  sources: {
    feeds: ["https://martinfowler.com/feed.atom", "https://example.com/rss"],
  },
};

/** interest_axes 行（派生列は cron が埋めるので初期 null。category は源泉列で未分類は null）。 */
interface AxisRow {
  axis_id: string;
  label: string;
  category: string | null;
  seed_hash: string | null;
  embedding: string | null;
  embedding_model: string | null;
}

/** 挿入順を表す連番 id（D1 の INTEGER PRIMARY KEY 相当）を内部で持つ。 */
interface StoredAxisRow extends AxisRow {
  id: number;
}

/** 発行 SQL の ORDER BY 列名を取り出す（無ければ null）。 */
function orderByColumn(sql: string): string | null {
  return sql.match(/ORDER BY (\w+)/i)?.[1] ?? null;
}

/**
 * config.ts が使う D1 操作だけを実装する in-memory フェイク。
 * - 読み取り: 発行された SQL の ORDER BY 列を解釈して整列する（正しい ORDER BY を
 *   発行しているか＝本物の D1 での並びを担保するため。id=挿入順連番、axis_id/url=辞書順）。
 * - 書き込み: saveConfig の batch（axis upsert / axis 除去 / feed 総入れ替え）を
 *   実際に配列へ適用する。ON CONFLICT DO UPDATE SET label は label だけ更新し、
 *   派生列（seed_hash/embedding/embedding_model）には触れない現行挙動を再現する。
 * 返り値の axes/feeds 参照と、読み取りで発行された SQL 一覧(reads)を検証用に公開する。
 */
function makeDb(seed?: { axes?: AxisRow[]; feeds?: string[] }) {
  let nextId = 1;
  const axes: StoredAxisRow[] = (seed?.axes ?? []).map((a) => ({
    id: nextId++,
    ...a,
  }));
  // feed も挿入順連番 id を持つ（保存は毎回 delete→再 insert なので配列順＝id 順）。
  let nextFeedId = 1;
  const feeds: Array<{ id: number; url: string }> = (seed?.feeds ?? []).map(
    (url) => ({ id: nextFeedId++, url }),
  );
  const reads: string[] = [];

  function apply(sql: string, args: unknown[]): void {
    if (/^INSERT INTO interest_axes/i.test(sql)) {
      const [axisId, label, category] = args as [
        string,
        string,
        string | null,
      ];
      const existing = axes.find((a) => a.axis_id === axisId);
      if (existing) {
        // 源泉列（label/category）だけ更新。派生列は据え置き
        // （ON CONFLICT DO UPDATE SET label, category）。
        existing.label = label;
        existing.category = category;
      } else {
        axes.push({
          id: nextId++,
          axis_id: axisId,
          label,
          category,
          seed_hash: null,
          embedding: null,
          embedding_model: null,
        });
      }
    } else if (/^DELETE FROM interest_axes WHERE axis_id NOT IN/i.test(sql)) {
      const keep = new Set(args as string[]);
      for (let i = axes.length - 1; i >= 0; i--) {
        if (!keep.has(axes[i].axis_id)) axes.splice(i, 1);
      }
    } else if (/^DELETE FROM feed_source/i.test(sql)) {
      feeds.length = 0;
    } else if (/^INSERT INTO feed_source/i.test(sql)) {
      feeds.push({ id: nextFeedId++, url: args[0] as string });
    } else {
      throw new Error(`unexpected write SQL: ${sql}`);
    }
  }

  const db = {
    prepare(rawSql: string) {
      const sql = rawSql.replace(/\s+/g, " ").trim();
      return {
        sql,
        args: [] as unknown[],
        bind(...a: unknown[]) {
          this.args = a;
          return this;
        },
        async all<T>() {
          reads.push(sql);
          if (/FROM interest_axes/i.test(sql)) {
            const col = orderByColumn(sql);
            const rows = [...axes];
            if (col === "id") rows.sort((a, b) => a.id - b.id);
            else if (col === "axis_id")
              rows.sort((a, b) => a.axis_id.localeCompare(b.axis_id));
            return {
              results: rows.map((a) => ({
                axis_id: a.axis_id,
                label: a.label,
                category: a.category,
              })) as T[],
              success: true,
              meta: {},
            };
          }
          if (/FROM feed_source/i.test(sql)) {
            const col = orderByColumn(sql);
            const rows = [...feeds];
            if (col === "id") rows.sort((a, b) => a.id - b.id);
            else if (col === "url")
              rows.sort((a, b) => a.url.localeCompare(b.url));
            return {
              results: rows.map((r) => ({ url: r.url })) as T[],
              success: true,
              meta: {},
            };
          }
          throw new Error(`unexpected read SQL: ${sql}`);
        },
        async run() {
          apply(this.sql, this.args);
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
    async batch(stmts: Array<{ sql: string; args: unknown[] }>) {
      for (const s of stmts) apply(s.sql, s.args);
      return stmts.map(() => ({ success: true, meta: {} }));
    },
  };

  return { db, axes, feeds, reads };
}

function makeEnv(seed?: { axes?: AxisRow[]; feeds?: string[] }) {
  const { db, axes, feeds, reads } = makeDb(seed);
  const env = { AI: {}, DB: db } as unknown as Env;
  return { env, axes, feeds, reads };
}

/** validUser 相当の派生列付き axis 行（源泉＋派生が揃った状態）。 */
function seededAxes(): AxisRow[] {
  return validUser.interestAxes.map((a) => ({
    axis_id: a.id,
    label: a.label,
    category: null,
    seed_hash: `hash-${a.id}`,
    embedding: "[0.1,0.2]",
    embedding_model: "@cf/baai/bge-m3",
  }));
}

describe("config", () => {
  it("reserves enough output tokens for the detailed four-part article summary", () => {
    expect(SYSTEM_CONFIG.digest.maxOutputTokens).toBe(4000);
  });

  it("uses the Qwen3 reasoning model selected for digest summaries", () => {
    expect(SYSTEM_CONFIG.digest.model).toBe("@cf/qwen/qwen3-30b-a3b-fp8");
  });

  describe("loadConfig", () => {
    it("merges the D1 UserConfig with SYSTEM_CONFIG into a full Config", async () => {
      const { env } = makeEnv({
        axes: seededAxes(),
        feeds: validUser.sources.feeds,
      });

      const result = await loadConfig(env);

      expect(result).toEqual({ ...validUser, ...SYSTEM_CONFIG });
    });

    it("reads axes and feeds via an id-ordered query (preserves insertion order)", async () => {
      // seed の挿入順は axis_id / url の辞書順とは異なる（web-fw→ai、martinfowler→example）。
      // フェイクは発行 SQL の ORDER BY 列で整列するので、id 以外で並べる/句を落とすと崩れる。
      const { env, reads } = makeEnv({
        axes: seededAxes(),
        feeds: validUser.sources.feeds,
      });

      const result = await loadConfig(env);

      // 返却順は挿入順（= id 昇順）。axis_id 辞書順なら [ai, web-fw] になり落ちる。
      expect(result.interestAxes.map((a) => a.id)).toEqual(["web-fw", "ai"]);
      // url 辞書順なら [example, martinfowler] になり落ちる。
      expect(result.sources.feeds).toEqual(validUser.sources.feeds);
      // 実装が id 昇順の ORDER BY を発行していること（句の削除・別列化を文字列でも捕捉）。
      expect(
        reads.some((s) => /FROM interest_axes .*ORDER BY id\b/i.test(s)),
      ).toBe(true);
      expect(
        reads.some((s) => /FROM feed_source .*ORDER BY id\b/i.test(s)),
      ).toBe(true);
    });

    it("exposes SYSTEM_CONFIG values (not stored in D1)", async () => {
      const { env } = makeEnv({
        axes: seededAxes(),
        feeds: validUser.sources.feeds,
      });

      const result = await loadConfig(env);

      expect(result.scoring).toEqual(SYSTEM_CONFIG.scoring);
      expect(result.embedding).toEqual(SYSTEM_CONFIG.embedding);
      expect(result.digest).toEqual(SYSTEM_CONFIG.digest);
    });

    it("throws when there are no interest axes (fail-fast)", async () => {
      const { env } = makeEnv({ axes: [], feeds: [] });

      await expect(loadConfig(env)).rejects.toThrow(
        "interestAxes must not be empty",
      );
    });
  });

  describe("saveConfig", () => {
    it("round-trips axes and feeds (saveConfig then loadConfig)", async () => {
      const { env } = makeEnv();

      await saveConfig(env, validUser);
      const result = await loadConfig(env);

      expect(result.interestAxes).toEqual(validUser.interestAxes);
      expect(result.sources.feeds).toEqual(validUser.sources.feeds);
    });

    it("does not overwrite derived columns (embedding/seed_hash/model) on label change", async () => {
      const { env, axes } = makeEnv({
        axes: seededAxes(),
        feeds: validUser.sources.feeds,
      });

      const renamed: UserConfig = {
        interestAxes: [
          { id: "web-fw", label: "Web フレームワーク（改）" },
          { id: "ai", label: "AI" },
        ],
        sources: validUser.sources,
      };
      await saveConfig(env, renamed);

      const webFw = axes.find((a) => a.axis_id === "web-fw")!;
      expect(webFw.label).toBe("Web フレームワーク（改）");
      // 派生列は cron の責務なので saveConfig は触らない（次 cron が hash 不一致で再 embed）。
      expect(webFw.seed_hash).toBe("hash-web-fw");
      expect(webFw.embedding).toBe("[0.1,0.2]");
      expect(webFw.embedding_model).toBe("@cf/baai/bge-m3");
    });

    it("removes axes that are no longer in the config", async () => {
      const { env, axes } = makeEnv({
        axes: seededAxes(),
        feeds: validUser.sources.feeds,
      });

      const dropped: UserConfig = {
        interestAxes: [{ id: "ai", label: "AI" }],
        sources: validUser.sources,
      };
      await saveConfig(env, dropped);

      expect(axes.map((a) => a.axis_id)).toEqual(["ai"]);
    });

    it("replaces feeds wholesale", async () => {
      const { env, feeds } = makeEnv({
        axes: seededAxes(),
        feeds: ["https://old.example/rss"],
      });

      const updated: UserConfig = {
        interestAxes: validUser.interestAxes,
        sources: { feeds: ["https://new.example/a", "https://new.example/b"] },
      };
      await saveConfig(env, updated);

      expect(feeds.map((f) => f.url)).toEqual([
        "https://new.example/a",
        "https://new.example/b",
      ]);
    });

    it("throws and writes nothing when a label is empty", async () => {
      const { env, axes } = makeEnv();
      const invalid = {
        ...validUser,
        interestAxes: [{ id: "web-fw", label: "" }],
      };

      await expect(saveConfig(env, invalid as UserConfig)).rejects.toThrow(
        "InterestAxis.label must be a non-empty string",
      );
      expect(axes).toEqual([]);
    });

    it("throws and writes nothing when a feed URL is invalid", async () => {
      const { env, feeds } = makeEnv();
      const invalid: UserConfig = {
        ...validUser,
        sources: { feeds: ["not a url"] },
      };

      await expect(saveConfig(env, invalid)).rejects.toThrow(
        "sources.feeds entries must be http(s):// URLs",
      );
      expect(feeds).toEqual([]);
    });

    it("throws on duplicate axis ids", async () => {
      const { env } = makeEnv();
      const dup: UserConfig = {
        ...validUser,
        interestAxes: [
          { id: "dup", label: "A" },
          { id: "dup", label: "B" },
        ],
      };

      await expect(saveConfig(env, dup)).rejects.toThrow(
        'Duplicate interestAxis id: "dup"',
      );
    });

    it("accepts empty feed list", async () => {
      const { env, feeds } = makeEnv();
      const user: UserConfig = {
        interestAxes: validUser.interestAxes,
        sources: { feeds: [] },
      };

      await saveConfig(env, user);

      expect(feeds).toEqual([]);
    });
  });

  describe("category (interest axis grouping)", () => {
    it("round-trips a category on an axis and treats a missing category as unclassified", async () => {
      const { env } = makeEnv();
      const user: UserConfig = {
        interestAxes: [
          { id: "ai", label: "AI", category: "技術" },
          { id: "life", label: "暮らし" },
        ],
        sources: { feeds: [] },
      };

      await saveConfig(env, user);
      const result = await loadConfig(env);

      // category ありは値ごと往復し、無い軸は key を付けない（未分類）。
      expect(result.interestAxes).toEqual([
        { id: "ai", label: "AI", category: "技術" },
        { id: "life", label: "暮らし" },
      ]);
    });

    it("omits the category key when the stored category is null or empty", async () => {
      const { env } = makeEnv({
        axes: [
          {
            axis_id: "ai",
            label: "AI",
            category: null,
            seed_hash: null,
            embedding: null,
            embedding_model: null,
          },
          {
            axis_id: "web",
            label: "Web",
            category: "",
            seed_hash: null,
            embedding: null,
            embedding_model: null,
          },
        ],
        feeds: [],
      });

      const result = await loadConfig(env);

      // null も空文字も「未分類」として返却から category を落とす（null ノイズを混ぜない）。
      expect("category" in result.interestAxes[0]).toBe(false);
      expect("category" in result.interestAxes[1]).toBe(false);
    });

    it("treats a whitespace-only category as unclassified (trims, then omits the key)", async () => {
      const { env } = makeEnv();

      await saveConfig(env, {
        interestAxes: [{ id: "ai", label: "AI", category: "   " }],
        sources: { feeds: [] },
      });
      const result = await loadConfig(env);

      expect("category" in result.interestAxes[0]).toBe(false);
    });

    it("trims surrounding whitespace from a non-empty category", async () => {
      const { env } = makeEnv();

      await saveConfig(env, {
        interestAxes: [{ id: "ai", label: "AI", category: "  技術  " }],
        sources: { feeds: [] },
      });
      const result = await loadConfig(env);

      expect(result.interestAxes[0].category).toBe("技術");
    });

    it("rejects a non-string category", async () => {
      const { env } = makeEnv();

      await expect(
        saveConfig(env, {
          interestAxes: [{ id: "ai", label: "AI", category: 123 }],
          sources: { feeds: [] },
        } as unknown as UserConfig),
      ).rejects.toThrow("InterestAxis.category");
    });
  });

  describe("loadUserConfigForForm", () => {
    it("returns the D1 UserConfig when axes exist", async () => {
      const { env } = makeEnv({
        axes: seededAxes(),
        feeds: validUser.sources.feeds,
      });

      const result = await loadUserConfigForForm(env);

      expect(result).toEqual(validUser);
    });

    it("returns EMPTY_USER_CONFIG when there are no axes (does not throw)", async () => {
      const { env } = makeEnv({ axes: [], feeds: [] });

      const result = await loadUserConfigForForm(env);

      expect(result).toEqual(EMPTY_USER_CONFIG);
    });
  });

  describe("EMPTY_USER_CONFIG", () => {
    it("is an empty scaffold (no hardcoded topics or feeds)", () => {
      expect(EMPTY_USER_CONFIG.interestAxes).toEqual([]);
      expect(EMPTY_USER_CONFIG.sources.feeds).toEqual([]);
    });

    it("is not directly saveable (no interest axis)", async () => {
      const { env } = makeEnv();

      await expect(saveConfig(env, EMPTY_USER_CONFIG)).rejects.toThrow(
        "interestAxes must not be empty",
      );
    });
  });
});
