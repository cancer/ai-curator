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
  // 日次パスの Workflow バインディング（create/get→status を模す）。
  const created: string[] = [];
  const DAILY_PASS = {
    create: async () => {
      const id = `wf-${created.length + 1}`;
      created.push(id);
      return { id };
    },
    get: async (id: string) => ({
      id,
      status: async () => ({ status: "running", output: null }),
    }),
  };
  const env = { DB: db, AI: {}, DAILY_PASS } as unknown as Env;
  return { env, inserts, created };
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

  it("POST /run creates a Workflow instance and redirects with its id", async () => {
    const { env, created } = makeEnv();
    const res = await worker.fetch!(req("/run", { method: "POST" }), env, ctx);
    expect(res.status).toBe(303);
    expect(created).toHaveLength(1);
    expect(res.headers.get("location")).toBe(`/settings?run=${created[0]}`);
  });

  it("GET /runs/{id} returns the instance status as JSON", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch!(req("/runs/wf-42"), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ status: "running", output: null });
  });
});
