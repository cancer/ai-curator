import { describe, expect, test } from "bun:test";
import { normalizeUrl } from "./normalize";

describe("normalizeUrl", () => {
  test("utm_* パラメータを除去する", () => {
    expect(normalizeUrl("https://example.com/a?utm_source=x&utm_medium=y")).toBe(
      "https://example.com/a",
    );
  });

  test("Medium の source パラメータを除去する", () => {
    expect(
      normalizeUrl(
        "https://medium.com/p/abc123?source=rss------software_architecture-5",
      ),
    ).toBe("https://medium.com/p/abc123");
  });

  test("意味のあるクエリパラメータは保持する", () => {
    expect(normalizeUrl("https://news.ycombinator.com/item?id=48799929")).toBe(
      "https://news.ycombinator.com/item?id=48799929",
    );
  });

  test("フラグメントを除去する", () => {
    expect(normalizeUrl("https://example.com/a#section")).toBe(
      "https://example.com/a",
    );
  });

  test("正規化済み URL は変化しない", () => {
    expect(normalizeUrl("https://example.com/a")).toBe("https://example.com/a");
  });

  test("不正な URL は例外を投げる", () => {
    expect(() => normalizeUrl("not-a-url")).toThrow();
  });
});
