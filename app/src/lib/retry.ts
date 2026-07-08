/**
 * Fetch with retry logic for network errors and HTTP 5xx responses.
 *
 * Behavior:
 * - Retries on network exceptions and HTTP 5xx (max 3 attempts)
 * - Exponential backoff: 1s → 2s → 4s
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

export async function fetchWithRetry(
  url: RequestInfo | URL,
  init?: RequestInit,
  options?: FetchWithRetryOptions,
): Promise<Response> {
  const fetchFn = options?.fetch ?? DEFAULT_FETCH;
  const sleepFn = options?.sleep ?? DEFAULT_SLEEP;

  let lastException: Error | null = null;
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchFn(url, init);

      // 4xx responses return immediately
      if (response.status >= 400 && response.status < 500) {
        return response;
      }

      // 5xx responses: store and potentially retry
      if (response.status >= 500) {
        lastResponse = response;
        if (attempt < 2) {
          await sleepFn(BACKOFF_MS[attempt]);
          continue;
        }
        return response;
      }

      // Success (2xx, 3xx)
      return response;
    } catch (e) {
      lastException = e instanceof Error ? e : new Error(String(e));

      // If this was the last attempt, throw
      if (attempt === 2) {
        throw lastException;
      }

      // Otherwise sleep and retry
      await sleepFn(BACKOFF_MS[attempt]);
    }
  }

  // Should not reach here, but if we do and have a response, return it
  if (lastResponse) {
    return lastResponse;
  }

  // Otherwise throw the last exception
  throw lastException ?? new Error("Unknown error in fetchWithRetry");
}
