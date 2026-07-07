import { describe, expect, test } from "bun:test";
import { renderDigestMarkdown } from "./digest";

describe("renderDigestMarkdown", () => {
  const entry = {
    title: "Astro 7 released",
    source: "github:withastro/astro",
    publishedAt: "2026-07-01T00:00:00Z",
    url: "https://github.com/withastro/astro/releases/tag/v7.0.0",
    hitAxisLabel: "Web FW",
    summary: "Astro 7 ではビルドが高速化された。",
  };

  test("必須要素（タイトル・媒体名・公開日時・URL・選定理由・要約）をすべて含む", () => {
    const md = renderDigestMarkdown([entry]);
    expect(md).toContain(entry.title);
    expect(md).toContain(entry.source);
    expect(md).toContain(entry.publishedAt);
    expect(md).toContain(entry.url);
    expect(md).toContain(entry.hitAxisLabel);
    expect(md).toContain(entry.summary);
  });

  test("複数件を渡すと件数分のセクションになる", () => {
    const md = renderDigestMarkdown([entry, { ...entry, title: "Svelte 6 released" }]);
    expect(md.match(/^## /gm)).toHaveLength(2);
  });

  test("空配列なら本文なしのタイトルだけを返す", () => {
    const md = renderDigestMarkdown([]);
    expect(md).not.toContain("## ");
  });
});
