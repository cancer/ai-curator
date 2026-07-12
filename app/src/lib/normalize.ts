/**
 * Remove tracking-related query parameters and URL fragments.
 *
 * Removes:
 * - Parameters matching utm_* prefix
 * - source, ref, fbclid, gclid
 * - URL fragments (#...)
 *
 * Preserves other query parameters (e.g., HN's item?id=).
 *
 * Only http:/https: URLs are accepted. This value is later emitted into the
 * Viewer's `<a href>` and the `/r/{id}` 302 Location, so dangerous schemes
 * (javascript:, data: etc.) are rejected here to close a stored-XSS path.
 *
 * @throws {Error} If URL is invalid or its scheme is not http/https
 * @returns Normalized URL string
 */
export function normalizeUrl(raw: string): string {
  // Parse URL - will throw if invalid
  let url: URL;
  try {
    url = new URL(raw);
  } catch (e) {
    throw new Error(`Invalid URL: ${raw}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme: ${url.protocol} (${raw})`);
  }

  // Tracking parameters to remove
  const trackingParams = new Set([
    "source",
    "ref",
    "fbclid",
    "gclid",
  ]);

  // Remove tracking parameters
  const params = new URLSearchParams(url.search);
  // Collect keys to delete first (avoid iterator invalidation)
  const keysToDelete: string[] = [];
  for (const key of params.keys()) {
    // Check if parameter matches utm_* prefix or is in tracking set
    if (key.startsWith("utm_") || trackingParams.has(key)) {
      keysToDelete.push(key);
    }
  }
  // Then delete them
  for (const key of keysToDelete) {
    params.delete(key);
  }

  // Reconstruct URL without fragment
  url.search = params.toString();
  url.hash = "";

  return url.toString();
}
