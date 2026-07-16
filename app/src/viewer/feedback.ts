/**
 * フィードバック収集（FR-5）。
 *
 * click（読了イベント）は追記ログとして feedback へ insert する。
 * 投票（👍/👎）は「記事ごとに現在値が 1 つ」という別の不変条件なので article_vote に
 * 現在値として持つ: 再投票は上書き、同じ投票の再押下はトグル解除（行削除）。
 */

import type { Env } from "../index";

/** feed_entry(id) から article_id と一次ソース URL を 1 行引く。 */
const RESOLVE_SQL =
  "SELECT fe.article_id AS article_id, a.url AS url " +
  "FROM feed_entries fe JOIN articles a ON a.id = fe.article_id " +
  "WHERE fe.id = ?";

const INSERT_CLICK_SQL = "INSERT INTO feedback (article_id, kind) VALUES (?, ?)";

const SELECT_VOTE_SQL = "SELECT vote FROM article_vote WHERE article_id = ?";

// 同記事の再投票は現在値を上書きする（追記しない）。
const UPSERT_VOTE_SQL =
  "INSERT INTO article_vote (article_id, vote) VALUES (?, ?) " +
  "ON CONFLICT(article_id) DO UPDATE SET vote = excluded.vote, " +
  "created_at = datetime('now')";

const DELETE_VOTE_SQL = "DELETE FROM article_vote WHERE article_id = ?";

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

  await env.DB.prepare(INSERT_CLICK_SQL).bind(entry.article_id, "click").run();

  return new Response(null, {
    status: 302,
    headers: { location: entry.url },
  });
}

/**
 * `POST /api/feedback`: body `{ feed_entry_id, kind:"up"|"down" }` を受け取り
 * article_vote へ反映する。同じ投票の再押下はトグル解除（行削除）、異なる投票は上書き。
 * kind 以外・不正 JSON は 400、entry 無しは 404。成功時は反映後の状態
 * `{ vote:"up"|"down"|null }` を 200 で返す（クライアントが状態を同期できる）。
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

  const current = await env.DB.prepare(SELECT_VOTE_SQL)
    .bind(entry.article_id)
    .first<{ vote: string }>();

  // 同じ投票をもう一度押したらトグル解除する。それ以外は現在値を kind に上書きする。
  const resulting: "up" | "down" | null =
    current?.vote === kind ? null : kind;
  const sql = resulting === null ? DELETE_VOTE_SQL : UPSERT_VOTE_SQL;
  const stmt =
    resulting === null
      ? env.DB.prepare(sql).bind(entry.article_id)
      : env.DB.prepare(sql).bind(entry.article_id, kind);
  await stmt.run();

  return Response.json({ vote: resulting });
}
