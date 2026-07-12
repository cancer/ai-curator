/**
 * 64bit SimHash による近傍重複判定。
 *
 * 入力文字列は呼び出し側で `title + " " + (feedSummary ?? "")` を組み立てて渡す
 * （body は含めない — 保存対象と揃え、本文有無でハッシュが変わらないようにする）。
 * トークンは「文字・数字以外」を区切りとする単純な word 分割。
 * ハッシュは 64bit を 16 進 16 桁で保持し（articles.content_hash）、
 * 2 ハッシュ間のハミング距離 ≤ SIMHASH_DUP_DISTANCE を重複とみなす。
 */

/** ハミング距離がこの値以下なら重複とみなす。 */
export const SIMHASH_DUP_DISTANCE = 3;

const MASK64 = (1n << 64n) - 1n;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

/** トークン単位の 64bit ハッシュ（FNV-1a）。 */
function fnv1a64(token: string): bigint {
  let hash = FNV_OFFSET;
  for (let i = 0; i < token.length; i++) {
    hash ^= BigInt(token.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash;
}

/** 文字・数字以外を区切りとする単純な word 分割（小文字化）。 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/**
 * 64bit SimHash を 16 進 16 桁で返す。
 * トークンが 0 個なら "0000000000000000" を返す。
 */
export function simhash(text: string): string {
  const counts = new Array<number>(64).fill(0);

  for (const token of tokenize(text)) {
    const hash = fnv1a64(token);
    for (let bit = 0; bit < 64; bit++) {
      if ((hash >> BigInt(bit)) & 1n) {
        counts[bit] += 1;
      } else {
        counts[bit] -= 1;
      }
    }
  }

  let result = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if (counts[bit] > 0) {
      result |= 1n << BigInt(bit);
    }
  }

  return result.toString(16).padStart(16, "0");
}

/** 2 つの 16 進ハッシュ間のハミング距離（異なるビット数）。 */
export function hammingDistance(a: string, b: string): number {
  let xor = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let distance = 0;
  while (xor > 0n) {
    distance += Number(xor & 1n);
    xor >>= 1n;
  }
  return distance;
}
