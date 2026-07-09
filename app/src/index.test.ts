import { describe, it, expect } from "vitest";
import worker from "./index";
import type { Env } from "./index";

/** ルーティング確認用の最小 env。SQL の内容で first() の戻りを分岐する。 */
function makeEnv() {
  const inserts: unknown[][] = [];
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
          if (s.includes("MAX(date)")) return { date: null } as unknown as T;
          // feed_entry の解決
          if (Number(this._args[0]) === 5) {
            return { article_id: 1, url: "https://example.invalid/x" } as unknown as T;
          }
          return null;
        },
        async run() {
          inserts.push(this._args);
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  };
  const env = { DB: db, AI: {}, CONFIG: {} } as unknown as Env;
  return { env, inserts };
}

const ctx = {} as ExecutionContext;

function req(
  path: string,
  init?: RequestInit,
): Request<unknown, IncomingRequestCfProperties<unknown>> {
  return new Request(`https://x${path}`, init) as unknown as Request<
    unknown,
    IncomingRequestCfProperties<unknown>
  >;
}

describe("fetch router", () => {
  it("GET / returns the feed page", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch!(req("/"), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("GET /r/{id} records a click and redirects", async () => {
    const { env, inserts } = makeEnv();
    const res = await worker.fetch!(req("/r/5"), env, ctx);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.invalid/x");
    expect(inserts).toEqual([[1, "click"]]);
  });

  it("POST /api/feedback with a bad kind returns 400", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch!(
      req("/api/feedback", {
        method: "POST",
        body: JSON.stringify({ feed_entry_id: 5, kind: "nope" }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("unknown paths return 404", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch!(req("/nope"), env, ctx);
    expect(res.status).toBe(404);
  });

  it("POST /run kicks off runDaily via waitUntil and redirects", async () => {
    const { env } = makeEnv();
    let captured: Promise<unknown> | undefined;
    // waitUntil に渡された promise を捕捉し、reject は握り潰す（stub env で
    // runDaily は load(env) 段階で落ちるが、それは検証対象ではない）。
    const runCtx = {
      waitUntil: (p: Promise<unknown>) => {
        captured = p;
        p.catch(() => {});
      },
    } as unknown as ExecutionContext;
    const res = await worker.fetch!(req("/run", { method: "POST" }), env, runCtx);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/settings?ran=1");
    expect(captured).toBeInstanceOf(Promise);
  });
});
