/**
 * LLM による記事要約と軸別の傾向叙述（Cron B の上位要約ステップ）。
 *
 * 生成物（要約・叙述）は自前生成のため保存してよい。記事本文(body)は
 * ここでも一時データで、プロンプトに載せるのみ・D1 やログに書かない。
 *
 * digest モデルはハードコードせず config.digest.model を使う。
 * 注意: llama-3.2-3b-instruct は日本語品質が不十分なため既定候補にはしない
 * （モデル選定は運用時の人手比較=タスク10 で行う）。
 */

import type { DigestConfig } from "../config";

/** Workers AI テキスト生成の応答。response に生成テキストが入る。 */
interface TextGenerationResponse {
  response: string;
}

/** プロンプトに載せる本文抜粋の最大文字数。 */
const BODY_EXCERPT_CHARS = 6000;

/** 初期試行の後の最大リトライ回数（計 4 試行、バックオフ 1s → 2s → 4s）。 */
const MAX_RETRIES = 3;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const ARTICLE_SYSTEM =
  "あなたは技術ニュースの編集者です。与えられた記事のタイトルと本文抜粋から、" +
  "内容を 2〜3 文の日本語で要約してください。誇張や主観的評価を避け、" +
  "記事の主旨を簡潔に伝えてください。";

const TREND_SYSTEM =
  "あなたは技術ニュースの編集者です。ある関心テーマについて、当日の記事タイトル一覧から、" +
  "その日の技術的な傾向を 1〜2 文の日本語で簡潔に叙述してください。" +
  "誇張や主観的評価を避けてください。";

/**
 * ai.run をリトライ付きで呼ぶ。AI バインディングは一時エラーで例外を投げる
 * ことがある（PoC 実測）ため、例外時に指数バックオフ（1s → 2s → 4s）で
 * 最大 MAX_RETRIES 回まで再試行する。embedding.ts の aiCallWithRetry と同方針。
 * sleep はテストで実時間を待たないよう注入可能にする。
 */
async function runTextGeneration(
  ai: Ai,
  model: string,
  maxTokens: number,
  system: string,
  user: string,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = (await ai.run(model, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: maxTokens,
      })) as unknown as TextGenerationResponse;
      return response.response.trim();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < MAX_RETRIES) {
        await sleep(Math.pow(2, attempt) * 1000);
      }
    }
  }

  throw lastError ?? new Error("text generation failed");
}

/** 1 記事の要約。本文抜粋は先頭 BODY_EXCERPT_CHARS 字に切り詰める。 */
export function summarizeArticle(
  ai: Ai,
  model: string,
  maxTokens: number,
  title: string,
  body: string,
  sleep?: (ms: number) => Promise<void>,
): Promise<string> {
  const excerpt = body.slice(0, BODY_EXCERPT_CHARS);
  const user = `タイトル: ${title}\n\n本文抜粋:\n${excerpt}`;
  return runTextGeneration(ai, model, maxTokens, ARTICLE_SYSTEM, user, sleep);
}

/** 1 軸の傾向叙述。その軸のタイトル上位群を入力にする。 */
export function summarizeTrend(
  ai: Ai,
  model: string,
  maxTokens: number,
  axisLabel: string,
  titles: string[],
  sleep?: (ms: number) => Promise<void>,
): Promise<string> {
  const user = `テーマ: ${axisLabel}\n\n本日の記事タイトル:\n${titles.join("\n")}`;
  return runTextGeneration(ai, model, maxTokens, TREND_SYSTEM, user, sleep);
}

/** 要約対象。本文は source/url から再取得する（resolveBody に委譲）。 */
export interface SummaryTarget {
  articleId: number;
  title: string;
  source: string;
  url: string;
  feedSummary: string | null;
}

export interface TopEntriesResult {
  /** article_id → 生成要約。 */
  summaries: Map<number, string>;
  /** 要約に失敗して除外した件数。 */
  failed: number;
}

/**
 * 上位エントリを要約する。各エントリで本文を再取得（resolveBody）し、
 * 取得できなければ feedSummary にフォールバックする。1 件の要約失敗は
 * try/catch で除外し件数を数えて、ループは止めない。
 */
export async function summarizeTopEntries(
  ai: Ai,
  digest: DigestConfig,
  targets: SummaryTarget[],
  resolveBody: (target: SummaryTarget) => Promise<string | null>,
  sleep?: (ms: number) => Promise<void>,
): Promise<TopEntriesResult> {
  const summaries = new Map<number, string>();
  let failed = 0;

  for (const target of targets) {
    try {
      let body: string | null = null;
      try {
        body = await resolveBody(target);
      } catch (err) {
        console.warn(
          `summarize: body re-fetch failed for article ${target.articleId}; ` +
            `falling back to feedSummary: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const text = body ?? target.feedSummary ?? "";
      const summary = await summarizeArticle(
        ai,
        digest.model,
        digest.maxOutputTokens,
        target.title,
        text,
        sleep,
      );
      summaries.set(target.articleId, summary);
    } catch (err) {
      failed += 1;
      console.warn(
        `summarize: skipped article ${target.articleId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (failed > 0) {
    console.log(`summarize: ${failed} entr(ies) excluded due to errors`);
  }
  return { summaries, failed };
}
