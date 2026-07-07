import { describe, expect, test } from "bun:test";
import { loadFixture } from "../fixtures";
import { htmlToText } from "../html";
import { extractFowlerBody, parseFowlerFeed } from "./fowler";

const feed = await loadFixture(
  new URL("../../fixtures/fowler_feed.atom", import.meta.url),
);
const article = await loadFixture(
  new URL("../../fixtures/fowler_article.html", import.meta.url),
);

describe("parseFowlerFeed", () => {
  test.skipIf(!feed.exists)("Atom entry を正規化記事に変換する", () => {
    const articles = parseFowlerFeed(feed.text);
    expect(articles.length).toBeGreaterThan(0);
    const first = articles[0]!;
    expect(first.url).toStartWith("https://martinfowler.com/");
    expect(first.title.length).toBeGreaterThan(0);
    expect(first.source).toBe("fowler");
    expect(Date.parse(first.publishedAt)).not.toBeNaN();
    expect(first.feedSummary).toBeDefined();
    expect(first.feedSummary!).not.toContain("<p>");
  });
});

describe("extractFowlerBody", () => {
  test.skipIf(!article.exists)("記事ページの main 要素から本文テキストを抽出する", () => {
    const body = extractFowlerBody(article.text);
    expect(body).toContain("PRINCE");
    expect(body.length).toBeGreaterThan(2000);
    expect(body).not.toContain("<p");
  });

  test.skipIf(!article.exists)("ボイラープレート（タイトル h1・著者・目次）を除去する", () => {
    const body = extractFowlerBody(article.text);
    // h1 のタイトルは本文から除く（NormalizedArticle.title に別途保持されるため）
    expect(body).not.toContain("Building Reliable Agentic AI Systems");
    // 著者略歴は本文ではない
    expect(body).not.toContain("Sarang Kulkarni is a Principal Consultant");
    // 除去により、main 全体を素朴に抽出した場合より短くなる
    const naive = htmlToText(article.text, { root: "main" });
    expect(body.length).toBeLessThan(naive.length);
  });

  test("main 要素がないページは例外を投げる", () => {
    expect(() => extractFowlerBody("<html><body>no main</body></html>")).toThrow();
  });
});
