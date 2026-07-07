import { describe, expect, test } from "bun:test";
import { semanticDedup } from "./semantic_dedup";

describe("semanticDedup", () => {
  const items = [
    { id: "a", vector: [1, 0, 0] },
    { id: "b", vector: [0.99, 0.01, 0] }, // a とほぼ同一
    { id: "c", vector: [0, 1, 0] },
  ];

  test("cosine が閾値以上の項目をクラスタ化し、代表 1 本だけ残す", () => {
    const kept = semanticDedup(items, (i) => i.vector, 0.9, () => 0);
    expect(kept.map((i) => i.id).sort()).toEqual(["a", "c"]);
  });

  test("代表は priority が最大の項目が選ばれる", () => {
    const priority: Record<string, number> = { a: 1, b: 5, c: 0 };
    const kept = semanticDedup(items, (i) => i.vector, 0.9, (i) => priority[i.id]!);
    expect(kept.map((i) => i.id).sort()).toEqual(["b", "c"]);
  });

  test("閾値未満なら全件残す（a と b の cosine ≈ 0.99995 を上回る閾値）", () => {
    const kept = semanticDedup(items, (i) => i.vector, 0.99999, () => 0);
    expect(kept).toHaveLength(3);
  });
});
