import { describe, it, expect } from "vitest";
import { renderSettingsForm, handleConfigApi } from "./settings";
import type { Env } from "../index";
import { SYSTEM_CONFIG, type UserConfig } from "../config";

function baseUser(): UserConfig {
  return {
    interestAxes: [
      { id: "ai", label: "AI" },
      { id: "web-fw", label: "Web FW" },
    ],
    sources: {
      feeds: ["https://martinfowler.com/feed.atom"],
    },
  };
}

/** interest_axes 行（派生列は cron が埋めるので初期 null。category は源泉列で未分類は null）。 */
interface AxisRow {
  axis_id: string;
  label: string;
  category: string | null;
  seed_hash: string | null;
  embedding: string | null;
  embedding_model: string | null;
}

/**
 * settings.ts が config 越しに使う D1 操作だけを実装する in-memory フェイク。
 * - 読み取り(loadUserConfigForForm): interest_axes / feed_source を挿入順で返す。
 * - 書き込み(saveConfig): batch の axis upsert / axis 除去 / feed 総入れ替えを適用する。
 * `puts` は batch 呼び出し（= 保存）1 回につき 1 要素で、保存回数の検証に使う。
 * `saved()` は現在の格納内容を UserConfig として返す。
 */
function makeStore(user: UserConfig | null) {
  const axes: AxisRow[] = (user?.interestAxes ?? []).map((a) => ({
    axis_id: a.id,
    label: a.label,
    category: a.category ?? null,
    seed_hash: `hash-${a.id}`,
    embedding: "[0.1]",
    embedding_model: "@cf/baai/bge-m3",
  }));
  const feeds: string[] = [...(user?.sources.feeds ?? [])];
  const puts: unknown[] = [];

  function apply(sql: string, args: unknown[]): void {
    if (/^INSERT INTO interest_axes/i.test(sql)) {
      const [axisId, label, category] = args as [
        string,
        string,
        string | null,
      ];
      const existing = axes.find((a) => a.axis_id === axisId);
      if (existing) {
        existing.label = label;
        existing.category = category;
      } else
        axes.push({
          axis_id: axisId,
          label,
          category,
          seed_hash: null,
          embedding: null,
          embedding_model: null,
        });
    } else if (/^DELETE FROM interest_axes WHERE axis_id NOT IN/i.test(sql)) {
      const keep = new Set(args as string[]);
      for (let i = axes.length - 1; i >= 0; i--) {
        if (!keep.has(axes[i].axis_id)) axes.splice(i, 1);
      }
    } else if (/^DELETE FROM feed_source/i.test(sql)) {
      feeds.length = 0;
    } else if (/^INSERT INTO feed_source/i.test(sql)) {
      feeds.push(args[0] as string);
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
          if (/FROM interest_axes/i.test(sql)) {
            return {
              results: axes.map((a) => ({
                axis_id: a.axis_id,
                label: a.label,
                category: a.category,
              })) as T[],
              success: true,
              meta: {},
            };
          }
          if (/FROM feed_source/i.test(sql)) {
            return {
              results: feeds.map((url) => ({ url })) as T[],
              success: true,
              meta: {},
            };
          }
          throw new Error(`unexpected read SQL: ${sql}`);
        },
      };
    },
    async batch(stmts: Array<{ sql: string; args: unknown[] }>) {
      for (const s of stmts) apply(s.sql, s.args);
      puts.push(true);
      return stmts.map(() => ({ success: true, meta: {} }));
    },
  };

  const env = { DB: db, AI: {} } as unknown as Env;
  return {
    env,
    puts,
    saved: (): UserConfig => ({
      // category が null/空なら key を落とす（config の未分類セマンティクスを再現）。
      interestAxes: axes.map((a) =>
        a.category != null && a.category !== ""
          ? { id: a.axis_id, label: a.label, category: a.category }
          : { id: a.axis_id, label: a.label },
      ),
      sources: { feeds: [...feeds] },
    }),
  };
}

function makeEmptyEnv() {
  return makeStore(null);
}

function makeEnv(user: UserConfig = baseUser()) {
  return makeStore(user);
}

/** JSON body の POST /api/config リクエストを組む。 */
function postJson(body: unknown): Request {
  return new Request("https://x/api/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("renderSettingsForm", () => {
  it("renders existing axes and feeds as editable rows", async () => {
    const { env } = makeEnv();
    const res = await renderSettingsForm(env);
    expect(res.status).toBe(200);
    const html = await res.text();
    // 軸・ソースは行（入力）として描画され、現在値が value に入る。
    expect(html).toContain('class="row axis-row"');
    expect(html).toContain('data-id="ai"');
    expect(html).toContain('value="AI"');
    expect(html).toContain('class="row feed-row"');
    expect(html).toContain("martinfowler.com/feed.atom");
    // scoring は SYSTEM_CONFIG の値を表示のみ（値が見えること）。
    expect(html).toContain(String(SYSTEM_CONFIG.scoring.weights.interest));
  });

  it("renders the add-rows, autosave indicator, and row templates", async () => {
    const { env } = makeEnv();
    const html = await (await renderSettingsForm(env)).text();
    expect(html).toContain('id="draft-axis-label"');
    expect(html).toContain('id="draft-axis-category"');
    expect(html).toContain('id="draft-feed"');
    expect(html).toContain('id="add-axis"');
    expect(html).toContain('id="add-feed"');
    // 追加行の複製元テンプレート。
    expect(html).toContain('<template id="axis-tpl">');
    expect(html).toContain('<template id="feed-tpl">');
    // 自動保存の告知（保存ボタンは無い）。
    expect(html).toContain("変更は自動保存されます");
    expect(html).not.toContain("保存</button>");
  });

  it("opens with empty lists when D1 is empty (no rows, drafts present)", async () => {
    const { env } = makeEmptyEnv();
    const res = await renderSettingsForm(env);
    expect(res.status).toBe(200);
    const html = await res.text();
    // 空 config では一覧コンテナは空（テンプレートには行があるので一覧の中身で判定する）。
    expect(html).toContain('<div id="axes-list"></div>');
    expect(html).toContain('<div id="feeds-list"></div>');
    expect(html).toContain('id="draft-axis-label"');
  });

  it("renders a run-now button that posts to /run", async () => {
    const { env } = makeEnv();
    const html = await (await renderSettingsForm(env)).text();
    expect(html).toContain('action="/run"');
    expect(html).toContain("今すぐ日次パスを実行");
  });

  it("omits the started note by default", async () => {
    const { env } = makeEnv();
    const html = await (await renderSettingsForm(env)).text();
    expect(html).not.toContain("日次パスを起動しました");
  });

  it("shows the instance id and a status link when a run id is given", async () => {
    const { env } = makeEnv();
    const html = await (await renderSettingsForm(env, "abc-123")).text();
    expect(html).toContain("日次パスを起動しました");
    expect(html).toContain("abc-123");
    expect(html).toContain('href="/runs/abc-123"');
  });

  it("prefills the category input for a categorized axis", async () => {
    const { env } = makeEnv({
      interestAxes: [
        { id: "ai", label: "AI", category: "技術" },
        { id: "life", label: "暮らし" },
      ],
      sources: { feeds: [] },
    });
    const html = await (await renderSettingsForm(env)).text();
    expect(html).toContain('class="axis-category"');
    expect(html).toContain('value="技術"');
  });

  it("escapes axis and feed values to prevent breaking out of attributes", async () => {
    const { env } = makeEnv({
      interestAxes: [{ id: "x", label: '"><script>alert(1)</script>' }],
      sources: { feeds: ["https://x/?a=1&b=2"] },
    });
    const html = await (await renderSettingsForm(env)).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("https://x/?a=1&amp;b=2");
  });
});

describe("handleConfigApi", () => {
  it("saves valid JSON and returns ok with the echoed config", async () => {
    const { env, puts, saved } = makeEnv();
    const res = await handleConfigApi(
      env,
      postJson({
        interestAxes: [
          { id: "ai", label: "brand new label" },
          { id: "web-fw", label: "Web FW" },
        ],
        feeds: ["https://martinfowler.com/feed.atom"],
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
    expect(puts.length).toBe(1);
    expect(saved().interestAxes[0].label).toBe("brand new label");
    // 既存軸の id は round-trip され保持される。
    expect(saved().interestAxes[0].id).toBe("ai");
    expect(Object.keys(saved()).sort()).toEqual(["interestAxes", "sources"]);
    expect(Object.keys(saved().sources).sort()).toEqual(["feeds"]);
  });

  it("assigns a fresh id to a new axis (empty/missing id) and echoes it", async () => {
    const { env, saved } = makeEnv();
    const res = await handleConfigApi(
      env,
      postJson({
        interestAxes: [
          { id: "ai", label: "AI" },
          { label: "Topic New" },
        ],
        feeds: [],
      }),
    );
    const json = (await res.json()) as {
      ok: boolean;
      interestAxes: { id: string; label: string }[];
    };
    expect(json.ok).toBe(true);
    const added = json.interestAxes.find((a) => a.label === "Topic New");
    expect(added?.id).toBeTruthy();
    // 採番された id が実際に保存される。
    expect(saved().interestAxes.map((a) => a.label)).toContain("Topic New");
    const ids = saved().interestAxes.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("persists a deletion (fewer axes than before)", async () => {
    const { env, saved } = makeEnv();
    await handleConfigApi(
      env,
      postJson({ interestAxes: [{ id: "ai", label: "AI" }], feeds: [] }),
    );
    expect(saved().interestAxes.map((a) => a.id)).toEqual(["ai"]);
  });

  it("saves the category for an axis and omits it when empty", async () => {
    const { env, saved } = makeEnv();
    await handleConfigApi(
      env,
      postJson({
        interestAxes: [
          { id: "ai", label: "AI", category: "技術" },
          { id: "web-fw", label: "Web FW", category: "" },
        ],
        feeds: [],
      }),
    );
    const ai = saved().interestAxes.find((a) => a.id === "ai");
    expect(ai?.category).toBe("技術");
    const web = saved().interestAxes.find((a) => a.id === "web-fw");
    expect(web && "category" in web).toBe(false);
  });

  it("rejects an empty label with 400 and does not save", async () => {
    const { env, puts } = makeEnv();
    const res = await handleConfigApi(
      env,
      postJson({ interestAxes: [{ id: "ai", label: "   " }], feeds: [] }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; errors: string[] };
    expect(json.ok).toBe(false);
    expect(json.errors.length).toBeGreaterThan(0);
    expect(puts.length).toBe(0);
  });

  it("rejects zero axes with 400 (at least one required)", async () => {
    const { env, puts } = makeEnv();
    const res = await handleConfigApi(
      env,
      postJson({ interestAxes: [], feeds: [] }),
    );
    expect(res.status).toBe(400);
    expect(puts.length).toBe(0);
  });

  it("rejects an invalid feed URL with 400 and does not save", async () => {
    const { env, puts } = makeEnv();
    const res = await handleConfigApi(
      env,
      postJson({
        interestAxes: [{ id: "ai", label: "AI" }],
        feeds: ["not a url"],
      }),
    );
    expect(res.status).toBe(400);
    expect(puts.length).toBe(0);
  });

  it("drops blank feed entries before saving", async () => {
    const { env, saved } = makeEnv();
    await handleConfigApi(
      env,
      postJson({
        interestAxes: [{ id: "ai", label: "AI" }],
        feeds: ["https://a.example/rss", "  ", ""],
      }),
    );
    expect(saved().sources.feeds).toEqual(["https://a.example/rss"]);
  });

  it("rejects malformed JSON with 400", async () => {
    const { env, puts } = makeEnv();
    const bad = new Request("https://x/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    const res = await handleConfigApi(env, bad);
    expect(res.status).toBe(400);
    expect(puts.length).toBe(0);
  });
});
