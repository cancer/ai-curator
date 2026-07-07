import { describe, expect, test } from "bun:test";
import { containsElement, htmlToText } from "./html";

describe("htmlToText", () => {
  test("タグを除去してテキストだけを返す", () => {
    expect(htmlToText("<p>hello <b>world</b></p>")).toBe("hello world");
  });

  test("script / style の中身は収集しない", () => {
    const html = "<p>keep</p><script>var x=1;</script><style>.a{color:red}</style>";
    expect(htmlToText(html)).toBe("keep");
  });

  test("ブロック要素の境界に区切りを入れ、単語を結合させない", () => {
    expect(htmlToText("<h1>Title</h1><p>body</p>")).toBe("Title body");
  });

  test("インライン要素は語を分割しない", () => {
    expect(htmlToText("<p>click <a>here</a> now</p>")).toBe("click here now");
  });

  test("連続する空白を 1 つに正規化し前後を trim する", () => {
    expect(htmlToText("<p>  a\n\n  b\t c  </p>")).toBe("a b c");
  });

  test("数値文字参照（10進・16進）をデコードする", () => {
    expect(htmlToText("<p>em&#8212;dash</p>")).toBe("em—dash");
    expect(htmlToText("<p>em&#x2014;dash</p>")).toBe("em—dash");
  });

  test("名前付きエンティティ（amp / quot / nbsp）をデコードする", () => {
    expect(htmlToText("<p>a &amp; b</p>")).toBe("a & b");
    expect(htmlToText("<p>&quot;q&quot;</p>")).toBe('"q"');
    expect(htmlToText("<p>x&nbsp;y</p>")).toBe("x y");
  });

  test("未知のエンティティはそのまま残す", () => {
    expect(htmlToText("<p>&unknownent;</p>")).toBe("&unknownent;");
  });

  test("範囲外の数値参照でも例外を投げず原文を残す", () => {
    expect(() => htmlToText("<p>&#x110000;</p>")).not.toThrow();
    expect(htmlToText("<p>&#x110000;</p>")).toBe("&#x110000;");
  });

  test("root 指定時はその要素の内側のテキストだけを収集する", () => {
    const html = "<div>outer<main>inner</main>after</div>";
    expect(htmlToText(html, { root: "main" })).toBe("inner");
  });

  test("exclude 指定時は一致要素のサブツリーを収集しない", () => {
    const html = "<div><p>keep</p><p class='drop'>gone</p></div>";
    expect(htmlToText(html, { exclude: [".drop"] })).toBe("keep");
  });
});

describe("containsElement", () => {
  test("一致する要素があれば true", () => {
    expect(containsElement("<div><main>x</main></div>", "main")).toBe(true);
  });

  test("一致する要素がなければ false", () => {
    expect(containsElement("<div><section>x</section></div>", "main")).toBe(false);
  });
});
