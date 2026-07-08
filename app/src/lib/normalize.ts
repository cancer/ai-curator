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
 * @throws {Error} If URL is invalid
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
