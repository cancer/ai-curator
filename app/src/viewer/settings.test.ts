import { describe, it, expect } from "vitest";
import { renderSettingsForm, handleSettingsUpdate } from "./settings";
import type { Env } from "../index";
import { SYSTEM_CONFIG, type UserConfig } from "../config";

function baseUser(): UserConfig {
  return {
    interestAxes: [
      { id: "ai", label: "AI", seedText: "about ai" },
      { id: "web-fw", label: "Web FW", seedText: "about web" },
    ],
    sources: {
      githubRepos: ["owner/repo"],
      hnMinPoints: 10,
      mediumAuthorFeeds: ["@alice"],
      mediumTagFeeds: ["golang"],
      fowlerFeed: true,
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
function validFields(): Record<string, string> {
  return {
    "axis-0-id": "ai",
    "axis-0-label": "AI",
    "axis-0-seedText": "about ai",
    "axis-1-id": "web-fw",
    "axis-1-label": "Web FW",
    "axis-1-seedText": "about web",
    githubRepos: "owner/repo",
    mediumAuthorFeeds: "@alice",
    mediumTagFeeds: "golang",
    hnMinPoints: "10",
  };
}

describe("renderSettingsForm", () => {
  it("renders current config values in a post form", async () => {
    const { env } = makeEnv();
    const res = await renderSettingsForm(env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('method="post"');
    expect(html).toContain("about ai");
    expect(html).toContain("owner/repo");
    // scoring は SYSTEM_CONFIG の値を表示のみ（値が見えること）
    expect(html).toContain(String(SYSTEM_CONFIG.scoring.weights.interest));
  });

  it("opens with the default form even when KV is empty", async () => {
    const { env } = makeEmptyEnv();
    const res = await renderSettingsForm(env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('method="post"');
    // DEFAULT_USER_CONFIG の既定関心軸が初期表示される。
    expect(html).toContain("software-design");
  });
});

describe("handleSettingsUpdate", () => {
  it("saves valid input and redirects 303 to /settings", async () => {
    const { env, puts, saved } = makeEnv();
    const fields = validFields();
    fields["axis-0-seedText"] = "brand new seed";
    const res = await handleSettingsUpdate(env, postForm(fields));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/settings");
    expect(puts.length).toBe(1);
    expect(saved().interestAxes[0].seedText).toBe("brand new seed");
    // KV には interestAxes / sources のみ書く（システム側は書かない）。
    expect(Object.keys(saved()).sort()).toEqual(["interestAxes", "sources"]);
    // フォーム外の fowlerFeed は元の値を保つ。
    expect(saved().sources.fowlerFeed).toBe(true);
  });

  it("saves from the default form when KV is empty", async () => {
    const { env, puts, saved } = makeEmptyEnv();
    const res = await handleSettingsUpdate(env, postForm(validFields()));
    expect(res.status).toBe(303);
    expect(puts.length).toBe(1);
    expect(Object.keys(saved()).sort()).toEqual(["interestAxes", "sources"]);
    // フォームに無い fowlerFeed は DEFAULT_USER_CONFIG の値を引き継ぐ。
    expect(saved().sources.fowlerFeed).toBe(true);
  });

  it("adds a new axis from the blank add-row", async () => {
    const { env, saved } = makeEnv();
    const fields = validFields();
    fields["axis-2-id"] = "new-axis";
    fields["axis-2-label"] = "New";
    fields["axis-2-seedText"] = "new seed";
    const res = await handleSettingsUpdate(env, postForm(fields));
    expect(res.status).toBe(303);
    expect(saved().interestAxes.map((a) => a.id)).toContain("new-axis");
  });

  it("deletes an axis whose delete checkbox is set", async () => {
    const { env, saved } = makeEnv();
    const fields = validFields();
    fields["axis-1-delete"] = "on";
    await handleSettingsUpdate(env, postForm(fields));
    expect(saved().interestAxes.map((a) => a.id)).toEqual(["ai"]);
  });

  it("rejects an invalid repo format with 400 and preserves input", async () => {
    const { env, puts } = makeEnv();
    const fields = validFields();
    fields.githubRepos = "not-a-valid-repo";
    const res = await handleSettingsUpdate(env, postForm(fields));
    expect(res.status).toBe(400);
    expect(puts.length).toBe(0);
    const html = await res.text();
    expect(html).toContain("not-a-valid-repo");
  });

  it("rejects an empty seedText with 400", async () => {
    const { env, puts } = makeEnv();
    const fields = validFields();
    fields["axis-0-seedText"] = "   ";
    const res = await handleSettingsUpdate(env, postForm(fields));
    expect(res.status).toBe(400);
    expect(puts.length).toBe(0);
  });

  it("rejects an invalid axis id with 400", async () => {
    const { env, puts } = makeEnv();
    const fields = validFields();
    fields["axis-0-id"] = "Bad_ID";
    const res = await handleSettingsUpdate(env, postForm(fields));
    expect(res.status).toBe(400);
    expect(puts.length).toBe(0);
  });

  it("rejects a non-numeric hnMinPoints with 400", async () => {
    const { env, puts } = makeEnv();
    const fields = validFields();
    fields.hnMinPoints = "abc";
    const res = await handleSettingsUpdate(env, postForm(fields));
    expect(res.status).toBe(400);
    expect(puts.length).toBe(0);
  });

  it("rejects an empty hnMinPoints with 400 (Number('') === 0 must not slip through)", async () => {
    const { env, puts } = makeEnv();
    const fields = validFields();
    fields.hnMinPoints = "   ";
    const res = await handleSettingsUpdate(env, postForm(fields));
    expect(res.status).toBe(400);
    expect(puts.length).toBe(0);
  });
});
