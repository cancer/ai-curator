/**
 * Fetch with retry logic for network errors and HTTP 5xx responses.
 *
 * Behavior:
 * - Retries on network exceptions and HTTP 5xx (up to 3 retries = 4 attempts)
 * - Exponential backoff between attempts: 1s → 2s → 4s
 * - 4xx responses return immediately without retry
 * - On retry exhaustion: throws last exception (network errors),
 *   or returns last Response (5xx errors)
 *
 * For testing, fetch and sleep can be injected via options to avoid real delays.
 */

export interface FetchWithRetryOptions {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_FETCH = globalThis.fetch;
const DEFAULT_SLEEP = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const BACKOFF_MS = [1000, 2000, 4000]; // 1s, 2s, 4s
const MAX_ATTEMPTS = 4; // initial + 3 retries

export async function fetchWithRetry(
  url: RequestInfo | URL,
  init?: RequestInit,
  options?: FetchWithRetryOptions,
): Promise<Response> {
  const fetchFn = options?.fetch ?? DEFAULT_FETCH;
  const sleepFn = options?.sleep ?? DEFAULT_SLEEP;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const isLastAttempt = attempt === MAX_ATTEMPTS - 1;
    try {
      const response = await fetchFn(url, init);

      // 4xx responses return immediately (no retry).
      if (response.status >= 400 && response.status < 500) {
        return response;
      }

      // 5xx responses: retry unless this is the last attempt.
      if (response.status >= 500 && !isLastAttempt) {
        await sleepFn(BACKOFF_MS[attempt]);
        continue;
      }

      // Success (2xx, 3xx), or a 5xx on the final attempt.
      return response;
    } catch (e) {
      // Network exception: throw on the last attempt, otherwise back off and retry.
      if (isLastAttempt) {
        throw e instanceof Error ? e : new Error(String(e));
      }
      await sleepFn(BACKOFF_MS[attempt]);
    }
  }

  // The loop always returns or throws on the final attempt; this satisfies the
  // return-type checker.
  throw new Error("fetchWithRetry: exhausted retries without a result");
}
