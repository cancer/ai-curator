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
import { decodeSummary, SUMMARY_SECTIONS } from "../lib/summarize";

const PAGE_SIZE = 20;

const MAX_DATE_SQL = "SELECT MAX(date) AS date FROM feed_entries";

const TRENDS_SQL =
  "SELECT axis_id, hit_count, narrative FROM feed_trends " +
  "WHERE date = ? ORDER BY hit_count DESC";

// 要約は summaries に分離済み（1 記事 1 行）。行が無ければ summary は NULL。
// LIMIT/OFFSET で 1 ページ分だけ取る。総件数は COUNT_SQL で別途数える。
const ENTRIES_SQL =
  "SELECT fe.id AS feed_entry_id, fe.rank AS rank, s.text AS summary, " +
  "a.title AS title, a.source AS source, a.published_at AS published_at, " +
  "a.url AS url, a.hit_axis AS hit_axis, av.vote AS vote " +
  "FROM feed_entries fe JOIN articles a ON a.id = fe.article_id " +
  "LEFT JOIN summaries s ON s.article_id = fe.article_id " +
  "LEFT JOIN article_vote av ON av.article_id = fe.article_id " +
  "WHERE fe.date = ? ORDER BY fe.rank LIMIT ? OFFSET ?";

// その日の総件数。総ページ数・現在位置・前後リンクの有無を決めるのに使う。
const COUNT_SQL =
  "SELECT COUNT(*) AS total FROM feed_entries WHERE date = ?";

interface EntryRow {
  feed_entry_id: number;
  rank: number;
  summary: string | null;
  title: string;
  source: string;
  published_at: string;
  url: string;
  hit_axis: string | null;
  vote: string | null;
}

interface TrendRow {
  axis_id: string;
  hit_count: number;
  narrative: string | null;
}

/** 押下状態の視覚化。サーバの現在値を反映した aria-pressed="true" を目立たせる。 */
const FEEDBACK_STYLE = `
button[aria-pressed="true"] { outline: 2px solid currentColor;
  background: #8883; font-weight: bold; }
`;

/**
 * 👍/👎 は最小のインライン JS で /api/feedback へ POST し、応答の現在値
 * `{ vote }` で同記事の両ボタンの aria-pressed を上書きする（排他: 一方が押下なら
 * 他方は解除）。押下状態はサーバ応答を唯一の真実として同期する（失敗時は無視）。
 */
const FEEDBACK_SCRIPT = `
document.addEventListener("click", function (e) {
  var b = e.target.closest("button[data-entry-id]");
  if (!b) return;
  var group = b.parentNode;
  fetch("/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      feed_entry_id: Number(b.dataset.entryId),
      kind: b.dataset.kind,
    }),
  })
    .then(function (r) { return r.json(); })
    .then(function (state) {
      group.querySelectorAll("button[data-entry-id]").forEach(function (btn) {
        btn.setAttribute(
          "aria-pressed",
          btn.dataset.kind === state.vote ? "true" : "false",
        );
      });
    })
    .catch(function () {});
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

/**
 * 保存要約（構造化 JSON / raw / 旧プレーン行）を描画する。構造化できていれば見出し
 * ごとにセクション分けし（`.summary-section` + `<h4>`）、そうでなければ本文をそのまま
 * 段落で出す。コンテナは常に `.summary` 1 個（既存スタイル・レイアウトの基点）。
 */
function renderSummary(stored: string): string {
  const decoded = decodeSummary(stored);
  if ("raw" in decoded) {
    return `<div class="summary"><p>${escapeHtml(decoded.raw)}</p></div>`;
  }
  const sections = SUMMARY_SECTIONS.map(({ key, label }) => {
    const value = decoded.sections[key];
    if (value === "") return "";
    return (
      `<div class="summary-section">` +
      `<h4>${escapeHtml(label)}</h4>` +
      `<p>${escapeHtml(value)}</p>` +
      `</div>`
    );
  }).join("");
  return `<div class="summary">${sections}</div>`;
}

function renderEntry(entry: EntryRow, labels: Map<string, string>): string {
  const axisLabel =
    entry.hit_axis === null
      ? ""
      : ` <span class="meta">軸: ${escapeHtml(
          labels.get(entry.hit_axis) ?? entry.hit_axis,
        )}</span>`;
  const summary =
    entry.summary === null ? "" : renderSummary(entry.summary);
  const url = escapeHtml(entry.url);
  return (
    `<li>` +
    `<span class="rank">#${entry.rank}</span>` +
    `<a href="/r/${entry.feed_entry_id}">${escapeHtml(entry.title)}</a>` +
    `<div class="meta">${escapeHtml(entry.source)}・` +
    `${escapeHtml(entry.published_at)}${axisLabel}</div>` +
    `<div class="meta">出典: <a href="${url}">${url}</a></div>` +
    summary +
    `<div>` +
    voteButton(entry.feed_entry_id, "up", "👍", entry.vote) +
    voteButton(entry.feed_entry_id, "down", "👎", entry.vote) +
    `</div>` +
    `</li>`
  );
}

/**
 * ページネーション UI。前へ / 次へ（両端では出さない）と、現在ページ・総ページ数・
 * 総件数を出す。総ページ数と総件数で「あとどれくらいあるか」を読み手に示す。
 */
function renderPagination(
  current: number,
  totalPages: number,
  total: number,
): string {
  const prev =
    current > 1
      ? `<a href="/?page=${current - 1}">前へ</a>`
      : `<span class="disabled">前へ</span>`;
  const next =
    current < totalPages
      ? `<a href="/?page=${current + 1}">次へ</a>`
      : `<span class="disabled">次へ</span>`;
  const status = `<span class="meta">${current} / ${totalPages}（全${total}件）</span>`;
  return `<nav class="pagination">${prev} ${status} ${next}</nav>`;
}

/**
 * 投票ボタン 1 個。現在の vote と一致していれば押下状態（aria-pressed="true"）で描画する。
 * 押下状態は CSS の `button[aria-pressed="true"]` で視覚化する（#8: リロード後も維持）。
 */
function voteButton(
  feedEntryId: number,
  kind: "up" | "down",
  glyph: string,
  vote: string | null,
): string {
  const pressed = vote === kind ? "true" : "false";
  return (
    `<button data-entry-id="${feedEntryId}" data-kind="${kind}" ` +
    `aria-pressed="${pressed}">${glyph}</button>`
  );
}

/** 最新フィードを 1 ページ分レンダリングする。page は範囲外を 1..総ページ数 に丸める。 */
export async function renderFeedPage(
  env: Env,
  pageNumber: number,
): Promise<Response> {
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

  const countRow = await env.DB.prepare(COUNT_SQL).bind(date).first<{
    total: number;
  }>();
  const total = countRow?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const requested =
    Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : 1;
  const current = Math.min(requested, totalPages);

  const offset = (current - 1) * PAGE_SIZE;
  const entries =
    (
      await env.DB.prepare(ENTRIES_SQL)
        .bind(date, PAGE_SIZE, offset)
        .all<EntryRow>()
    ).results ?? [];

  const list = entries.map((e) => renderEntry(e, labels)).join("");

  const body =
    `<h1>フィード <span class="meta">${escapeHtml(date)}</span></h1>` +
    `<p><a href="/settings">設定</a></p>` +
    renderTrends(trendRows, labels) +
    `<h2>記事</h2><ul class="entries">${list}</ul>` +
    renderPagination(current, totalPages, total) +
    `<style>${FEEDBACK_STYLE}</style>` +
    `<script>${FEEDBACK_SCRIPT}</script>`;

  return htmlResponse(page("フィード", body));
}
