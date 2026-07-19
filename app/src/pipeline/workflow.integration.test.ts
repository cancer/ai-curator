import { describe, it, expect, vi } from "vitest";
import { NonRetryableError } from "cloudflare:workflows";
import { runDailyWorkflow } from "./workflow";
import { sha256Hex } from "../lib/embedding";
import { SYSTEM_CONFIG } from "../config";
import type { Env } from "../index";

/**
 * step.do の 3 引数形（name, config, callback）を模す。
 * - runCallbacks=false: callback は実行せず、outputs の canned 値を返す（step グラフ検証用）。
 * - failNames: その step 名は throw（全リトライ使い切り = await が throw する状況を模す）。
 */
function makeStep(opts: {
  runCallbacks?: boolean;
  failNames?: Set<string>;
  outputs?: Map<string, unknown>;
}) {
  const names: string[] = [];
  const configs: unknown[] = [];
  const step = {
    names,
    configs,
    async do(name: string, config: unknown, callback: () => Promise<unknown>) {
      names.push(name);
      configs.push(config);
      if (opts.failNames?.has(name)) {
        throw new Error(`step ${name} exhausted retries`);
      }
      if (opts.runCallbacks) {
        return await callback();
      }
      return opts.outputs?.get(name) ?? {};
    },
  };
  return step;
}

const event = (timestamp: Date) =>
  ({ payload: {}, timestamp, instanceId: "i", workflowName: "w" }) as never;

function configOutput(feeds: string[]) {
  return {
    interestAxes: [{ id: "ai", label: "AI" }],
    sources: { feeds },
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

describe("DailyPass — step graph", () => {
  it("runs load-config, one ingest step per feed, then axis-sync/score/summarize/trends", async () => {
    const outputs = new Map<string, unknown>([
      ["load-config", configOutput(["https://a/rss", "https://b/atom"])],
    ]);
    const step = makeStep({ runCallbacks: false, outputs });
    await runDailyWorkflow({} as Env, event(new Date("2026-07-08T21:00:00.000Z")), step as never);

    expect(step.names).toEqual([
      "load-config",
      "ingest:https://a/rss",
      "ingest:https://b/atom",
      "axis-sync",
      "score",
      "summarize",
      "relevance-gate",
      "trends",
    ]);
    // Every step declares the retry config.
    for (const c of step.configs) {
      expect(c).toMatchObject({ retries: { limit: 5 } });
    }
  });
});

describe("DailyPass — source failure policy", () => {
  it("tolerates a single failed feed and continues", async () => {
    const outputs = new Map<string, unknown>([
      ["load-config", configOutput(["https://a/rss", "https://b/atom"])],
    ]);
    const step = makeStep({
      runCallbacks: false,
      outputs,
      failNames: new Set(["ingest:https://a/rss"]),
    });
    await runDailyWorkflow({} as Env, event(new Date("2026-07-08T21:00:00.000Z")), step as never);

    // score/summarize/trends still ran despite one feed failing.
    expect(step.names).toContain("score");
    expect(step.names).toContain("trends");
  });

  it("throws when every feed fails", async () => {
    const outputs = new Map<string, unknown>([
      ["load-config", configOutput(["https://a/rss", "https://b/atom"])],
    ]);
    const step = makeStep({
      runCallbacks: false,
      outputs,
      failNames: new Set(["ingest:https://a/rss", "ingest:https://b/atom"]),
    });
    await expect(
      runDailyWorkflow({} as Env, event(new Date("2026-07-08T21:00:00.000Z")), step as never),
    ).rejects.toThrow(/all 2 source/);
  });
});

describe("DailyPass — load-config", () => {
  it("wraps a config load failure in NonRetryableError", async () => {
    // runCallbacks=true → the load-config callback runs loadConfig against env.DB,
    // which returns zero interest axes → loadConfig throws → wrapped as NonRetryableError.
    const emptyDb = {
      prepare() {
        return {
          bind() {
            return this;
          },
          async all<T>() {
            return { results: [] as T[], success: true, meta: {} };
          },
        };
      },
    };
    const env = { DB: emptyDb } as unknown as Env;
    const step = makeStep({ runCallbacks: true });
    await expect(
      runDailyWorkflow(env, event(new Date("2026-07-08T21:00:00.000Z")), step as never),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });
});

describe("DailyPass — time source", () => {
  it("derives window/date from event.timestamp, never new Date()", async () => {
    // Full run with empty feeds so ingest is skipped; a flexible fake DB records the
    // date used for feed_entries/feed_trends. If run() used new Date() the date would
    // not match the (past) event timestamp.
    const eventTs = new Date("2026-07-08T21:00:00.000Z");
    const labelHash = await sha256Hex("AI");

    const ops: { kind: string; args: unknown[] }[] = [];
    const db = {
      prepare(sql: string) {
        const s = sql.replace(/\s+/g, " ").trim();
        return {
          _args: [] as unknown[],
          bind(...args: unknown[]) {
            this._args = args;
            return this;
          },
          async all<T>() {
            // syncInterestAxes: report the axis as already up-to-date (no AI call).
            if (s.includes("seed_hash")) {
              return {
                results: [
                  {
                    axis_id: "ai",
                    seed_hash: labelHash,
                    embedding_model: SYSTEM_CONFIG.embedding.model,
                  },
                ] as unknown as T[],
              };
            }
            // loadConfig: axes(label 列) / feeds を D1 から読む。
            if (s.includes("FROM interest_axes") && s.includes("label")) {
              return {
                results: [{ axis_id: "ai", label: "AI" }] as unknown as T[],
              };
            }
            if (s.includes("FROM feed_source")) {
              return { results: [] as T[] };
            }
            return { results: [] as T[] };
          },
          async run() {
            let kind = "other";
            if (/^DELETE FROM feed_entries/i.test(s)) kind = "delete-entries";
            else if (/^DELETE FROM feed_trends/i.test(s)) kind = "delete-trends";
            else if (/^INSERT INTO feed_trends/i.test(s)) kind = "insert-trend";
            ops.push({ kind, args: this._args });
            return { success: true, meta: { changes: 1 } };
          },
        };
      },
    };
    const env = {
      DB: db,
      AI: { run: vi.fn() },
    } as unknown as Env;
    const step = makeStep({ runCallbacks: true });
    await runDailyWorkflow(env, event(eventTs), step as never);

    const del = ops.find((o) => o.kind === "delete-entries");
    expect(del?.args[0]).toBe("2026-07-08");
    const trendDel = ops.find((o) => o.kind === "delete-trends");
    expect(trendDel?.args[0]).toBe("2026-07-08");
  });
});
