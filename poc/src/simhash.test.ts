import { describe, expect, test } from "bun:test";
import { hammingDistance, mechanicalDedup, simhash } from "./simhash";

describe("simhash / hammingDistance", () => {
  test("同一テキストの距離は 0", () => {
    const t = "the quick brown fox jumps over the lazy dog";
    expect(hammingDistance(simhash(t), simhash(t))).toBe(0);
  });

  test("大文字小文字・記号・空白だけの違いは距離 0（機械的 Dedup が狙う ほぼ重複）", () => {
    const a = simhash("Astro 7 released with new content layer and view transitions");
    const b = simhash("ASTRO 7 released, with new content layer  and view transitions!");
    expect(hammingDistance(a, b)).toBe(0);
  });

  test("無関係なテキストは距離が大きい", () => {
    const a = simhash("Svelte 5 runes reactivity and component compilation");
    const b = simhash("Regression testing and the Saff Squeeze defect isolation");
    expect(hammingDistance(a, b)).toBeGreaterThan(10);
  });

  test("空文字列でも例外を投げない", () => {
    expect(() => simhash("")).not.toThrow();
  });
});

describe("mechanicalDedup", () => {
  test("ほぼ同一の項目を除去し、最初の 1 件を残す", () => {
    const items = [
      { id: "a", text: "Astro 7 released with new content layer and view transitions" },
      { id: "b", text: "Astro 7 released with new content layer and view transitions!" },
      { id: "c", text: "Kent Beck on tuning software development for rate of change" },
    ];
    const kept = mechanicalDedup(items, (i) => i.text, 3);
    expect(kept.map((i) => i.id)).toEqual(["a", "c"]);
  });

  test("重複がなければ全件残す", () => {
    const items = [
      { id: "a", text: "completely different topic one about frameworks" },
      { id: "b", text: "utterly unrelated subject two regarding testing" },
    ];
    const kept = mechanicalDedup(items, (i) => i.text, 3);
    expect(kept).toHaveLength(2);
  });
});
