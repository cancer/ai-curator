import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { configDefaults, defineConfig } from "vitest/config";

// テストは2つのランタイムに分ける。
//
// workerd(Workers ランタイム)上で走らせるのは、Workers 固有の機能に依存し
// Node では動かないテストだけに限定する。理由:
//  - src/lib/html.test.ts / src/adapters/feed.test.ts:
//      本文抽出が組込みの HTMLRewriter を使う。HTMLRewriter は Node に存在しない
//      (src/lib/html.ts:114)。本物のまま検証したいので workerd で動かす。
//  - src/index.test.ts / src/pipeline/workflow.test.ts:
//      `cloudflare:workers` (WorkflowEntrypoint) を import するため Node では読めない。
//  - test/index.test.ts:
//      `cloudflare:test` の SELF で worker を起動して fetch する統合スモーク。
//
// workerd 起動は遅く、wrangler 設定に依存する(本番 wrangler.jsonc の `ai` binding は
// リモート接続を要求し詰まる)コストがある。上記以外のテストはそのコストを払う理由が
// ないので Node 環境で回す。workerd 側は本番 binding 不要のため wrangler.test.jsonc を使う。
const WORKERD_TESTS = [
  "src/lib/html.test.ts",
  "src/adapters/feed.test.ts",
  "src/index.test.ts",
  "src/pipeline/workflow.test.ts",
  "test/index.test.ts",
];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts", "test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, ...WORKERD_TESTS],
        },
      },
      {
        plugins: [
          cloudflareTest({ wrangler: { configPath: "./wrangler.test.jsonc" } }),
        ],
        test: {
          name: "workerd",
          include: WORKERD_TESTS,
        },
      },
    ],
  },
});
