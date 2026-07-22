/**
 * Viewer 共通の HTML レンダリング基盤。
 *
 * フィード表示と設定画面が共有する: HTML エスケープ・ページ骨格・Response 生成。
 * 見た目は DESIGN.md（Personal Design System）のダークテーマに揃える。CSS フレームワーク
 * は使わず、DESIGN.md のトークン（OKLCH スケール→役割→component）をこの STYLE 1 枚へ写し、
 * マークアップ側はクラス名だけで参照する（インライン style を書かない = 反復・保守性）。
 * 利用は主にスマホのため viewport メタタグとタップ可能なボタンサイズ(44px)を確保する。
 */

/**
 * HTML エスケープ。テキストと二重/単一引用符の属性値の両方で安全になるよう
 * `& < > " '` をすべて実体参照へ変換する（`href="..."` へ入れても属性を破れない）。
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `
/* === Design tokens（DESIGN.md の primitive→役割→component をダークで解決した値）=== */
:root {
  color-scheme: dark;
  --gray-50:oklch(.985 .004 270);--gray-100:oklch(.965 .004 270);--gray-200:oklch(.925 .004 270);--gray-300:oklch(.87 .004 270);--gray-400:oklch(.79 .004 270);--gray-500:oklch(.68 .004 270);--gray-600:oklch(.585 .004 270);--gray-700:oklch(.49 .004 270);--gray-800:oklch(.395 .004 270);--gray-900:oklch(.3 .004 270);--gray-950:oklch(.21 .004 270);
  --blue-200:oklch(.925 .0351 264);--blue-300:oklch(.87 .0621 264);--blue-400:oklch(.79 .1036 264);--blue-500:oklch(.68 .1648 264);--blue-900:oklch(.3 .0884 264);--blue-950:oklch(.21 .0612 264);
  --green-500:oklch(.68 .15 150);
  --red-200:oklch(.925 .0373 25);--red-800:oklch(.395 .133 25);--red-950:oklch(.21 .0684 25);
  /* screen 役割（dark） */
  --text:var(--gray-50);--muted:var(--gray-400);--bg:var(--gray-950);
  --surface:var(--gray-900);--surface-2:var(--gray-800);--border:var(--gray-700);--accent:var(--blue-500);
  --radius-sm:.25rem;--radius-md:.5rem;--radius-lg:.75rem;--radius-full:9999px;
  --shadow-sm:0 1px 2px rgb(0 0 0/.28);--shadow-md:0 4px 12px rgb(0 0 0/.4);
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--bg); color: var(--text); line-height: 1.6;
  font-family: system-ui, -apple-system, sans-serif; -webkit-font-smoothing: antialiased;
  padding: 0 1.25rem 4rem; }
a { color: var(--blue-500); text-decoration: underline; text-underline-offset: 2px; }
a:hover { color: var(--blue-400); }
::selection { background: var(--blue-900); }
svg { flex: none; }

/* コンテナ幅。フィードは広め、設定・空状態は狭め。 */
.wrap { max-width: 860px; margin: 0 auto; }
.wrap-narrow { max-width: 680px; margin: 0 auto; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

/* === タイポグラフィ（DESIGN.md typography）=== */
h1 { font-size: 2.441rem; font-weight: 700; line-height: 1.2; letter-spacing: -0.02em; margin: 0; }
h2 { font-size: 1.563rem; font-weight: 500; line-height: 1.3; margin: 0; }
.meta { font-size: 0.75rem; color: var(--muted); }
.mono { font-family: ui-monospace, monospace; }

/* === 汎用ボタン/リンクボタン === */
button { font-size: 1rem; cursor: pointer; font-family: inherit; }
.btn-neutral { display: inline-flex; align-items: center; gap: .45rem;
  padding: .5rem .9rem; background: var(--surface-2); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--radius-md);
  text-decoration: none; font-size: .875rem; font-weight: 500; min-height: 44px; }
.btn-neutral:hover { color: var(--text); background: var(--gray-700); }
.btn-primary { display: inline-flex; align-items: center; gap: .5rem;
  padding: .5rem 1.5rem; background: var(--accent); color: var(--gray-950);
  border: none; border-radius: var(--radius-md); text-decoration: none;
  font-size: .875rem; font-weight: 500; min-height: 44px; }
.btn-primary:hover { color: var(--gray-950); background: var(--blue-400); }

/* === フィード: ヘッダ === */
.feed-header { display: flex; align-items: flex-end; justify-content: space-between;
  gap: 1rem; flex-wrap: wrap; padding: 2rem 0 1.25rem; }
.feed-date { display: inline-flex; align-items: center; gap: .5rem; color: var(--muted);
  font-size: .75rem; letter-spacing: .04em; font-family: ui-monospace, monospace; }

/* === フィード: トレンド（傾向サマリ）=== */
.trends { margin: 0 0 2rem; }
.trends-head { display: flex; align-items: center; gap: .45rem; margin-bottom: .7rem; color: var(--muted); }
.trends-head span { font-size: .7rem; font-weight: 500; letter-spacing: .06em; }
.trends-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
  gap: .75rem 1.5rem; }
.trend-top { display: flex; align-items: baseline; gap: .4rem; margin-bottom: .1rem; }
.trend-top strong { font-size: .85rem; font-weight: 600; color: var(--gray-200); }
.trend-count { font-size: .7rem; color: var(--muted); font-family: ui-monospace, monospace; }
.trend-narr { margin: 0; font-size: .75rem; line-height: 1.5; color: var(--muted); text-wrap: pretty; }

/* === フィード: フィルタ（カテゴリ pill + body/gate セグメント）=== */
.controls { display: flex; align-items: center; justify-content: space-between;
  gap: 1rem 1.25rem; flex-wrap: wrap; margin-bottom: 1.75rem; }
.categories { display: flex; gap: .25rem; flex-wrap: wrap; }
.categories a, .categories strong { padding: .4rem .9rem; border-radius: var(--radius-full);
  font-size: .9rem; text-decoration: none; font-weight: 500; }
.categories a { color: var(--muted); }
.categories a:hover { color: var(--text); background: var(--surface); }
.categories strong { background: var(--surface-2); color: var(--text); font-weight: 600; }
.bodies, .gates { display: inline-flex; background: var(--bg); border: 1px solid var(--border);
  border-radius: var(--radius-md); padding: 2px; }
.bodies a, .bodies strong, .gates a, .gates strong {
  text-align: center; white-space: nowrap; padding: .4rem .75rem;
  border-radius: calc(var(--radius-md) - 2px); font-size: .8rem; font-weight: 500;
  text-decoration: none; }
.bodies a, .gates a { color: var(--muted); }
.bodies a:hover, .gates a:hover { color: var(--text); }
.bodies strong, .gates strong { background: var(--accent); color: var(--gray-950); }

/* === フィード: 記事カード === */
.entries { display: flex; flex-direction: column; }
.entry { padding: 2rem 0; }
.entry + .entry { border-top: 1px solid var(--border); }
.entry-meta { display: flex; align-items: center; gap: .55rem; flex-wrap: wrap;
  font-size: .75rem; color: var(--muted); margin-bottom: .5rem; }
.entry-meta .src { font-weight: 500; color: var(--gray-300); }
.entry-meta .date { font-family: ui-monospace, monospace; font-size: .72rem; }
.rank { display: inline-flex; align-items: center; justify-content: center;
  padding: .05rem .4rem; background: var(--surface-2); color: var(--gray-300);
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  font-family: ui-monospace, monospace; font-size: .72rem; font-weight: 700; }
.rank-top { background: var(--blue-950); color: var(--blue-200); border-color: var(--accent); }
.axis { display: inline-flex; align-items: center; padding: .05rem .5rem;
  background: var(--surface-2); color: var(--gray-200); border-radius: var(--radius-sm);
  font-size: .7rem; letter-spacing: .02em; }
.entry-title { display: block; font-size: 1.15rem; font-weight: 700; line-height: 1.4;
  letter-spacing: -0.01em; color: var(--text); text-decoration: none; }
.entry-title:hover { color: var(--blue-300); }
.no-summary { margin: .7rem 0 0; font-size: .8rem; color: var(--muted); }

/* === フィード: 記事要約（4 セクション。DESIGN.md の階層で強弱付け）=== */
.summary { margin-top: 1.5rem; display: flex; flex-direction: column; gap: .85rem; }
.summary-section h4 { margin: 0 0 .2rem; font-size: .7rem; font-weight: 500;
  letter-spacing: .04em; color: var(--muted); }
.summary-section p { margin: 0; font-size: 1rem; line-height: 1.7;
  color: var(--gray-100); text-wrap: pretty; }
.section-audience { display: flex; gap: .6rem; align-items: baseline; }
.section-audience h4 { flex: none; align-self: flex-start; margin: 0;
  padding: .1rem .5rem; background: var(--blue-950); color: var(--blue-200);
  border-radius: var(--radius-sm); letter-spacing: .03em; }
.section-background { border-left: 2px solid var(--border); padding-left: .9rem; }
.section-overview p { font-size: 1.0625rem; line-height: 1.8; color: var(--gray-50); }
.section-claims { border-left: 2px solid var(--accent); padding-left: .9rem; }
.section-claims h4 { color: var(--blue-300); }
.section-conclusion { border-left: 2px solid var(--border); padding-left: .9rem; }

/* === フィード: 投票 + 出典 === */
.entry-actions { display: flex; align-items: center; gap: .5rem; margin-top: 1.5rem; }
.vote { display: inline-flex; align-items: center; justify-content: center;
  min-width: 44px; min-height: 40px; background: transparent; color: var(--muted);
  border: 1px solid var(--border); border-radius: var(--radius-md); }
.vote:hover { color: var(--text); }
.vote[aria-pressed="true"] { background: var(--blue-950); color: var(--blue-200);
  border-color: var(--accent); }
.src-url { margin-left: auto; display: inline-flex; align-items: center; gap: .35rem;
  max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: .75rem; color: var(--muted); text-decoration: none;
  font-family: ui-monospace, monospace; }
.src-url:hover { color: var(--text); }

/* === フィード: ページネーション === */
.pagination { display: flex; align-items: center; justify-content: center; gap: 1rem; margin-top: 1.75rem; }
.pagination a, .pagination .disabled { display: inline-flex; align-items: center;
  padding: .5rem .9rem; border: 1px solid var(--border); border-radius: var(--radius-md);
  font-size: .875rem; font-weight: 500; text-decoration: none; }
.pagination a { background: var(--surface-2); color: var(--text); }
.pagination a:hover { background: var(--gray-700); color: var(--text); }
.pagination .disabled { color: var(--gray-600); cursor: not-allowed; }

/* === 空状態 === */
.empty { margin-top: 2rem; padding: 3.5rem 2rem; text-align: center;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); }
.empty-icon { display: inline-flex; align-items: center; justify-content: center;
  width: 3.5rem; height: 3.5rem; border-radius: var(--radius-full);
  background: var(--surface-2); color: var(--muted); margin-bottom: 1rem; }
.empty h2 { font-size: 1.25rem; font-weight: 700; margin: 0 0 .5rem; }
.empty p { margin: 0 0 1.5rem; color: var(--muted); font-size: .875rem; line-height: 1.6; }
.no-entries { padding: 2.5rem 1.5rem; text-align: center; color: var(--muted);
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-md); font-size: .875rem; }

/* === 設定 === */
.back-link { display: inline-flex; align-items: center; gap: .35rem; font-size: .8rem;
  color: var(--muted); text-decoration: none; margin-bottom: .75rem; }
.settings-header { padding: 2rem 0 1rem; }
.section { margin-bottom: 2.5rem; }
.section-head { display: flex; align-items: center; justify-content: space-between;
  gap: 1rem; flex-wrap: wrap; margin-bottom: .4rem; }
.section-note { margin: 0 0 1.1rem; color: var(--muted); font-size: .875rem; line-height: 1.6; }
label { display: block; font-size: .7rem; font-weight: 500; color: var(--muted); margin: 0 0 .3rem; }
input, textarea { width: 100%; background: var(--surface); border: 1px solid var(--border);
  color: var(--text); border-radius: var(--radius-sm); padding: .55rem .75rem;
  font-size: 1rem; font-family: inherit; line-height: 1.6; }
textarea { resize: vertical; }
input:hover, textarea:hover { border-color: var(--gray-600); }
input.mono, textarea.mono { font-family: ui-monospace, monospace; font-size: .875rem; }
fieldset { margin: 0 0 .85rem; padding: 0; border: 0; }
.add-block { margin-top: 1.25rem; padding-top: 1.25rem; border-top: 1px dashed var(--border); }
.add-block-label { font-size: .7rem; font-weight: 500; letter-spacing: .04em;
  color: var(--muted); margin-bottom: .55rem; }
.field-delete { display: inline-flex; align-items: center; gap: .4rem; margin: .4rem 0 0;
  font-size: .8rem; color: var(--muted); font-weight: 400; }
.field-delete input { width: auto; }
.note { font-size: .875rem; color: var(--gray-100);
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-md); padding: .75rem 1rem; margin: 0 0 1.5rem; }
.note a { color: var(--blue-500); }
.error { margin: 0 0 1.5rem; background: var(--red-950); border: 1px solid var(--red-800);
  color: var(--red-200); border-radius: var(--radius-md); padding: .75rem 1rem;
  font-size: .875rem; list-style: none; }
.error li { margin-left: 1.4rem; list-style: disc; }
.scoring { margin: 0; display: grid; grid-template-columns: 1fr auto; gap: .5rem 1rem;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-md); padding: 1rem 1.25rem; font-size: .875rem; list-style: none; }
.scoring dt { color: var(--muted); }
.scoring dd { margin: 0; font-family: ui-monospace, monospace; text-align: right; }
.scoring li { display: contents; }

/* === フィード: フィルタ ポップオーバー（<details> による開閉）=== */
.filter { position: relative; flex: none; }
.filter > summary { list-style: none; display: inline-flex; align-items: center;
  justify-content: center; width: 40px; height: 40px; border-radius: var(--radius-md);
  background: transparent; color: var(--muted); cursor: pointer; }
.filter > summary::-webkit-details-marker { display: none; }
.filter > summary:hover { color: var(--text); }
.filter[open] > summary { background: var(--surface-2); color: var(--blue-200); }
.filter-dot { position: absolute; top: 4px; right: 4px; width: 7px; height: 7px;
  border-radius: var(--radius-full); background: var(--accent); border: 1.5px solid var(--bg); }
.filter-panel { position: absolute; top: calc(100% + .5rem); right: 0; z-index: 10;
  min-width: 230px; background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-md); box-shadow: var(--shadow-md); padding: 1rem;
  display: flex; flex-direction: column; gap: 1rem; }
.filter-group { display: flex; flex-direction: column; gap: .5rem; }
.filter-group > span { font-size: .72rem; color: var(--muted); font-weight: 500; }
.filter-panel .bodies, .filter-panel .gates { display: flex; }
.filter-panel .bodies a, .filter-panel .bodies strong,
.filter-panel .gates a, .filter-panel .gates strong { flex: 1 1 0; }

/* === 設定: 行（追加/削除できる動的行）=== */
.row { display: flex; gap: .6rem; align-items: flex-end; margin-bottom: .6rem; }
.row > .field { flex: 1 1 0; min-width: 0; }
.axis-row > .field:first-of-type { flex: 2 1 0; }
.feed-row { align-items: center; }
.btn-icon { flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 44px; height: 42px; background: transparent; color: var(--muted);
  border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; }
.btn-icon:hover { background: var(--red-950); border-color: var(--red-800); color: var(--red-200); }
.btn-add { flex: none; display: inline-flex; align-items: center; gap: .3rem; height: 42px;
  padding: 0 1rem; background: var(--surface-2); color: var(--text); border: 1px solid var(--border);
  border-radius: var(--radius-sm); font-size: .875rem; font-weight: 500; cursor: pointer; }
.btn-add:hover { background: var(--gray-700); }
.add-row { display: flex; gap: .6rem; align-items: flex-end; }
.add-row > .field { flex: 1 1 0; min-width: 0; }
.add-row > .field:first-of-type { flex: 2 1 0; }
.autosave { display: inline-flex; align-items: center; gap: .35rem; font-size: .72rem; color: var(--muted); }
.autosave[data-state="saving"] { color: var(--blue-300); }
.autosave[data-state="saved"] { color: var(--green-500); }
.autosave[data-state="error"] { color: var(--red-200); }
`;

/** HTML 文書の骨格を組み立てる。title はエスケープ済みで挿入する。 */
export function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
}

/** HTML レスポンスを生成する（charset 明示）。 */
export function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
