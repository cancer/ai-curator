/**
 * SimHash による機械的 Dedup（docs/02_specification.md §4-1）。
 * LLM・Embedding を使わず、テキストの近接をビット指紋の Hamming 距離で判定する。
 */

const MASK64 = (1n << 64n) - 1n;

/** FNV-1a 64bit ハッシュ。トークンを 64bit 空間に散らすためのもの。 */
function fnv1a64(token: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < token.length; i++) {
    hash ^= BigInt(token.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & MASK64;
  }
  return hash;
}

export function simhash(text: string): bigint {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const bitScores = new Array<number>(64).fill(0);
  for (const token of tokens) {
    const hash = fnv1a64(token);
    for (let bit = 0; bit < 64; bit++) {
      bitScores[bit]! += (hash >> BigInt(bit)) & 1n ? 1 : -1;
    }
  }
  let fingerprint = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if (bitScores[bit]! > 0) fingerprint |= 1n << BigInt(bit);
  }
  return fingerprint;
}

export function hammingDistance(a: bigint, b: bigint): number {
  let diff = a ^ b;
  let count = 0;
  while (diff > 0n) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }
  return count;
}

/**
 * SimHash の Hamming 距離が threshold 以下の項目を重複とみなし、先着の 1 件だけ残す。
 * 引数の配列は変更しない。
 */
export function mechanicalDedup<T>(
  items: readonly T[],
  toText: (item: T) => string,
  threshold: number,
): T[] {
  const kept: { item: T; fingerprint: bigint }[] = [];
  for (const item of items) {
    const fingerprint = simhash(toText(item));
    const isDuplicate = kept.some(
      (k) => hammingDistance(k.fingerprint, fingerprint) <= threshold,
    );
    if (!isDuplicate) kept.push({ item, fingerprint });
  }
  return kept.map((k) => k.item);
}
