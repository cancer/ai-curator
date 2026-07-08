import { describe, it, expect } from "vitest";
import { renderSettingsForm, handleSettingsUpdate } from "./settings";
import type { Env } from "../index";
import type { Config } from "../config";

function baseConfig(): Config {
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
    scoring: {
      weights: { interest: 0.6, freshness: 0.3, sourceTrust: 0.1 },
      freshnessHalfLifeDays: 7,
      semanticDedupThreshold: 0.9,
      sourceTrust: { github: 1, fowler: 1, medium: 0.7, hn: 0.5 },
    },
    embedding: { model: "m", maxInputChars: 1000 },
    digest: { model: "d", summaryTopN: 10, maxOutputTokens: 300 },
  };
}

function makeEnv(config: Config = baseConfig()) {
  let stored = JSON.stringify(config);
  const puts: string[] = [];
  const CONFIG = {
    get: async () => stored,
    put: async (_k: string, v: string) => {
      stored = v;
      puts.push(v);
    },
  };
  const env = { CONFIG, DB: {}, AI: {} } as unknown as Env;
  return { env, puts, saved: () => JSON.parse(puts[puts.length - 1]) as Config };
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
    // scoring は表示のみ（値が見えること）
    expect(html).toContain("0.6");
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
    // 変更不可の scoring/embedding/digest/fowlerFeed は元の値を保つ
    expect(saved().scoring.weights.interest).toBe(0.6);
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
