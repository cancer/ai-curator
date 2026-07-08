import { describe, it, expect } from "vitest";
import { clusterArticles, type DedupArticle } from "./semantic_dedup";

function art(overrides: Partial<DedupArticle> = {}): DedupArticle {
  return {
    id: 1,
    vector: [1, 0, 0],
    model: "m1",
    sourceTrust: 0.5,
    publishedAt: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

describe("clusterArticles", () => {
  it("merges two near-duplicate articles (cosine >= threshold) into one cluster", () => {
    const a = art({ id: 1, vector: [1, 0, 0] });
    const b = art({ id: 2, vector: [0.99, 0.01, 0] });
    const { keptIds, excludedIds } = clusterArticles([a, b], 0.9);
    expect(keptIds).toHaveLength(1);
    expect(excludedIds).toHaveLength(1);
    expect([...keptIds, ...excludedIds].sort()).toEqual([1, 2]);
  });

  it("keeps both when similarity is below the threshold", () => {
    const a = art({ id: 1, vector: [1, 0, 0] });
    const b = art({ id: 2, vector: [0, 1, 0] });
    const { keptIds, excludedIds } = clusterArticles([a, b], 0.9);
    expect(keptIds.sort()).toEqual([1, 2]);
    expect(excludedIds).toEqual([]);
  });

  it("selects the higher-trust article as the cluster representative", () => {
    const low = art({ id: 1, vector: [1, 0, 0], sourceTrust: 0.4 });
    const high = art({ id: 2, vector: [1, 0, 0], sourceTrust: 0.9 });
    const { keptIds, excludedIds } = clusterArticles([low, high], 0.9);
    expect(keptIds).toEqual([2]);
    expect(excludedIds).toEqual([1]);
  });

  it("breaks trust ties by choosing the newer article", () => {
    const older = art({
      id: 1,
      vector: [1, 0, 0],
      sourceTrust: 0.5,
      publishedAt: "2026-07-07T00:00:00.000Z",
    });
    const newer = art({
      id: 2,
      vector: [1, 0, 0],
      sourceTrust: 0.5,
      publishedAt: "2026-07-08T00:00:00.000Z",
    });
    const { keptIds, excludedIds } = clusterArticles([older, newer], 0.9);
    expect(keptIds).toEqual([2]);
    expect(excludedIds).toEqual([1]);
  });

  it("does not cluster articles whose embedding models differ, even if vectors match", () => {
    const a = art({ id: 1, vector: [1, 0, 0], model: "m1" });
    const b = art({ id: 2, vector: [1, 0, 0], model: "m2" });
    const { keptIds, excludedIds } = clusterArticles([a, b], 0.9);
    expect(keptIds.sort()).toEqual([1, 2]);
    expect(excludedIds).toEqual([]);
  });

  it("groups three near-duplicates and excludes the two non-representatives", () => {
    const a = art({ id: 1, vector: [1, 0, 0], sourceTrust: 0.4 });
    const b = art({ id: 2, vector: [1, 0, 0], sourceTrust: 0.9 });
    const c = art({ id: 3, vector: [1, 0, 0], sourceTrust: 0.4 });
    const { keptIds, excludedIds } = clusterArticles([a, b, c], 0.9);
    expect(keptIds).toEqual([2]);
    expect(excludedIds.sort()).toEqual([1, 3]);
  });

  it("returns empty results for empty input", () => {
    expect(clusterArticles([], 0.9)).toEqual({ keptIds: [], excludedIds: [] });
  });
});
