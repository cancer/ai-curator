/**
 * Digest markdown の組み立て（docs/02_specification.md §8）。
 * 必須要素: タイトル・媒体名・公開日時・一次ソース URL・選定理由（ヒット軸）・自前生成の要約。
 * 本文（body）は含めない（NFR-2）。
 */
export interface DigestEntry {
  title: string;
  source: string;
  publishedAt: string;
  url: string;
  hitAxisLabel: string;
  summary: string;
}

function renderEntry(entry: DigestEntry): string {
  return [
    `## ${entry.title}`,
    "",
    `- 媒体: ${entry.source}`,
    `- 公開日時: ${entry.publishedAt}`,
    `- 選定理由: 関心軸「${entry.hitAxisLabel}」に関連`,
    `- URL: ${entry.url}`,
    "",
    entry.summary,
  ].join("\n");
}

export function renderDigestMarkdown(entries: readonly DigestEntry[]): string {
  const sections = entries.map(renderEntry);
  return ["# Digest", "", ...sections].join("\n").trimEnd();
}
