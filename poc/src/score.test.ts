import { describe, expect, test } from "bun:test";
import {
  computeScore,
  cosineSimilarity,
  freshnessDecay,
  interestSimilarity,
  resolveSourceTrust,
} from "./score";

describe("cosineSimilarity", () => {
  test("同一ベクトルは 1", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });
  test("直交ベクトルは 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
  test("逆向きベクトルは -1", () => {
    expect(cosineSimilarity([1, 1], [-1, -1])).toBeCloseTo(-1);
  });
  test("次元不一致は例外", () => {
    expect(() => cosineSimilarity([1, 2], [1])).toThrow();
  });
  test("ゼロベクトルは例外（0 除算を防ぐ）", () => {
    expect(() => cosineSimilarity([0, 0], [1, 1])).toThrow();
  });
});

describe("freshnessDecay", () => {
  const now = new Date("2026-07-06T00:00:00Z");
  test("公開直後は 1 に近い", () => {
    expect(freshnessDecay("2026-07-06T00:00:00Z", now, 14)).toBeCloseTo(1);
  });
  test("半減期の経過でちょうど 0.5", () => {
    expect(freshnessDecay("2026-06-22T00:00:00Z", now, 14)).toBeCloseTo(0.5, 2);
  });
  test("古いほど小さく、0〜1 に収まる", () => {
    const old = freshnessDecay("2025-01-01T00:00:00Z", now, 14);
    expect(old).toBeGreaterThan(0);
    expect(old).toBeLessThan(0.01);
  });
});

describe("resolveSourceTrust", () => {
  const table = { fowler: 1.0, github: 0.7, hn: 0.5, "medium:@k": 0.9 };
  test("完全一致を優先する", () => {
    expect(resolveSourceTrust("medium:@k", table)).toBe(0.9);
    expect(resolveSourceTrust("hn", table)).toBe(0.5);
  });
  test('":" より前の接頭辞で解決する', () => {
    expect(resolveSourceTrust("github:sveltejs/svelte", table)).toBe(0.7);
  });
  test("未知のソースは例外（フェイルファスト）", () => {
    expect(() => resolveSourceTrust("unknown:x", table)).toThrow();
  });
});

describe("interestSimilarity", () => {
  test("最大 cosine を与える軸をヒット軸として返す", () => {
    const axes = [
      { id: "a", vector: [1, 0] },
      { id: "b", vector: [0, 1] },
    ];
    const result = interestSimilarity([0.1, 1], axes);
    expect(result.hitAxisId).toBe("b");
    expect(result.similarity).toBeCloseTo(cosineSimilarity([0.1, 1], [0, 1]));
  });
});

describe("computeScore", () => {
  test("重み付き和を計算する", () => {
    const score = computeScore(
      { interest: 0.8, freshness: 0.5, sourceTrust: 1.0 },
      { w1: 0.6, w2: 0.3, w3: 0.1 },
    );
    expect(score).toBeCloseTo(0.6 * 0.8 + 0.3 * 0.5 + 0.1 * 1.0);
  });
});
