import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// scaffold の smoke テスト: worker が起動し fetch ハンドラが配線済みで
// あることを確認する。DB/KV を必要としない未知パスの 404 で検証する
// (200 を返す経路は D1/KV に依存するため、ルーティングの網羅は
//  src/index.test.ts / src/viewer/*.test.ts のフェイク注入テストで行う)。
describe("ai-curator worker", () => {
  it("fetch ハンドラが未知パスに 404 を返す", async () => {
    const res = await SELF.fetch("http://example.com/nope");
    expect(res.status).toBe(404);
  });
});
