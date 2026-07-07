/**
 * Embedding 入力テキストの組み立て（docs/04_poc_plan.md 出口判断の入力バリエーション検証）。
 * 本文（body）を持たないソースは、本文を要するバリエーションでもフィード要約に、
 * それも無ければタイトルのみにフォールバックする。
 */
import type { EmbeddingInputVariant } from "../config";
import type { NormalizedArticle } from "./types";

function join(title: string, rest: string): string {
  return rest ? `${title}\n${rest}` : title;
}

export function buildEmbeddingInput(
  article: NormalizedArticle,
  variant: EmbeddingInputVariant,
  bodyHeadChars: number,
): string {
  const summary = article.feedSummary ?? "";
  if (variant === "title-summary") {
    return join(article.title, summary);
  }
  const body = article.body;
  if (variant === "title-bodyhead") {
    return join(article.title, body ? body.slice(0, bodyHeadChars) : summary);
  }
  return join(article.title, body ?? summary);
}
