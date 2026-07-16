import { describe, it, expect } from "vitest";
import { renderSettingsForm, handleSettingsUpdate } from "./settings";
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

/** interest_axes 行（派生列は cron が埋めるので初期 null）。 */
interface AxisRow {
  axis_id: string;
  label: string;
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
    seed_hash: `hash-${a.id}`,
    embedding: "[0.1]",
    embedding_model: "@cf/baai/bge-m3",
  }));
  const feeds: string[] = [...(user?.sources.feeds ?? [])];
  const puts: unknown[] = [];

  function apply(sql: string, args: unknown[]): void {
    if (/^INSERT INTO interest_axes/i.test(sql)) {
      const [axisId, label] = args as [string, string];
      const existing = axes.find((a) => a.axis_id === axisId);
      if (existing) existing.label = label;
      else
        axes.push({
          axis_id: axisId,
          label,
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
      interestAxes: axes.map((a) => ({ id: a.axis_id, label: a.label })),
      sources: { feeds: [...feeds] },
    }),
  };
}

/** D1 に何も無い（空）状態の Env。フォーム初期表示のフォールバック検証用。 */
function makeEmptyEnv() {
  return makeStore(null);
}

function makeEnv(user: UserConfig = baseUser()) {
  return makeStore(user);
}

function postForm(fields: Record<string, string>): Request {
  return new Request("https://x/settings", {
    method: "POST",
    body: new URLSearchParams(fields),
  });
}

// 2 軸 + ソースの妥当なフォーム値。テストごとに一部を差し替える。
// 関心軸はラベルのみ入力（seedText 廃止）。既存軸は hidden id を round-trip する。
function validFields(): Record<string, string> {
  return {
    "axis-0-id": "ai",
    "axis-0-label": "AI",
    "axis-1-id": "web-fw",
    "axis-1-label": "Web FW",
    feeds: "https://martinfowler.com/feed.atom",
  };
}

describe("renderSettingsForm", () => {
  it("renders current config values in a post form", async () => {
    const { env } = makeEnv();
    const res = await renderSettingsForm(env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('method="post"');
    expect(html).toContain("martinfowler.com/feed.atom");
    // scoring は SYSTEM_CONFIG の値を表示のみ（値が見えること）
    expect(html).toContain(String(SYSTEM_CONFIG.scoring.weights.interest));
  });

  it("opens with an empty form when KV is empty", async () => {
    const { env } = makeEmptyEnv();
    const res = await renderSettingsForm(env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('method="post"');
    // 空 KV では設定をコードに持たないので、フォームは空（feeds と新規トピック欄のみ）で開く。
    expect(html).toContain('name="feeds"');
    expect(html).toContain('name="newTopics"');
  });

  it("renders a multi-line textarea for adding topics in bulk", async () => {
    const { env } = makeEnv();
    const html = await (await renderSettingsForm(env)).text();
    expect(html).toContain('<textarea name="newTopics"');
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
});

describe("handleSettingsUpdate", () => {
  it("saves valid input and redirects 303 to /settings", async () => {
    const { env, puts, saved } = makeEnv();
    const fields = validFields();
    fields["axis-0-label"] = "brand new label";
    const res = await handleSettingsUpdate(env, postForm(fields));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/settings");
    expect(puts.length).toBe(1);
    expect(saved().interestAxes[0].label).toBe("brand new label");
    // 既存軸の id は hidden で round-trip され保持される。
    expect(saved().interestAxes[0].id).toBe("ai");
    // KV には interestAxes / sources のみ書く（システム側は書かない）。
    expect(Object.keys(saved()).sort()).toEqual(["interestAxes", "sources"]);
    // sources は feeds のみ。
    expect(Object.keys(saved().sources).sort()).toEqual(["feeds"]);
  });

  it("saves from the default form when KV is empty", async () => {
    const { env, puts, saved } = makeEmptyEnv();
    const res = await handleSettingsUpdate(env, postForm(validFields()));
    expect(res.status).toBe(303);
    expect(puts.length).toBe(1);
    expect(Object.keys(saved()).sort()).toEqual(["interestAxes", "sources"]);
    expect(saved().sources.feeds).toEqual([
      "https://martinfowler.com/feed.atom",
    ]);
  });

  it("adds multiple topics at once from the newTopics textarea, each with a fresh id", async () => {
    const { env, saved } = makeEnv();
    const fields = validFields();
    // 1 行 1 件で何件でも追加できる（id は保存時に採番）。
    fields.newTopics = "Topic A\nTopic B\nTopic C";
    const res = await handleSettingsUpdate(env, postForm(fields));
    expect(res.status).toBe(303);
    const labels = saved().interestAxes.map((a) => a.label);
    expect(labels).toEqual(expect.arrayContaining(["Topic A", "Topic B", "Topic C"]));
    // 全軸の id が一意に採番される。
    const ids = saved().interestAxes.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toBeTruthy();
  });

  it("saves topics-only input when KV is empty (bootstrap via newTopics)", async () => {
    const { env, saved } = makeEmptyEnv();
    const res = await handleSettingsUpdate(
      env,
      postForm({ feeds: "https://a.example/rss", newTopics: "AI" }),
    );
    expect(res.status).toBe(303);
    expect(saved().interestAxes.map((a) => a.label)).toEqual(["AI"]);
  });

  it("deletes an axis whose delete checkbox is set", async () => {
    const { env, saved } = makeEnv();
    const fields = validFields();
    fields["axis-1-delete"] = "on";
    await handleSettingsUpdate(env, postForm(fields));
    expect(saved().interestAxes.map((a) => a.id)).toEqual(["ai"]);
  });

  it("rejects an invalid feed URL with 400 and preserves input", async () => {
    const { env, puts } = makeEnv();
    const fields = validFields();
    fields.feeds = "not a url";
    const res = await handleSettingsUpdate(env, postForm(fields));
    expect(res.status).toBe(400);
    expect(puts.length).toBe(0);
    const html = await res.text();
    expect(html).toContain("not a url");
  });

  it("rejects an empty label with 400", async () => {
    const { env, puts } = makeEnv();
    const fields = validFields();
    fields["axis-0-label"] = "   ";
    const res = await handleSettingsUpdate(env, postForm(fields));
    expect(res.status).toBe(400);
    expect(puts.length).toBe(0);
  });
});
