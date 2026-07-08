import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// scaffold の smoke テスト: fetch ハンドラが 200 を返すことだけを確認する。
describe("ai-curator worker", () => {
  it("fetch ハンドラは 200 を返す", async () => {
    const res = await SELF.fetch("http://example.com/");
    expect(res.status).toBe(200);
  });
});
