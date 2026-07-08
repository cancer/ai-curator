/**
 * AI curator 実運用 v1 — 単一 Worker のエントリポイント。
 *
 * - scheduled: cron 1本(日次パス: 取得〜要約を単一パスで実行)
 * - fetch: Viewer(閲覧・設定・フィードバック収集)
 */

import { runDaily } from "./pipeline/daily";
import { renderFeedPage } from "./viewer/index";
import { renderSettingsForm, handleSettingsUpdate } from "./viewer/settings";
import { handleClickRedirect, handleFeedbackApi } from "./viewer/feedback";

/** バインディング。後続タスクは `import type { Env } from "./index"` で参照する。 */
export interface Env {
  AI: Ai;
  DB: D1Database;
  CONFIG: KVNamespace;
}

export default {
  async scheduled(_controller, env, _ctx) {
    // cron は 1 本なので分岐しない。取得〜要約を単一パスで実行する。
    await runDaily(env);
  },

  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const { method } = request;

    if (method === "GET" && pathname === "/") {
      const page = Number(url.searchParams.get("page") ?? "1");
      return renderFeedPage(env, page);
    }
    if (method === "GET" && pathname === "/settings") {
      return renderSettingsForm(env);
    }
    if (method === "POST" && pathname === "/settings") {
      return handleSettingsUpdate(env, request);
    }
    if (method === "GET" && pathname.startsWith("/r/")) {
      return handleClickRedirect(env, pathname.slice("/r/".length));
    }
    if (method === "POST" && pathname === "/api/feedback") {
      return handleFeedbackApi(env, request);
    }

    return new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
