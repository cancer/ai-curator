import { describe, it, expect, vi } from "vitest";
import { judgeAxisRelevance } from "./relevance";
import { sseStream } from "../../test/sse";
import type { DigestConfig } from "../config";

const noSleep = async () => {};
const DIGEST: DigestConfig = { model: "d", maxOutputTokens: 300 };

function ai(run: (...args: never[]) => Promise<unknown>): Ai {
  return { run } as unknown as Ai;
}

describe("judgeAxisRelevance", () => {
  it("returns true when the LLM output contains 該当", async () => {
    const result = await judgeAxisRelevance(
      ai(vi.fn(async () => sseStream("該当"))),
      DIGEST,
      "AI",
      "title",
      "summary text",
      noSleep,
    );

    expect(result).toBe(true);
  });

  it("returns false when the LLM output contains 非該当", async () => {
    const result = await judgeAxisRelevance(
      ai(vi.fn(async () => sseStream("非該当"))),
      DIGEST,
      "AI",
      "title",
      "summary text",
      noSleep,
    );

    expect(result).toBe(false);
  });

  it("prefers 非該当 over 該当 when the output contains both", async () => {
    // 非該当 という文字列は 該当 を部分文字列として含むため、優先順位を明示的に検証する。
    const result = await judgeAxisRelevance(
      ai(vi.fn(async () => sseStream("結論として非該当です"))),
      DIGEST,
      "AI",
      "title",
      "summary text",
      noSleep,
    );

    expect(result).toBe(false);
  });

  it("throws when the output contains neither 該当 nor 非該当", async () => {
    await expect(
      judgeAxisRelevance(
        ai(vi.fn(async () => sseStream("わかりません"))),
        DIGEST,
        "AI",
        "title",
        "summary text",
        noSleep,
      ),
    ).rejects.toThrow();
  });

  it("retries on LLM exception and succeeds once the call recovers", async () => {
    let calls = 0;
    const run = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient AI error");
      return sseStream("該当");
    });

    const result = await judgeAxisRelevance(
      ai(run),
      DIGEST,
      "AI",
      "title",
      "summary text",
      noSleep,
    );

    expect(result).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
