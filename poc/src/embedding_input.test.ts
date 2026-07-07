import { describe, expect, test } from "bun:test";
import { buildEmbeddingInput } from "./embedding_input";
import type { NormalizedArticle } from "./types";

const base: NormalizedArticle = {
  url: "https://x/1",
  title: "Astro 7 released",
  source: "github:withastro/astro",
  publishedAt: "2026-07-01T00:00:00Z",
  feedSummary: "A short feed summary.",
  body: "B".repeat(5000),
};

describe("buildEmbeddingInput", () => {
  test("title-summary: タイトルとフィード要約を結合する", () => {
    expect(buildEmbeddingInput(base, "title-summary", 2000)).toBe(
      "Astro 7 released\nA short feed summary.",
    );
  });

  test("title-bodyhead: タイトルと本文冒頭 N 字を結合する", () => {
    const out = buildEmbeddingInput(base, "title-bodyhead", 2000);
    expect(out).toBe(`Astro 7 released\n${"B".repeat(2000)}`);
  });

  test("fulltext: タイトルと本文全文を結合する", () => {
    const out = buildEmbeddingInput(base, "fulltext", 2000);
    expect(out).toBe(`Astro 7 released\n${"B".repeat(5000)}`);
  });

  test("body が無ければ title-bodyhead / fulltext はフィード要約にフォールバックする", () => {
    const noBody = { ...base, body: undefined };
    expect(buildEmbeddingInput(noBody, "title-bodyhead", 2000)).toBe(
      "Astro 7 released\nA short feed summary.",
    );
    expect(buildEmbeddingInput(noBody, "fulltext", 2000)).toBe(
      "Astro 7 released\nA short feed summary.",
    );
  });

  test("body も要約も無ければタイトルだけ", () => {
    const titleOnly = { ...base, body: undefined, feedSummary: undefined };
    expect(buildEmbeddingInput(titleOnly, "title-summary", 2000)).toBe("Astro 7 released");
  });
});
