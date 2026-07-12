/**
 * フィード表示（閲覧画面）。
 *
 * 最新 date のフィードを HTML で返す。上から (1) 軸ごとの傾向サマリ
 * (2) ランク順の記事リスト。記事タイトルのリンク先はクリック記録用の
 * `/r/{feed_entry_id}`（一次ソース URL も出典として併記する）。
 * ページングは `?page=N`（1 ページ 20 件）。SPA にはしない。
 */

import type { Env } from "../index";
import { loadConfig } from "../config";
import { escapeHtml, page, htmlResponse } from "./layout";

const PAGE_SIZE = 20;

const MAX_DATE_SQL = "SELECT MAX(date) AS date FROM feed_entries";

const TRENDS_SQL =
  "SELECT axis_id, hit_count, narrative FROM feed_trends " +
  "WHERE date = ? ORDER BY hit_count DESC";

// LIMIT は PAGE_SIZE+1 件取り、余りの有無で次ページの存在を判定する。
const ENTRIES_SQL =
  "SELECT fe.id AS feed_entry_id, fe.rank AS rank, fe.summary AS summary, " +
  "a.title AS title, a.source AS source, a.published_at AS published_at, " +
  "a.url AS url, a.hit_axis AS hit_axis " +
  "FROM feed_entries fe JOIN articles a ON a.id = fe.article_id " +
  "WHERE fe.date = ? ORDER BY fe.rank LIMIT ? OFFSET ?";

interface EntryRow {
  feed_entry_id: number;
  rank: number;
  summary: string | null;
  title: string;
  source: string;
  published_at: string;
  url: string;
  hit_axis: string | null;
}

interface TrendRow {
  axis_id: string;
  hit_count: number;
  narrative: string | null;
}

/** 👍/👎 は最小のインライン JS で /api/feedback へ POST する（失敗時は無視）。 */
const FEEDBACK_SCRIPT = `
document.addEventListener("click", function (e) {
  var b = e.target.closest("button[data-entry-id]");
  if (!b) return;
  fetch("/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      feed_entry_id: Number(b.dataset.entryId),
      kind: b.dataset.kind,
    }),
  }).then(function () { b.disabled = true; }).catch(function () {});
});
`;

function renderTrends(trends: TrendRow[], labels: Map<string, string>): string {
  if (trends.length === 0) return "";
  const items = trends
    .map((t) => {
      const label = labels.get(t.axis_id) ?? t.axis_id;
      const narrative =
        t.narrative === null
          ? ""
          : `<p class="narrative">${escapeHtml(t.narrative)}</p>`;
      return (
        `<li><strong>${escapeHtml(label)}</strong> ` +
        `<span class="meta">${t.hit_count}件</span>${narrative}</li>`
      );
    })
    .join("");
  return `<h2>今日の傾向</h2><ul class="trends">${items}</ul>`;
}

function renderEntry(entry: EntryRow, labels: Map<string, string>): string {
  const axisLabel =
    entry.hit_axis === null
      ? ""
      : ` <span class="meta">軸: ${escapeHtml(
          labels.get(entry.hit_axis) ?? entry.hit_axis,
        )}</span>`;
  const summary =
    entry.summary === null
      ? ""
      : `<p class="summary">${escapeHtml(entry.summary)}</p>`;
  const url = escapeHtml(entry.url);
  return (
    `<li>` +
    `<span class="rank">#${entry.rank}</span>` +
    `<a href="/r/${entry.feed_entry_id}">${escapeHtml(entry.title)}</a>` +
    `<div class="meta">${escapeHtml(entry.source)}・` +
    `${escapeHtml(entry.published_at)}${axisLabel}</div>` +
    `<div class="meta">出典: <a href="${url}">${url}</a></div>` +
    summary +
    `<div><button data-entry-id="${entry.feed_entry_id}" data-kind="up">👍</button>` +
    `<button data-entry-id="${entry.feed_entry_id}" data-kind="down">👎</button></div>` +
    `</li>`
  );
}

/** 最新フィードを 1 ページ分レンダリングする。page は 1 未満を 1 に丸める。 */
export async function renderFeedPage(
  env: Env,
  pageNumber: number,
): Promise<Response> {
  const current = Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : 1;

  const latest = await env.DB.prepare(MAX_DATE_SQL).first<{
    date: string | null;
  }>();
  const date = latest?.date ?? null;

  if (date === null) {
    return htmlResponse(
      page("フィード", "<h1>フィード</h1><p>まだフィードがありません。</p>"),
    );
  }

  const config = await loadConfig(env);
  const labels = new Map(config.interestAxes.map((a) => [a.id, a.label]));

  const trendRows =
    (await env.DB.prepare(TRENDS_SQL).bind(date).all<TrendRow>()).results ?? [];

  const offset = (current - 1) * PAGE_SIZE;
  const fetched =
    (
      await env.DB.prepare(ENTRIES_SQL)
        .bind(date, PAGE_SIZE + 1, offset)
        .all<EntryRow>()
    ).results ?? [];
  const hasNext = fetched.length > PAGE_SIZE;
  const entries = fetched.slice(0, PAGE_SIZE);

  const list = entries.map((e) => renderEntry(e, labels)).join("");
  const more = hasNext
    ? `<p><a href="/?page=${current + 1}">もっと見る</a></p>`
    : "";

  const body =
    `<h1>フィード <span class="meta">${escapeHtml(date)}</span></h1>` +
    `<p><a href="/settings">設定</a></p>` +
    renderTrends(trendRows, labels) +
    `<h2>記事</h2><ul class="entries">${list}</ul>` +
    more +
    `<script>${FEEDBACK_SCRIPT}</script>`;

  return htmlResponse(page("フィード", body));
}
