import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// workerd 上でテストを実行することで、HTMLRewriter などの
// ランタイム組込み API をテストでもそのまま利用できる。
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
});
