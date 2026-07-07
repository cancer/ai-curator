/**
 * ローカルプロキシ Worker（poc/ai-proxy、既定 http://localhost:8787）経由で Workers AI を呼ぶ薄いクライアント。
 * 応答形はモデルごとに異なるため正規化する:
 *   - bge-m3 embedding: { data: number[][], meta: { cost_metric_value_1: input_tokens, neurons } }
 *   - qwen3 embedding : { data: number[][], usage: { prompt_tokens } }（neurons は返らない）
 *   - LLM             : { response?: string, choices?[{message.content}], usage:{prompt_tokens,completion_tokens} }
 * 非 2xx / パース不能な応答はエラーとして本文付きで投げる（AiError はプレーンテキストで返る）。
 */

import { fetchWithRetry } from "./retry";

const PROXY_URL = process.env.AI_PROXY_URL ?? "http://localhost:8787";

/**
 * wrangler dev のエラーページ（HTML）から Workers AI の実際のエラーメッセージ（AiError）だけを
 * 抜き出す。抽出できない場合は本文の先頭 300 文字を返す（プレーンテキストのエラー応答用）。
 * HTML はスタイル定義が数万文字先行するため、先頭スライスでは実際のエラー文言に届かない
 * （実測 2026-07-07）。
 */
export function extractErrorDetail(raw: string): string {
  const match = raw.match(/<h2 id="error-message">[\s\S]*?<span>([^<]+)<\/span>\s*<\/h2>/);
  return match?.[1]?.trim() ?? raw.slice(0, 300);
}

/**
 * プロキシへ POST し JSON を返す。ローカル dev サーバの一時的な接続断（ConnectionClosed 等）や
 * 5xx 応答（実測 2026-07-07: wrangler dev 側の原因未特定の間欠的な内部エラーが発生）は
 * fetchWithRetry が指数バックオフでリトライする。4xx 応答はリクエスト自体の不備のため即座に投げる。
 */
async function callProxy(model: string, input: unknown): Promise<Record<string, unknown>> {
  const res = await fetchWithRetry(PROXY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input }),
  });
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`AI proxy ${model}: HTTP ${res.status}: ${extractErrorDetail(raw)}`);
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`AI proxy ${model}: non-JSON response: ${raw.slice(0, 300)}`);
  }
}

export interface EmbedResult {
  vectors: number[][];
  inputTokens: number;
  /** bge-m3 のみ実測 neurons を返す。qwen は undefined（単価から算出する）。 */
  reportedNeurons?: number;
}

export async function embed(model: string, texts: string[]): Promise<EmbedResult> {
  const json = await callProxy(model, { text: texts });
  const vectors = json.data as number[][] | undefined;
  if (!Array.isArray(vectors)) {
    throw new Error(`AI proxy ${model}: no data in embedding response`);
  }
  const meta = json.meta as { cost_metric_value_1?: number; neurons?: number } | undefined;
  const usage = json.usage as { prompt_tokens?: number } | undefined;
  return {
    vectors,
    inputTokens: meta?.cost_metric_value_1 ?? usage?.prompt_tokens ?? 0,
    reportedNeurons: meta?.neurons,
  };
}

export interface GenerateResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export async function generate(
  model: string,
  messages: { role: string; content: string }[],
  maxTokens: number,
): Promise<GenerateResult> {
  const json = await callProxy(model, { messages, max_tokens: maxTokens });
  const choices = json.choices as { message?: { content?: string } }[] | undefined;
  const text = (json.response as string | undefined) ?? choices?.[0]?.message?.content;
  if (typeof text !== "string") {
    throw new Error(`AI proxy ${model}: no text in generation response`);
  }
  const usage = json.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  return {
    text,
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
  };
}
