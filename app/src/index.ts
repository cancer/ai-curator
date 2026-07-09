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

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const { method } = request;

    if (method === "GET" && pathname === "/") {
      const page = Number(url.searchParams.get("page") ?? "1");
      return renderFeedPage(env, page);
    }
    if (method === "GET" && pathname === "/settings") {
      return renderSettingsForm(env, url.searchParams.get("ran") === "1");
    }
    if (method === "POST" && pathname === "/settings") {
      return handleSettingsUpdate(env, request);
    }
    if (method === "POST" && pathname === "/run") {
      // 日次パスの手動実行（即時確認用）。waitUntil でバックグラウンド起動し、
      // 完了を待たずに戻す。runDaily は全ソース取得＋全件 Embedding＋全件 LLM
      // 要約で長く、リクエストのライフタイム内に同期完了させると Worker の
      // 実行時間・サブリクエスト上限に当たりやすいため。
      // 注意: waitUntil はレスポンス後も実行を継続させるが、同じ上限に縛られる。
      // 記事が多いと途中で打ち切られうる。確実な生成は cron（日次）が担い、
      // これはあくまで即時確認用の補助。全ルートは Cloudflare Access の内側
      // （＝オーナーのみ）前提なので追加認証は設けない。
      ctx.waitUntil(runDaily(env));
      return new Response(null, {
        status: 303,
        headers: { location: "/settings?ran=1" },
      });
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
