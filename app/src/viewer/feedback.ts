/**
 * フィードバック収集（FR-5, 収集のみ）。
 *
 * v1 は収集専用。feedback を読む処理は実装しない（学習は v2）。
 * どちらの経路も feed_entry から article_id を解決してから feedback へ insert する。
 */

import type { Env } from "../index";

/** feed_entry(id) から article_id と一次ソース URL を 1 行引く。 */
const RESOLVE_SQL =
  "SELECT fe.article_id AS article_id, a.url AS url " +
  "FROM feed_entries fe JOIN articles a ON a.id = fe.article_id " +
  "WHERE fe.id = ?";

const INSERT_SQL = "INSERT INTO feedback (article_id, kind) VALUES (?, ?)";

interface ResolvedEntry {
  article_id: number;
  url: string;
}

async function resolveEntry(
  env: Env,
  feedEntryId: number,
): Promise<ResolvedEntry | null> {
  return env.DB.prepare(RESOLVE_SQL).bind(feedEntryId).first<ResolvedEntry>();
}

/**
 * `GET /r/{feed_entry_id}`: クリックを記録し一次ソース URL へ 302。
 * id が不正・該当 entry が無ければ 404。
 */
export async function handleClickRedirect(
  env: Env,
  rawId: string,
): Promise<Response> {
  const feedEntryId = Number(rawId);
  if (!Number.isInteger(feedEntryId) || feedEntryId <= 0) {
    return new Response("Not Found", { status: 404 });
  }

  const entry = await resolveEntry(env, feedEntryId);
  if (!entry) {
    return new Response("Not Found", { status: 404 });
  }

  await env.DB.prepare(INSERT_SQL).bind(entry.article_id, "click").run();

  return new Response(null, {
    status: 302,
    headers: { location: entry.url },
  });
}

/**
 * `POST /api/feedback`: body `{ feed_entry_id, kind:"up"|"down" }` を受け取り
 * feedback へ insert する。kind 以外・不正 JSON は 400、entry 無しは 404、成功は 204。
 */
export async function handleFeedbackApi(
  env: Env,
  request: Request,
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return new Response("Bad Request", { status: 400 });
  }
  const { feed_entry_id: rawId, kind } = body as Record<string, unknown>;

  // kind 検証を DB アクセスより先に行う（fail-fast）。
  if (kind !== "up" && kind !== "down") {
    return new Response("Bad Request", { status: 400 });
  }

  const feedEntryId = Number(rawId);
  if (!Number.isInteger(feedEntryId) || feedEntryId <= 0) {
    return new Response("Bad Request", { status: 400 });
  }

  const entry = await resolveEntry(env, feedEntryId);
  if (!entry) {
    return new Response("Not Found", { status: 404 });
  }

  await env.DB.prepare(INSERT_SQL).bind(entry.article_id, kind).run();

  return new Response(null, { status: 204 });
}
