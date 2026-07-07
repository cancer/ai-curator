import { describe, expect, test } from "bun:test";
import { extractErrorDetail } from "./ai_client";

describe("extractErrorDetail", () => {
  test("wrangler dev のエラーページ HTML から AiError の本文だけを抜き出す", () => {
    const html = `<!DOCTYPE html><html><body>
      <h2 id="error-message">
        <span><svg><path d="M0 0"/></svg></span>
        <span>3030: Max context reached 61725 tokens but model supports only 60000</span>
      </h2>
    </body></html>`;
    expect(extractErrorDetail(html)).toBe(
      "3030: Max context reached 61725 tokens but model supports only 60000",
    );
  });

  test("該当パターンが無ければ先頭 300 文字にフォールバックする", () => {
    const plain = "x".repeat(400);
    expect(extractErrorDetail(plain)).toBe("x".repeat(300));
  });
});
