/**
 * AI curator 実運用 v1 — 単一 Worker のエントリポイント。
 *
 * - scheduled: cron 2本(Cron A=fetch / Cron B=feed構築)
 * - fetch: Viewer(閲覧・設定・フィードバック収集)
 *
 * 各パイプラインの実装は後続タスクで配線する。
 */

import { runFetchPipeline } from "./pipeline/fetch";
import { runFeedBuilder } from "./pipeline/feed";

/** バインディング。後続タスクは `import type { Env } from "./index"` で参照する。 */
export interface Env {
  AI: Ai;
  DB: D1Database;
  CONFIG: KVNamespace;
}

/** Cron A: 3時間ごとにソースを fetch する。 */
const CRON_FETCH = "0 */3 * * *";
/** Cron B: 21:00 UTC(朝6時JST)に feed を構築する。 */
const CRON_BUILD_FEED = "0 21 * * *";

export default {
  async scheduled(controller, env, _ctx) {
    switch (controller.cron) {
      case CRON_FETCH:
        await runFetchPipeline(env);
        return;
      case CRON_BUILD_FEED:
        await runFeedBuilder(env);
        return;
    }
  },

  async fetch(_request, _env, _ctx) {
    // TODO: task 9 — Viewer(閲覧・設定画面・フィードバック収集)を実装する
    return new Response("ai-curator: ok", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<Env>;
