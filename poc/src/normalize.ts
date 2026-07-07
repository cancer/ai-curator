const TRACKING_PARAMS = /^(utm_|source$|ref$|fbclid$|gclid$)/;

export function normalizeUrl(raw: string): string {
  const url = new URL(raw);
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  }
  url.hash = "";
  return url.toString().replace(/\?$/, "");
}
