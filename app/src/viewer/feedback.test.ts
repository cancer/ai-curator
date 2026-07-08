import { describe, it, expect } from "vitest";
import { handleClickRedirect, handleFeedbackApi } from "./feedback";
import type { Env } from "../index";

interface FeedEntryRow {
  id: number;
  article_id: number;
  url: string;
}

interface Insert {
  articleId: number;
  kind: string;
}

/**
 * feed_entries⋈articles を 1 行引く SELECT と feedback への INSERT だけを扱う
 * in-memory D1 フェイク。挿入は inserts に記録する。
 */
function makeEnv(entries: FeedEntryRow[]) {
  const inserts: Insert[] = [];
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
          const id = Number(this._args[0]);
          const row = entries.find((e) => e.id === id);
          if (!row) return null;
          return { article_id: row.article_id, url: row.url } as unknown as T;
        },
        async run() {
          if (/^INSERT INTO feedback/i.test(s)) {
            inserts.push({
              articleId: this._args[0] as number,
              kind: this._args[1] as string,
            });
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  };
  const env = { DB: db, AI: {}, CONFIG: {} } as unknown as Env;
  return { env, inserts };
}

const entry: FeedEntryRow = {
  id: 7,
  article_id: 42,
  url: "https://example.invalid/article",
};

describe("handleClickRedirect", () => {
  it("records a click and redirects 302 to the primary source url", async () => {
    const { env, inserts } = makeEnv([entry]);
    const res = await handleClickRedirect(env, "7");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.invalid/article");
    expect(inserts).toEqual([{ articleId: 42, kind: "click" }]);
  });

  it("returns 404 for a non-existent feed entry", async () => {
    const { env, inserts } = makeEnv([entry]);
    const res = await handleClickRedirect(env, "999");
    expect(res.status).toBe(404);
    expect(inserts).toEqual([]);
  });

  it("returns 404 for a non-numeric id", async () => {
    const { env } = makeEnv([entry]);
    expect((await handleClickRedirect(env, "abc")).status).toBe(404);
  });
});

describe("handleFeedbackApi", () => {
  function post(body: unknown): Request {
    return new Request("https://x/api/feedback", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("inserts an up feedback and returns 204", async () => {
    const { env, inserts } = makeEnv([entry]);
    const res = await handleFeedbackApi(env, post({ feed_entry_id: 7, kind: "up" }));
    expect(res.status).toBe(204);
    expect(inserts).toEqual([{ articleId: 42, kind: "up" }]);
  });

  it("inserts a down feedback", async () => {
    const { env, inserts } = makeEnv([entry]);
    await handleFeedbackApi(env, post({ feed_entry_id: 7, kind: "down" }));
    expect(inserts).toEqual([{ articleId: 42, kind: "down" }]);
  });

  it("rejects an invalid kind with 400 before touching the db", async () => {
    const { env, inserts } = makeEnv([entry]);
    const res = await handleFeedbackApi(env, post({ feed_entry_id: 7, kind: "click" }));
    expect(res.status).toBe(400);
    expect(inserts).toEqual([]);
  });

  it("rejects malformed JSON with 400", async () => {
    const { env } = makeEnv([entry]);
    expect((await handleFeedbackApi(env, post("{not json"))).status).toBe(400);
  });

  it("returns 404 when the feed entry does not exist", async () => {
    const { env, inserts } = makeEnv([entry]);
    const res = await handleFeedbackApi(env, post({ feed_entry_id: 999, kind: "up" }));
    expect(res.status).toBe(404);
    expect(inserts).toEqual([]);
  });
});
