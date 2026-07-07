import { describe, expect, test } from "bun:test";
import { backoffDelayMs, fetchWithRetry } from "./retry";

/** テスト用の fetch スタブ。応答を順番に返し、Error を指定した場合は例外として投げる。 */
function stubFetch(responses: (Response | Error)[]): { fetchFn: typeof fetch; callCount: () => number } {
  let calls = 0;
  const fetchFn = (async () => {
    const next = responses[calls];
    calls++;
    if (next instanceof Error) throw next;
    if (!next) throw new Error("stubFetch: 用意した応答を使い切った");
    return next;
  }) as unknown as typeof fetch;
  return { fetchFn, callCount: () => calls };
}

const noopSleep = async () => {};

describe("backoffDelayMs", () => {
  test("1s → 2s → 4s の指数バックオフになる", () => {
    expect(backoffDelayMs(0)).toBe(1000);
    expect(backoffDelayMs(1)).toBe(2000);
    expect(backoffDelayMs(2)).toBe(4000);
  });
});

describe("fetchWithRetry", () => {
  test("成功すれば 1 回だけ呼んでそのまま返す", async () => {
    const ok = new Response("ok", { status: 200 });
    const { fetchFn, callCount } = stubFetch([ok]);
    const res = await fetchWithRetry("https://x", undefined, { fetchFn, sleepFn: noopSleep });
    expect(res).toBe(ok);
    expect(callCount()).toBe(1);
  });

  test("ネットワーク例外はリトライして最終的に成功すれば返す", async () => {
    const ok = new Response("ok", { status: 200 });
    const { fetchFn, callCount } = stubFetch([new TypeError("network down"), ok]);
    const res = await fetchWithRetry("https://x", undefined, { fetchFn, sleepFn: noopSleep });
    expect(res).toBe(ok);
    expect(callCount()).toBe(2);
  });

  test("5xx 応答はリトライして最終的に成功すれば返す", async () => {
    const serverError = new Response("err", { status: 503 });
    const ok = new Response("ok", { status: 200 });
    const { fetchFn, callCount } = stubFetch([serverError, ok]);
    const res = await fetchWithRetry("https://x", undefined, { fetchFn, sleepFn: noopSleep });
    expect(res).toBe(ok);
    expect(callCount()).toBe(2);
  });

  test("4xx 応答はリトライせず即座に返す", async () => {
    const notFound = new Response("nf", { status: 404 });
    const { fetchFn, callCount } = stubFetch([notFound]);
    const res = await fetchWithRetry("https://x", undefined, { fetchFn, sleepFn: noopSleep });
    expect(res).toBe(notFound);
    expect(callCount()).toBe(1);
  });

  test("ネットワーク例外が maxRetries 回を超えて続けば最後の例外を投げる", async () => {
    const err = new TypeError("network down");
    const { fetchFn, callCount } = stubFetch([err, err, err, err]);
    await expect(
      fetchWithRetry("https://x", undefined, { fetchFn, sleepFn: noopSleep, maxRetries: 3 }),
    ).rejects.toThrow("network down");
    expect(callCount()).toBe(4); // 初回 + リトライ3回
  });

  test("5xx が maxRetries 回を超えて続けば最後の 5xx 応答を返す（呼び出し側で判定させる）", async () => {
    const serverError = new Response("err", { status: 500 });
    const { fetchFn, callCount } = stubFetch([serverError, serverError]);
    const res = await fetchWithRetry("https://x", undefined, { fetchFn, sleepFn: noopSleep, maxRetries: 1 });
    expect(res.status).toBe(500);
    expect(callCount()).toBe(2); // 初回 + リトライ1回
  });
});
