/**
 * HTML からプレーンテキストを抽出する。bun / Cloudflare Workers 共通の
 * HTMLRewriter（ストリーミングパーサ）で実装し、実運用の Workers にそのまま持ち込める。
 *
 * HTMLRewriter の癖への対処（bun 1.1.22 で実測）:
 *  1. el.remove() しても他ハンドラの text は除去済み要素の中身でも発火するため、
 *     除外サブツリーは skipDepth カウンタで収集をスキップする。
 *  2. ブロック要素間に空白が挿入されない（"<h1>x</h1><p>y</p>" → "xy"）ため、
 *     ブロック要素の開始で区切りの空白を挿入する。
 *  3. text ノードのエンティティはデコードされないため（"&amp;" のまま）、
 *     収集後に decodeEntities でデコードする。
 */

/** 区切り空白を挿入するブロックレベル要素。インライン要素は語を分割しないよう対象外。 */
const BLOCK_SELECTOR =
  "address,article,aside,blockquote,br,dd,details,div,dl,dt,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,h5,h6,header,hr,li,main,nav,ol,p,pre,section,table,tbody,td,th,thead,tr,ul";

/** text ノードに残る名前付きエンティティのうち、本文に現れる代表的なもの。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
};

const MAX_CODE_POINT = 0x10ffff;

/** HTML エンティティをデコードする。未知のエンティティ・範囲外の数値参照は原文のまま残す。 */
function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g,
    (match, body: string) => {
      if (body[0] === "#") {
        const code =
          body[1] === "x"
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        if (Number.isNaN(code) || code < 0 || code > MAX_CODE_POINT) return match;
        return String.fromCodePoint(code);
      }
      return NAMED_ENTITIES[body] ?? match;
    },
  );
}

export interface HtmlToTextOptions {
  /** このセレクタに一致する要素の内側のテキストだけを収集する（未指定なら文書全体）。 */
  root?: string;
  /** これらのセレクタに一致する要素のサブツリーは収集しない。 */
  exclude?: readonly string[];
}

// root / exclude のセレクタは終了タグを持つ要素にのみ使う。収集範囲は onEndTag で
// カウンタを戻して管理するため、void 要素（img / br / hr 等）に一致させると
// カウンタが戻らず、それ以降のテキストが黙って収集対象から外れる（bun 1.1.22 で実測）。

export function htmlToText(html: string, options: HtmlToTextOptions = {}): string {
  const parts: string[] = [];
  let skipDepth = 0;
  let rootDepth = options.root ? 0 : 1;
  const collecting = () => rootDepth > 0 && skipDepth === 0;

  const rewriter = new HTMLRewriter();

  if (options.root) {
    rewriter.on(options.root, {
      element(el) {
        rootDepth++;
        el.onEndTag(() => {
          rootDepth--;
        });
      },
    });
  }

  const skipSelector = ["script", "style", ...(options.exclude ?? [])].join(",");
  rewriter.on(skipSelector, {
    element(el) {
      skipDepth++;
      el.onEndTag(() => {
        skipDepth--;
      });
    },
  });

  rewriter.on(BLOCK_SELECTOR, {
    element() {
      if (collecting()) parts.push(" ");
    },
  });

  rewriter.on("*", {
    text(chunk) {
      if (collecting()) parts.push(chunk.text);
    },
  });

  rewriter.transform(html);
  return decodeEntities(parts.join("")).replace(/\s+/g, " ").trim();
}

/** selector に一致する要素が html に存在するか。fail-fast なレイアウト検証に使う。 */
export function containsElement(html: string, selector: string): boolean {
  let found = false;
  new HTMLRewriter()
    .on(selector, {
      element() {
        found = true;
      },
    })
    .transform(html);
  return found;
}
