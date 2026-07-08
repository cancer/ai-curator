import type { HnSearchResponse } from "../../src/adapters/hn";

/**
 * Hacker News (Algolia) search_by_date レスポンスを模した合成データ（すべて架空）。
 *
 * - url あり（外部リンク記事）
 * - url=null の self-post（item?id フォールバック検証、story_text あり）
 * - url あり・story_text なし
 */
export const hnSearchRaw: HnSearchResponse = {
  hits: [
    {
      objectID: "48000001",
      title: "Imaginary framework hits 1.0",
      url: "https://example.invalid/blog/imaginary-1-0?ref=hn",
      points: 214,
      created_at: "2025-07-07T11:00:00.000Z",
    },
    {
      objectID: "48000002",
      title: "Ask HN: how do you test fictional widgets?",
      url: null,
      points: 130,
      created_at: "2025-07-07T09:30:00.000Z",
      story_text: "I maintain a made-up widget library and wonder about testing.",
    },
    {
      objectID: "48000003",
      title: "A pretend database written in a pretend language",
      url: "https://example.invalid/pretend-db",
      points: 98,
      created_at: "2025-07-06T22:15:00.000Z",
    },
  ],
};
