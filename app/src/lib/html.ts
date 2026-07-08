/**
 * HTML から本文テキストを抽出する。
 *
 * 実装は Workers ランタイム組込みの HTMLRewriter を使う。HTMLRewriter の
 * transform は非同期でストリームを流し切って初めて全ハンドラが発火するため、
 * htmlToText は async で、収集結果を返す前に body を await ...text() で読み切る。
 *
 * HTMLRewriter の癖への対処:
 * - 除外は el.remove() ではなくカウンタ方式で行う。remove しても別セレクタの
 *   text ハンドラは除去済み要素の中身でも発火するため。除外要素で skipDepth を
 *   増やし onEndTag で戻し、text は skipDepth === 0 のときだけ収集する。root も
 *   同じくカウンタで内側だけ収集する。
 * - ブロック要素間には空白が入らない（<h1>A</h1><p>B</p> が "AB" になる）。
 *   ブロック要素の element ハンドラで区切り空白を push して補う。
 * - text ノードの HTML エンティティはデコードされないので収集後にデコードする。
 *
 * 注意: root / exclude に void 要素（img, br, hr 等）のセレクタを渡してはならない。
 * void 要素は onEndTag が発火せずカウンタが戻らないため、以降のテキストが
 * 黙って欠落する。
 */

export interface HtmlToTextOptions {
  /** このセレクタの内側だけ収集する（未指定なら全体） */
  root?: string;
  /** このセレクタのサブツリーは収集しない */
  exclude?: string[];
}

// 直後・直前に区切り空白を必要とするブロック要素。
const BLOCK_ELEMENTS = [
  "p",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "br",
  "tr",
  "td",
  "th",
  "blockquote",
  "pre",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "nav",
  "aside",
];

const NAMED_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&hellip;": "…",
  "&lsquo;": "‘",
  "&rsquo;": "’",
  "&ldquo;": "“",
  "&rdquo;": "”",
};

function decodeEntities(text: string): string {
  let result = text;
  for (const [entity, char] of Object.entries(NAMED_ENTITIES)) {
    result = result.replaceAll(entity, char);
  }
  result = result.replace(/&#(\d+);/g, (_m, code) =>
    String.fromCodePoint(parseInt(code, 10)),
  );
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_m, code) =>
    String.fromCodePoint(parseInt(code, 16)),
  );
  return result;
}

export async function htmlToText(
  html: string,
  options?: HtmlToTextOptions,
): Promise<string> {
  const rootSelector = options?.root;
  const excludeSelectors = [...(options?.exclude ?? []), "script", "style"];

  const parts: string[] = [];
  let skipDepth = 0;
  let rootDepth = 0;

  const collecting = () =>
    skipDepth === 0 && (rootSelector === undefined || rootDepth > 0);

  let rewriter = new HTMLRewriter();

  // 除外セレクタは登録順に先に処理されるので、除外要素配下では以降の
  // ブロック空白・text 収集が skipDepth > 0 で抑止される。
  for (const selector of excludeSelectors) {
    rewriter = rewriter.on(selector, {
      element(el) {
        skipDepth++;
        el.onEndTag(() => {
          skipDepth--;
        });
      },
    });
  }

  if (rootSelector !== undefined) {
    rewriter = rewriter.on(rootSelector, {
      element(el) {
        rootDepth++;
        el.onEndTag(() => {
          rootDepth--;
        });
      },
    });
  }

  rewriter = rewriter.on(BLOCK_ELEMENTS.join(","), {
    element() {
      if (collecting()) {
        parts.push(" ");
      }
    },
  });

  rewriter = rewriter.on("*", {
    text(chunk) {
      if (collecting()) {
        parts.push(chunk.text);
      }
    },
  });

  await rewriter.transform(new Response(html)).text();

  return decodeEntities(parts.join("")).replace(/\s+/g, " ").trim();
}
