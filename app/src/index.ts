/**
 * AI curator 実運用 v1 — 単一 Worker のエントリポイント。
 *
 * - scheduled: cron 1本。日次パスの Workflow インスタンスを起動するだけ。
 * - fetch: Viewer(閲覧・設定・フィードバック収集)＋日次パスの受付/状態照会。
 *
 * 日次パスの実行は Workflow（DailyPass）が持つ（接続非依存）。HTTP ハンドラは
 * 「インスタンスを create する / status を返す」受付だけを担い、実行完了を待たない。
 */

import { DailyPass } from "./pipeline/workflow";
import { renderFeedPage } from "./viewer/index";
import { renderSettingsForm, handleConfigApi } from "./viewer/settings";
import { handleClickRedirect, handleFeedbackApi } from "./viewer/feedback";

// Workflow のクラスは Worker から export しておく必要がある（wrangler の class_name）。
export { DailyPass };

/** バインディング。後続タスクは `import type { Env } from "./index"` で参照する。 */
export interface Env {
  AI: Ai;
  DB: D1Database;
  /** 日次パスの Workflow（wrangler.jsonc の workflows binding）。 */
  DAILY_PASS: Workflow;
}

export default {
  async scheduled(_controller, env, _ctx) {
    // cron は 1 本。日次パスの Workflow インスタンスを起動するだけ（実行は Workflow）。
    await env.DAILY_PASS.create();
  },

  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const { method } = request;

    if (method === "GET" && pathname === "/") {
      const page = Number(url.searchParams.get("page") ?? "1");
      return renderFeedPage(
        env,
        page,
        url.searchParams.get("category"),
        url.searchParams.get("body"),
        url.searchParams.get("gate"),
      );
    }
    if (method === "GET" && pathname === "/settings") {
      return renderSettingsForm(env, url.searchParams.get("run"));
    }
    if (method === "POST" && pathname === "/api/config") {
      return handleConfigApi(env, request);
    }
    if (method === "POST" && pathname === "/run") {
      // 日次パスの手動実行。Workflow インスタンスを create するだけで即戻す
      // （実行完了は待たない・接続維持しない）。進捗は GET /runs/{id} で照会する。
      // 全ルートは Cloudflare Access の内側（＝オーナーのみ）前提なので追加認証は設けない。
      const instance = await env.DAILY_PASS.create();
      return new Response(null, {
        status: 303,
        headers: { location: `/settings?run=${instance.id}` },
      });
    }
    if (method === "GET" && pathname.startsWith("/runs/")) {
      // 日次パスの状態照会。インスタンス ID から status() を JSON で返す。
      const id = pathname.slice("/runs/".length);
      const instance = await env.DAILY_PASS.get(id);
      return Response.json(await instance.status());
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
