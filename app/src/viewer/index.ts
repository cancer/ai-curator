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

/**
 * カテゴリフィルタの「未分類」を表す予約センチネル（`?category=` の値）。
 * category は自由入力なので理論上衝突しうるが、単一オーナー運用のため許容する
 * （この値と同名のカテゴリを作ると 未分類 ビューに隠れる、という限定）。
 * null/空文字は「すべて」（フィルタ無し）で、これとは別。
 */
export const UNCATEGORIZED = "__uncategorized__";

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

// カテゴリ指定時の JOIN 版。hit_axis→interest_axes を LEFT JOIN して category を引く。
// ENTRIES と COUNT に同一の FROM/JOIN/WHERE 述語を適用する — 不一致は offset 破綻・
// 空ページの原因になる（最重要）。FROM/JOIN は 1 つの共有定数に集約し、片方だけ
// 書き換わって発散する余地を消す（列は非フィルタ版と同一で EntryRow を満たす）。
const FILTERED_FROM_JOIN =
  "FROM feed_entries fe JOIN articles a ON a.id = fe.article_id " +
  "LEFT JOIN interest_axes ax ON ax.axis_id = a.hit_axis";

const ENTRIES_SQL_FILTERED_HEAD =
  "SELECT fe.id AS feed_entry_id, fe.rank AS rank, s.text AS summary, " +
  "a.title AS title, a.source AS source, a.published_at AS published_at, " +
  "a.url AS url, a.hit_axis AS hit_axis, av.vote AS vote " +
  FILTERED_FROM_JOIN +
  " LEFT JOIN summaries s ON s.article_id = fe.article_id " +
  "LEFT JOIN article_vote av ON av.article_id = fe.article_id " +
  "WHERE fe.date = ? ";
const ENTRIES_SQL_FILTERED_TAIL = " ORDER BY fe.rank LIMIT ? OFFSET ?";

const COUNT_SQL_FILTERED_HEAD =
  "SELECT COUNT(*) AS total " + FILTERED_FROM_JOIN + " WHERE fe.date = ? ";

const TRENDS_SQL_FILTERED_HEAD =
  "SELECT ft.axis_id AS axis_id, ft.hit_count AS hit_count, " +
  "ft.narrative AS narrative FROM feed_trends ft " +
  "LEFT JOIN interest_axes ax ON ax.axis_id = ft.axis_id " +
  "WHERE ft.date = ? ";
const TRENDS_SQL_FILTERED_TAIL = " ORDER BY ft.hit_count DESC";

/** フィルタのモード。named はカテゴリ名で、uncat は未分類（category IS NULL）で絞る。 */
type CategoryFilter =
  | { mode: "all" }
  | { mode: "named"; category: string }
  | { mode: "uncat" };

/**
 * `?category` の生値をフィルタへ解釈する。null/空文字は「すべて」（現行挙動）、
 * センチネルは「未分類」、それ以外はカテゴリ名として扱う。
 */
function parseCategoryFilter(category: string | null): CategoryFilter {
  if (category === null || category === "") return { mode: "all" };
  if (category === UNCATEGORIZED) return { mode: "uncat" };
  return { mode: "named", category };
}

/**
 * カテゴリ絞り込みの WHERE 追加述語。ENTRIES と COUNT の両方が共有し、両者の述語一致
 * （offset 整合の要）をこの 1 箇所で保証する。trends は hit_axis 列が無いので別述語。
 */
function entriesPredicate(filter: CategoryFilter): string {
  return filter.mode === "named"
    ? "AND ax.category = ?"
    : "AND (a.hit_axis IS NULL OR ax.category IS NULL)";
}

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
  pageHref: (page: number) => string,
): string {
  const prev =
    current > 1
      ? `<a href="${pageHref(current - 1)}">前へ</a>`
      : `<span class="disabled">前へ</span>`;
  const next =
    current < totalPages
      ? `<a href="${pageHref(current + 1)}">次へ</a>`
      : `<span class="disabled">次へ</span>`;
  const status = `<span class="meta">${current} / ${totalPages}（全${total}件）</span>`;
  return `<nav class="pagination">${prev} ${status} ${next}</nav>`;
}

/**
 * カテゴリ切替ナビ。[すべて]・各カテゴリ(distinct)・[未分類] を素のリンクで並べ、
 * 現在の選択だけはリンクにせず `<strong>` で現在地を示す（JS 不要）。
 * href の値は encodeURIComponent、表示ラベルは escapeHtml でエスケープする。
 */
function renderCategoryNav(
  categories: string[],
  filter: CategoryFilter,
): string {
  const item = (label: string, href: string, active: boolean): string =>
    active
      ? `<strong>${escapeHtml(label)}</strong>`
      : `<a href="${href}">${escapeHtml(label)}</a>`;

  const parts = [item("すべて", "/", filter.mode === "all")];
  for (const c of categories) {
    parts.push(
      item(
        c,
        `/?category=${encodeURIComponent(c)}`,
        filter.mode === "named" && filter.category === c,
      ),
    );
  }
  parts.push(
    item("未分類", `/?category=${UNCATEGORIZED}`, filter.mode === "uncat"),
  );
  return `<nav class="categories">${parts.join(" ")}</nav>`;
}

/** ページネーション/ナビ用に現在のカテゴリを保持する page href を作る。 */
function pageHrefFor(filter: CategoryFilter): (page: number) => string {
  if (filter.mode === "all") return (p) => `/?page=${p}`;
  if (filter.mode === "named") {
    const c = encodeURIComponent(filter.category);
    return (p) => `/?category=${c}&page=${p}`;
  }
  return (p) => `/?category=${UNCATEGORIZED}&page=${p}`;
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

/**
 * 最新フィードを 1 ページ分レンダリングする。page は範囲外を 1..総ページ数 に丸める。
 * `category` は `?category` の生値: null/空は「すべて」（現行 SQL を変えない）、
 * センチネルは「未分類」、それ以外はカテゴリ名で単一選択フィルタする。
 */
export async function renderFeedPage(
  env: Env,
  pageNumber: number,
  category: string | null = null,
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
  // ナビ用のカテゴリ集合（distinct）。追加クエリ不要で loadConfig から取る。
  const categories = [
    ...new Set(
      config.interestAxes
        .map((a) => a.category)
        .filter((c): c is string => c != null && c !== ""),
    ),
  ];

  const filter = parseCategoryFilter(category);

  const trendRows =
    (await buildTrendsStmt(env, date, filter).all<TrendRow>()).results ?? [];

  const countRow = await buildCountStmt(env, date, filter).first<{
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
      await buildEntriesStmt(env, date, filter, offset).all<EntryRow>()
    ).results ?? [];

  const list = entries.map((e) => renderEntry(e, labels)).join("");

  const body =
    `<h1>フィード <span class="meta">${escapeHtml(date)}</span></h1>` +
    `<p><a href="/settings">設定</a></p>` +
    renderCategoryNav(categories, filter) +
    renderTrends(trendRows, labels) +
    `<h2>記事</h2><ul class="entries">${list}</ul>` +
    renderPagination(current, totalPages, total, pageHrefFor(filter)) +
    `<style>${FEEDBACK_STYLE}</style>` +
    `<script>${FEEDBACK_SCRIPT}</script>`;

  return htmlResponse(page("フィード", body));
}

/** entries クエリを組む。all は現行 SQL のまま、フィルタ時のみ JOIN 版に分岐する。 */
function buildEntriesStmt(
  env: Env,
  date: string,
  filter: CategoryFilter,
  offset: number,
): D1PreparedStatement {
  if (filter.mode === "all") {
    return env.DB.prepare(ENTRIES_SQL).bind(date, PAGE_SIZE, offset);
  }
  const sql =
    ENTRIES_SQL_FILTERED_HEAD +
    entriesPredicate(filter) +
    ENTRIES_SQL_FILTERED_TAIL;
  return filter.mode === "named"
    ? env.DB.prepare(sql).bind(date, filter.category, PAGE_SIZE, offset)
    : env.DB.prepare(sql).bind(date, PAGE_SIZE, offset);
}

/** COUNT クエリを組む。entries と同一の JOIN/WHERE 述語で数える（offset 整合の要）。 */
function buildCountStmt(
  env: Env,
  date: string,
  filter: CategoryFilter,
): D1PreparedStatement {
  if (filter.mode === "all") {
    return env.DB.prepare(COUNT_SQL).bind(date);
  }
  const sql = COUNT_SQL_FILTERED_HEAD + entriesPredicate(filter);
  return filter.mode === "named"
    ? env.DB.prepare(sql).bind(date, filter.category)
    : env.DB.prepare(sql).bind(date);
}

/** trends クエリを組む。フィルタ時は feed_trends を軸の category で絞る。 */
function buildTrendsStmt(
  env: Env,
  date: string,
  filter: CategoryFilter,
): D1PreparedStatement {
  if (filter.mode === "all") {
    return env.DB.prepare(TRENDS_SQL).bind(date);
  }
  const predicate =
    filter.mode === "named" ? "AND ax.category = ?" : "AND ax.category IS NULL";
  const sql =
    TRENDS_SQL_FILTERED_HEAD + predicate + TRENDS_SQL_FILTERED_TAIL;
  return filter.mode === "named"
    ? env.DB.prepare(sql).bind(date, filter.category)
    : env.DB.prepare(sql).bind(date);
}
