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
 * Determine if an interest axis needs to be (re)built.
 * Pure function for testing.
 *
 * Reasons to update:
 * (a) Axis not in database yet (existing === null)
 * (b) Label changed (sha256 of the label mismatches the stored seed_hash)
 * (c) Embedding model changed
 *
 * Note: the D1 column is still named `seed_hash` (deployed schema unchanged),
 * but it now stores the hash of the axis *label* — the description text is
 * derived from the label, so the label is the sole user-controlled input.
 * The digest model is deliberately NOT a rebuild trigger: swapping the summary
 * model must not force a re-embed of every axis.
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

  // (b) Label changed
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
 * Expand an interest axis label into a concise English description, used as the
 * embedding input for that axis.
 *
 * The user only provides the label (a natural-language topic name, any language);
 * the system expands it via the digest (text-generation) model so the axis vector
 * is not a weak 1-2 word embedding. bge-m3 is multilingual, so the label language
 * does not matter — we generate an English description for consistency.
 *
 * Retries with exponential backoff like aiCallWithRetry (env.AI.run throws on
 * transient errors — PoC). `generate` is injectable for tests.
 */
export async function generateAxisDescription(
  ai: Ai,
  digestModel: string,
  label: string,
  maxRetries: number = 3,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms))
): Promise<string> {
  const messages = [
    {
      role: "system",
      content:
        "You expand a short topic name into a concise English description used for semantic matching of technical articles. Output only the description (2-3 sentences), no preamble.",
    },
    {
      role: "user",
      content: `Topic: ${label}\n\nDescribe the scope of this topic (technologies, subtopics, concerns) so that relevant tech articles can be matched by embedding similarity.`,
    },
  ];

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = (await ai.run(digestModel, { messages })) as {
        response?: string;
      };
      const text = (res.response ?? "").trim();
      if (text === "") {
        throw new Error("Empty axis description from LLM");
      }
      return text;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        await sleep(Math.pow(2, attempt) * 1000);
      }
    }
  }
  throw lastError || new Error("Axis description generation failed");
}

/**
 * Sync interest axes with embeddings.
 * Called at the start of the daily pass to ensure axes are ready for relevance scoring.
 *
 * For each axis in config (user provides only { id, label }):
 * - Check if it needs (re)build: not registered / label hash changed / embedding
 *   model changed (the D1 column is still named `seed_hash` but stores the hash
 *   of the *label*). The digest model is NOT a rebuild trigger.
 * - If yes: expand the label into a description (LLM), embed the description, upsert.
 *
 * Axis deletion is NOT this function's responsibility: interest_axes is now the
 * source of truth and /settings (saveConfig) owns removing rows for deleted axes.
 * The cron only fills derived columns; it never deletes source rows. The existing
 * query is therefore scoped to already-embedded rows (embedding IS NOT NULL): a
 * source-only row (axis added via /settings, not yet embedded) is absent from the
 * map, so `existing === null` drives axisNeedsUpdate to embed it.
 */
export async function syncInterestAxes(
  db: D1Database,
  ai: Ai,
  axes: { id: string; label: string }[],
  embeddingModel: string,
  digestModel: string,
  sleep?: (ms: number) => Promise<void>
): Promise<void> {
  const existing = await db
    .prepare(
      "SELECT axis_id, seed_hash, embedding_model FROM interest_axes WHERE embedding IS NOT NULL"
    )
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

  for (const axis of axes) {
    const newLabelHash = await sha256Hex(axis.label);
    const existing_ = existingMap.get(axis.id) || null;

    if (axisNeedsUpdate(existing_, newLabelHash, embeddingModel)) {
      // Expand the label into a description, then embed the description.
      const description = await generateAxisDescription(
        ai,
        digestModel,
        axis.label,
        3,
        sleep
      );
      const result = await embed(
        ai,
        embeddingModel,
        description,
        undefined,
        sleep
      );
      const vectorJson = JSON.stringify(result.vector);

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
        .bind(axis.id, axis.label, newLabelHash, vectorJson, embeddingModel)
        .run();
    }
  }
}
