/**
 * Viewer 共通の HTML レンダリング基盤。
 *
 * フィード表示と設定画面が共有する: HTML エスケープ・ページ骨格・Response 生成。
 * CSS フレームワークは使わず、システムフォント + シングルカラムの最小 CSS のみ。
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
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.6;
  max-width: 720px; margin: 0 auto; padding: 1rem; }
h1 { font-size: 1.4rem; }
h2 { font-size: 1.15rem; margin-top: 1.5rem; }
ul { list-style: none; padding: 0; }
li { margin: 1rem 0; padding-bottom: 1rem; border-bottom: 1px solid #8884; }
a { color: inherit; }
button { min-height: 44px; min-width: 44px; font-size: 1rem;
  padding: 0.4rem 0.9rem; margin-right: 0.5rem; cursor: pointer; }
input, textarea, select { font-size: 1rem; width: 100%; padding: 0.5rem; }
label { display: block; margin: 0.5rem 0 0.2rem; font-weight: bold; }
.meta { font-size: 0.85rem; opacity: 0.8; }
.note { font-size: 0.85rem; opacity: 0.8; background: #8881; padding: 0.5rem; }
.error { color: #c00; font-weight: bold; }
.rank { font-weight: bold; margin-right: 0.3rem; }
fieldset { margin: 1rem 0; }
.summary { margin: 0.6rem 0; }
.summary-section { margin: 0.5rem 0; }
.summary-section h4 { font-size: 0.8rem; margin: 0 0 0.15rem; opacity: 0.7;
  font-weight: bold; letter-spacing: 0.02em; }
.summary-section p { margin: 0; }
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
