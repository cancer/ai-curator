import type { Env } from "../index";

/**
 * Embedding response from env.AI.run()
 * Reference: https://developers.cloudflare.com/workers-ai/models/bge-m3/
 */
interface EmbeddingResponse {
  data: number[][];
  shape: number[];
  pooling?: string;
  meta?: {
    cost_metric_value_1?: number; // input tokens
    neurons?: number;
  };
}

/**
 * Result of an embedding operation
 */
export interface EmbeddingResult {
  vector: number[];
  inputTokens?: number;
}

/**
 * Truncate input text to fit within token limits.
 * bge-m3: 8,192 token limit per sequence (practical limit).
 * Conservative estimate: 2.5 chars per token for technical text.
 * Formula: maxInputChars / 2.5 * 1 token ~= actual token usage.
 */
function truncateInput(text: string, maxInputChars: number): string {
  if (text.length <= maxInputChars) {
    return text;
  }
  return text.substring(0, maxInputChars);
}

/**
 * Retry with exponential backoff for AI.run() calls.
 * Separate from Task 4's fetchWithRetry because env.AI.run() throws errors
 * instead of returning HTTP responses — different error semantics.
 *
 * maxRetries is the number of retries after the initial attempt; with the
 * default 3 that is 4 attempts total, with backoff 1s → 2s → 4s between them.
 */
async function aiCallWithRetry(
  ai: Ai,
  model: string,
  input: string,
  maxRetries: number = 3,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms))
): Promise<EmbeddingResponse> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await ai.run(model, { text: [input] });
      return response as unknown as EmbeddingResponse;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Sleep before each retry; skip after the final attempt.
      if (attempt < maxRetries) {
        const backoffMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        await sleep(backoffMs);
      }
    }
  }

  throw lastError || new Error("AI embedding failed");
}

/**
 * Embed a single text input using the specified model.
 *
 * Key constraints from PoC:
 * - 1 article per request (don't batch)
 * - Input truncated to maxInputChars (default 20,000 chars)
 * - Retry with exponential backoff on 5xx/errors
 * - Returns vector + optional inputTokens count
 * - Model name should be included in the result context (caller's responsibility)
 */
export async function embed(
  ai: Ai,
  model: string,
  text: string,
  maxInputChars: number = 20000,
  sleep?: (ms: number) => Promise<void>
): Promise<EmbeddingResult> {
  const truncated = truncateInput(text, maxInputChars);

  const response = await aiCallWithRetry(ai, model, truncated, 3, sleep);

  // Extract vector from response
  if (!response.data || response.data.length === 0) {
    throw new Error("No embedding data in response");
  }

  const vector = response.data[0];

  // Try to extract input token count from meta
  const inputTokens = response.meta?.cost_metric_value_1;

  return {
    vector,
    inputTokens,
  };
}

/**
 * Embed multiple texts sequentially with 150ms delay between calls.
 * Useful for processing multiple articles without overwhelming the API.
 *
 * sleep parameter allows tests to inject instant returns instead of waiting.
 */
export async function embedBatch(
  ai: Ai,
  model: string,
  texts: string[],
  maxInputChars: number = 20000,
  sleep?: (ms: number) => Promise<void>
): Promise<EmbeddingResult[]> {
  const results: EmbeddingResult[] = [];
  const delayMs = 150;

  for (let i = 0; i < texts.length; i++) {
    if (i > 0) {
      // 150ms delay between consecutive calls (except before first)
      await (sleep ? sleep(delayMs) : new Promise((r) => setTimeout(r, delayMs)));
    }
    const result = await embed(ai, model, texts[i], maxInputChars, sleep);
    results.push(result);
  }

  return results;
}

/**
 * Determine if an interest axis needs to be updated.
 * Pure function for testing.
 *
 * Reasons to update:
 * (a) Axis not in database yet (existing === null)
 * (b) Seed text changed (sha256 mismatch)
 * (c) Embedding model changed
 */
export function axisNeedsUpdate(
  existing: {
    seed_hash: string;
    embedding_model: string;
  } | null,
  newSeedHash: string,
  newModel: string
): boolean {
  // (a) Not registered yet
  if (existing === null) {
    return true;
  }

  // (b) Seed text changed
  if (existing.seed_hash !== newSeedHash) {
    return true;
  }

  // (c) Model changed
  if (existing.embedding_model !== newModel) {
    return true;
  }

  return false;
}

/**
 * Compute SHA-256 hash of text and return as hex string.
 */
export async function sha256Hex(text: string): Promise<string> {
  const encoded = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const hashArray = Array.from(new Uint8Array(digest));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Sync interest axes with embeddings.
 * Called at start of Cron B (feed builder) to ensure axes are ready for relevance scoring.
 *
 * For each axis in config:
 * - Check if needs update (not registered / seed changed / model changed)
 * - If yes: generate embedding, upsert to DB
 *
 * Delete any axes no longer in config.
 */
export async function syncInterestAxes(
  db: D1Database,
  ai: Ai,
  axes: { id: string; label: string; seedText: string }[],
  model: string
): Promise<void> {
  // Get existing axes from database
  const existing = await db
    .prepare("SELECT axis_id, seed_hash, embedding_model FROM interest_axes")
    .all();

  const existingMap = new Map(
    (existing.results as Array<{
      axis_id: string;
      seed_hash: string;
      embedding_model: string;
    }>).map((row) => [
      row.axis_id,
      { seed_hash: row.seed_hash, embedding_model: row.embedding_model },
    ])
  );

  // Process each axis in config
  for (const axis of axes) {
    const newSeedHash = await sha256Hex(axis.seedText);
    const existing_ = existingMap.get(axis.id) || null;

    if (axisNeedsUpdate(existing_, newSeedHash, model)) {
      // Generate embedding
      const result = await embed(ai, model, axis.seedText);

      // Convert vector to JSON string for storage in D1
      const vectorJson = JSON.stringify(result.vector);

      // Upsert to database
      await db
        .prepare(
          `
        INSERT INTO interest_axes (axis_id, label, seed_hash, embedding, embedding_model, updated_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(axis_id) DO UPDATE SET
          label = excluded.label,
          seed_hash = excluded.seed_hash,
          embedding = excluded.embedding,
          embedding_model = excluded.embedding_model,
          updated_at = datetime('now')
      `
        )
        .bind(axis.id, axis.label, newSeedHash, vectorJson, model)
        .run();
    }
  }

  // Delete axes no longer in config
  const configAxisIds = new Set(axes.map((a) => a.id));
  for (const [axisId] of existingMap) {
    if (!configAxisIds.has(axisId)) {
      await db
        .prepare("DELETE FROM interest_axes WHERE axis_id = ?")
        .bind(axisId)
        .run();
    }
  }
}
