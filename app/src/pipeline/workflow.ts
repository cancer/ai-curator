/**
 * 日次パスの Cloudflare Workflow（取得〜要約を step に分割して実行する）。
 *
 * HTTP ハンドラ（fetch/scheduled）は受付のみで、実行はこの Workflow が持つ
 * （接続非依存）。`env.DAILY_PASS.create()` でインスタンスを起動し、進捗は
 * `instance.status()` で照会する（index.ts の GET /runs/{id}）。
 *
 * step 分割の要点は daily.ts のヘッダ（原文非永続・冪等性）に従う。run() 本体では
 * `new Date()` を呼ばない — run() 本体は step リプレイのたびに再実行されるため、
 * windowStart / date は `event.timestamp`（readonly なイベント時刻 = インスタンス生成
 * 時刻。replay で不変）だけから導出する。なお、記事の作業ウィンドウ絞り込みや created_at
 * などは各 step 内の D1 クエリが SQLite の `datetime('now')` を使う（そちらは step 実行時
 * 刻・冪等な範囲条件なので replay 差異の問題にならない）。この分担を混同しないこと。
 */

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Env } from "../index";
import { loadConfig } from "../config";
import { syncInterestAxes } from "../lib/embedding";
import {
  buildTrends,
  ingestFeed,
  scoreAndBuildFeed,
  summarizeFeed,
} from "./daily";

/** 当日ウィンドウの長さ（時間）。下限 = 実行時刻 - この時間。 */
const WINDOW_HOURS = 24;

/**
 * step の既定リトライ方針（Workflows の既定に沿う: limit 5 / 指数 / 10 分）。
 * 設定不正など再試行が無意味な失敗は load-config step 内で NonRetryableError を投げる。
 */
const STEP_CONFIG: WorkflowStepConfig = {
  retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
  timeout: "10 minutes",
};

/**
 * 日次パスのオーケストレーション本体。DailyPass.run から env/event/step を渡して呼ぶ。
 * WorkflowEntrypoint はテストで直接 new できない（ctx の実体が要る）ため、ロジックは
 * この純関数に置き、クラスは薄い委譲だけにする。
 */
export async function runDailyWorkflow(
  env: Env,
  event: WorkflowEvent<unknown>,
  step: WorkflowStep,
): Promise<void> {
  const runAt = event.timestamp;
  const windowStart = new Date(runAt.getTime() - WINDOW_HOURS * 3600 * 1000);
  const date = runAt.toISOString().slice(0, 10);

  // load-config: KV から設定を読む（KV 読取の実証点）。設定不正は決定論的な失敗
  // なので NonRetryableError にして即失敗させる（5 回のリトライを浪費しない）。
  const config = await step.do("load-config", STEP_CONFIG, async () => {
    try {
      return await loadConfig(env);
    } catch (err) {
      throw new NonRetryableError(
        err instanceof Error ? err.message : String(err),
      );
    }
  });

  // ingest: feed ごとに 1 step。1 ソースの失敗は握って続行、全滅時のみ throw。
  // step が全リトライを使い切ると await が throw するので try/catch で拾う。
  // 重複 URL は除く（step 名 `ingest:${feedUrl}` はインスタンス内で一意である必要があり、
  // 同一 URL の二重取得も無駄なため）。
  const feeds = [...new Set(config.sources.feeds)];
  const failedFeeds: string[] = [];
  for (const feedUrl of feeds) {
    try {
      await step.do(`ingest:${feedUrl}`, STEP_CONFIG, async () =>
        ingestFeed(env.DB, env.AI, feedUrl, windowStart, config.embedding),
      );
    } catch {
      failedFeeds.push(feedUrl);
    }
  }
  if (feeds.length > 0 && failedFeeds.length === feeds.length) {
    throw new Error(
      `daily: all ${feeds.length} source(s) failed: ${failedFeeds.join(", ")}`,
    );
  }

  // axis-sync: 関心軸の label 変更検知 → 記述文生成 → embedding upsert。
  await step.do("axis-sync", STEP_CONFIG, async () => {
    await syncInterestAxes(
      env.DB,
      env.AI,
      config.interestAxes,
      config.embedding.model,
      config.digest.model,
    );
    return { axes: config.interestAxes.length };
  });

  // score: 意味的 dedup → スコアリング → feed_entries 当日 delete→insert。
  await step.do("score", STEP_CONFIG, async () =>
    scoreAndBuildFeed(env.DB, config.scoring, config.embedding.model, runAt),
  );

  // summarize: 当日 feed_entries を全件要約（body はここで再取得して使い捨て）。
  await step.do("summarize", STEP_CONFIG, async () =>
    summarizeFeed(env.DB, env.AI, config.digest, date),
  );

  // trends: 軸別の傾向サマリ（当日分 delete→insert）。
  await step.do("trends", STEP_CONFIG, async () =>
    buildTrends(env.DB, env.AI, config.digest, config.interestAxes, date),
  );
}

export class DailyPass extends WorkflowEntrypoint<Env> {
  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<unknown> {
    return runDailyWorkflow(this.env, event, step);
  }
}
