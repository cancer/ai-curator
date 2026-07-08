import { describe, it, expect } from "vitest";
import { simhash, hammingDistance, SIMHASH_DUP_DISTANCE } from "./simhash";

describe("simhash", () => {
  it("returns a 16-char hex string (64 bits)", () => {
    const h = simhash("the quick brown fox");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic: same input → same hash", () => {
    const text = "the quick brown fox jumps over the lazy dog";
    expect(simhash(text)).toBe(simhash(text));
  });

  it("is order/whitespace-tolerant on token set (bag of words)", () => {
    // Same tokens, different spacing/punctuation → identical hash.
    expect(simhash("alpha beta gamma")).toBe(simhash("alpha, beta.  gamma"));
  });

  it("gives a small hamming distance for a one-word difference", () => {
    const base = "the quick brown fox jumps over the lazy dog";
    const oneWord = "the quick brown fox jumps over the lazy cat";
    const distance = hammingDistance(simhash(base), simhash(oneWord));
    expect(distance).toBeGreaterThan(0);
    expect(distance).toBeLessThanOrEqual(12);
  });

  it("gives a larger distance for unrelated text than for a one-word diff", () => {
    const base = "the quick brown fox jumps over the lazy dog";
    const oneWord = "the quick brown fox jumps over the lazy cat";
    const unrelated =
      "completely different sentence about databases networking and distributed protocols";
    const near = hammingDistance(simhash(base), simhash(oneWord));
    const far = hammingDistance(simhash(base), simhash(unrelated));
    expect(far).toBeGreaterThan(near);
  });
});

describe("hammingDistance", () => {
  it("is 0 for identical hashes", () => {
    expect(hammingDistance("00000000deadbeef", "00000000deadbeef")).toBe(0);
  });

  it("counts differing bits between two hex hashes", () => {
    // 0x...0 vs 0x...3 → binary ...0000 vs ...0011 → 2 bits differ.
    expect(hammingDistance("0000000000000000", "0000000000000003")).toBe(2);
    // 0x0 vs 0xf → 4 bits differ.
    expect(hammingDistance("0000000000000000", "000000000000000f")).toBe(4);
    // full 64-bit flip.
    expect(hammingDistance("0000000000000000", "ffffffffffffffff")).toBe(64);
  });

  it("is symmetric", () => {
    expect(hammingDistance("00ff00ff00ff00ff", "ff00ff00ff00ff00")).toBe(
      hammingDistance("ff00ff00ff00ff00", "00ff00ff00ff00ff"),
    );
  });
});

describe("SIMHASH_DUP_DISTANCE", () => {
  it("is 3 per the dedup spec (hamming ≤ 3 is a duplicate)", () => {
    expect(SIMHASH_DUP_DISTANCE).toBe(3);
  });
});
