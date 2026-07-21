/**
 * 関心軸ゲート判定（hit_axis に実質該当するか）。
 *
 * 関心軸マッチ（cosine argmax）はノイズ水準で無関係記事を拾うため、掲載記事に対して
 * LLM で「タイトル＋要約」から軸ラベルへの実質該当性を判定する。呼び出しは
 * summarize.ts の runTextGeneration（stream + 空回答リトライ + メトリクス記録済み）を
 * 再利用し、この module では LLM 呼び出し自体のリトライを持たない。
 *
 * summaryText は呼び出し側（daily.ts）で decodeSummary 済みの平文を渡す前提であり、
 * この module ではデコードしない。
 */

import type { DigestConfig } from "../config";
import { runTextGeneration, type OnDigestMetric } from "./summarize";

const RELEVANCE_SYSTEM =
  "記事のタイトルと要約から、関心テーマ『{axisLabel}』に実質該当するかを判定。" +
  "出力は『該当』または『非該当』の1語のみ。理由や他の文言を一切出力しない";

/**
 * 記事が軸ラベルに実質該当するかを判定する。
 *
 * 生出力の判定は「非該当」を先に検査する（「非該当」は部分文字列として「該当」を含む
 * ため、先に検査しないと常に該当判定になってしまう）。どちらの語も含まれない出力は
 * 判定不能として throw し、呼び出し側の失敗計上（axis_relevant は NULL のまま
 * fail-open）に委ねる。
 */
export async function judgeAxisRelevance(
  ai: Ai,
  digest: DigestConfig,
  axisLabel: string,
  title: string,
  summaryText: string,
  sleep?: (ms: number) => Promise<void>,
  onMetric?: OnDigestMetric,
): Promise<boolean> {
  const system = RELEVANCE_SYSTEM.replace("{axisLabel}", axisLabel);
  const user = `テーマ: ${axisLabel}\nタイトル: ${title}\n要約:\n${summaryText}`;

  const raw = await runTextGeneration(
    ai,
    digest.model,
    digest.maxOutputTokens,
    system,
    user,
    "relevance",
    sleep,
    onMetric,
  );

  if (raw.includes("非該当")) return false;
  if (raw.includes("該当")) return true;
  throw new Error(`judgeAxisRelevance: unrecognized output: ${raw.slice(0, 200)}`);
}
