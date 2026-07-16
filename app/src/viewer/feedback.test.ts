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
 * feed_entries⋈articles の解決と、feedback(click) INSERT・article_vote の
 * SELECT/UPSERT/DELETE を扱う in-memory D1 フェイク。feedback への insert は
 * inserts に、投票の現在値は votes(Map) に記録する。
 */
function makeEnv(entries: FeedEntryRow[]) {
  const inserts: Insert[] = [];
  const votes = new Map<number, string>();
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
          if (/^SELECT vote FROM article_vote/i.test(s)) {
            const id = Number(this._args[0]);
            if (!votes.has(id)) return null;
            return { vote: votes.get(id) } as unknown as T;
          }
          // RESOLVE_SQL: feed_entries⋈articles
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
          } else if (/^INSERT INTO article_vote/i.test(s)) {
            votes.set(this._args[0] as number, this._args[1] as string);
          } else if (/^DELETE FROM article_vote/i.test(s)) {
            votes.delete(this._args[0] as number);
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  };
  const env = { DB: db, AI: {}, CONFIG: {} } as unknown as Env;
  return { env, inserts, votes };
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

  it("records an up vote in article_vote and returns the resulting state", async () => {
    const { env, inserts, votes } = makeEnv([entry]);
    const res = await handleFeedbackApi(env, post({ feed_entry_id: 7, kind: "up" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ vote: "up" });
    expect(votes.get(42)).toBe("up");
    // 投票は feedback には書かない（click 専用に据え置き）。
    expect(inserts).toEqual([]);
  });

  it("records a down vote", async () => {
    const { env, votes } = makeEnv([entry]);
    const res = await handleFeedbackApi(env, post({ feed_entry_id: 7, kind: "down" }));
    expect(await res.json()).toEqual({ vote: "down" });
    expect(votes.get(42)).toBe("down");
  });

  it("overwrites the opposite vote (exclusive: down then up leaves only up)", async () => {
    const { env, votes } = makeEnv([entry]);
    await handleFeedbackApi(env, post({ feed_entry_id: 7, kind: "down" }));
    const res = await handleFeedbackApi(env, post({ feed_entry_id: 7, kind: "up" }));
    expect(await res.json()).toEqual({ vote: "up" });
    expect(votes.get(42)).toBe("up");
  });

  it("toggles a vote off when the same vote is pressed again", async () => {
    const { env, votes } = makeEnv([entry]);
    await handleFeedbackApi(env, post({ feed_entry_id: 7, kind: "up" }));
    const res = await handleFeedbackApi(env, post({ feed_entry_id: 7, kind: "up" }));
    expect(await res.json()).toEqual({ vote: null });
    expect(votes.has(42)).toBe(false);
  });

  it("rejects an invalid kind with 400 before touching the db", async () => {
    const { env, votes } = makeEnv([entry]);
    const res = await handleFeedbackApi(env, post({ feed_entry_id: 7, kind: "click" }));
    expect(res.status).toBe(400);
    expect(votes.size).toBe(0);
  });

  it("rejects malformed JSON with 400", async () => {
    const { env } = makeEnv([entry]);
    expect((await handleFeedbackApi(env, post("{not json"))).status).toBe(400);
  });

  it("returns 404 when the feed entry does not exist", async () => {
    const { env, votes } = makeEnv([entry]);
    const res = await handleFeedbackApi(env, post({ feed_entry_id: 999, kind: "up" }));
    expect(res.status).toBe(404);
    expect(votes.size).toBe(0);
  });
});
