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

/** KV に何も無い（空）状態の Env。フォーム初期表示のフォールバック検証用。 */
function makeEmptyEnv() {
  let stored: string | null = null;
  const puts: string[] = [];
  const CONFIG = {
    get: async () => stored,
    put: async (_k: string, v: string) => {
      stored = v;
      puts.push(v);
    },
  };
  const env = { CONFIG, DB: {}, AI: {} } as unknown as Env;
  return {
    env,
    puts,
    saved: () => JSON.parse(puts[puts.length - 1]) as UserConfig,
  };
}

function makeEnv(user: UserConfig = baseUser()) {
  let stored: string | null = JSON.stringify(user);
  const puts: string[] = [];
  const CONFIG = {
    get: async () => stored,
    put: async (_k: string, v: string) => {
      stored = v;
      puts.push(v);
    },
  };
  const env = { CONFIG, DB: {}, AI: {} } as unknown as Env;
  return {
    env,
    puts,
    saved: () => JSON.parse(puts[puts.length - 1]) as UserConfig,
  };
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
    expect(html).not.toContain("実行を開始しました");
  });

  it("shows a started note when ran=1", async () => {
    const { env } = makeEnv();
    const html = await (await renderSettingsForm(env, true)).text();
    expect(html).toContain("実行を開始しました");
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
