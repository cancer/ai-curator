import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

// テストは2つのランタイムに分ける。振り分けはファイル名のサフィックス規約で行う
// (手管理のファイルリストは持たない)。
//
// `*.integration.test.ts` は workerd(Workers ランタイム)上で走らせる。これらは worker を
// 起動するか `cloudflare:workers` を import するため Node では動かない:
//  - src/index.integration.test.ts:
//      fetch handler。index.ts → workflow.ts → `cloudflare:workers` を import する。
//  - src/pipeline/workflow.integration.test.ts:
//      `cloudflare:workers` の WorkflowEntrypoint に依存する。
//  - test/index.integration.test.ts:
//      `cloudflare:test` の SELF で worker を起動して fetch する統合スモーク。
//
// workerd 起動は遅く、wrangler 設定に依存する(本番 wrangler.jsonc の `ai` binding は
// リモート接続を要求し詰まる)。それ以外のテストは自分たちのロジックだけを検証すればよく、
// プラットフォーム(HTMLRewriter 等の Workers 組込み API)の挙動はテストしない=信頼するので、
// 素の Node 環境で回す。workerd 側は本番 binding 不要のため wrangler.test.jsonc を使う。
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts", "test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
        },
      },
      {
        plugins: [
          cloudflareTest({ wrangler: { configPath: "./wrangler.test.jsonc" } }),
        ],
        test: {
          name: "workerd",
          include: ["**/*.integration.test.ts"],
        },
      },
    ],
  },
});
