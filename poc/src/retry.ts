/**
 * fetch の共通リトライユーティリティ。ネットワーク例外や 5xx 応答を指数バックオフでリトライする。
 * 実測 2026-07-07: GitHub API 等へのソース fetch で Bun 1.1.22-canary の間欠的な
 * `Malformed_HTTP_Response` が発生し、対象リポジトリを変えて複数回発生した（単発再現では成功する）。
 * 4xx 応答はリクエスト自体の不備のため即座に返し、呼び出し側で判定させる。
 */

/** リトライ回数（初回呼び出しを含まない）の既定値。 */
const DEFAULT_MAX_RETRIES = 3;

/** リトライ間隔（指数バックオフ 1s → 2s → 4s）。attempt は 0 始まり。 */
export function backoffDelayMs(attempt: number): number {
  return 1000 * 2 ** attempt;
}

export interface FetchWithRetryOptions {
  /** テスト用の差し替え。既定は組み込み fetch。 */
  fetchFn?: typeof fetch;
  /** テスト用の差し替え。既定は Bun.sleep。 */
  sleepFn?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

/**
 * fetch を呼び、ネットワーク例外または 5xx 応答を指数バックオフでリトライする。
 * 4xx 応答はリトライせずそのまま返す（呼び出し側の `!res.ok` チェックで即座に失敗させるため）。
 * リトライを使い切った場合: ネットワーク例外は最後の例外を投げ、5xx 応答は最後の Response を返す。
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const fetchFn = options.fetchFn ?? fetch;
  const sleepFn = options.sleepFn ?? ((ms: number) => Bun.sleep(ms));
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchFn(url, init);
    } catch (e) {
      if (attempt >= maxRetries) throw e;
      await sleepFn(backoffDelayMs(attempt));
      continue;
    }
    if (res.status >= 500 && attempt < maxRetries) {
      await sleepFn(backoffDelayMs(attempt));
      continue;
    }
    return res;
  }
}
