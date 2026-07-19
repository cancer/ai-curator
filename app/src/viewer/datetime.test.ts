import { describe, it, expect } from "vitest";
import { toJstFeedDateLabel, formatJstPublishedAt } from "./datetime";

describe("toJstFeedDateLabel", () => {
  it("解釈: UTC日付キーを cron 実行時刻(21:00 UTC)の瞬間として JST の暦日へ繰り上げる", () => {
    // D 21:00 UTC = D+1 06:00 JST なので暦日は D+1。
    expect(toJstFeedDateLabel("2026-07-08")).toBe("2026-07-09");
  });

  it("不正な日付キーは原文をそのまま返す", () => {
    expect(toJstFeedDateLabel("not-a-date")).toBe("not-a-date");
  });
});

describe("formatJstPublishedAt", () => {
  it("UTC ISO を JST の YYYY-MM-DD HH:mm に変換する", () => {
    // 00:00 UTC + 9h = 09:00 JST（同日）。
    expect(formatJstPublishedAt("2026-07-08T00:00:00.000Z")).toBe(
      "2026-07-08 09:00",
    );
  });

  it("日付跨ぎ: 15:00 UTC は翌日 00:00 JST になる", () => {
    expect(formatJstPublishedAt("2026-07-08T15:00:00.000Z")).toBe(
      "2026-07-09 00:00",
    );
  });

  it("不正な ISO は原文をそのまま返す", () => {
    expect(formatJstPublishedAt("not-a-date")).toBe("not-a-date");
  });
});
