import { describe, it, expect, vi } from "vitest";
import {
  summarizeArticle,
  summarizeTrend,
  summarizeTopEntries,
  type SummaryTarget,
} from "./summarize";

interface RunArgs {
  messages: { role: string; content: string }[];
  max_tokens: number;
}

/** ai.run をモックし、呼び出し引数を記録する Ai を作る。 */
function mockAi(
  responder: (model: string, options: RunArgs) => Promise<unknown> = async () => ({
    response: "要約結果",
  }),
): { ai: Ai; calls: { model: string; options: RunArgs }[] } {
  const calls: { model: string; options: RunArgs }[] = [];
  const ai = {
    run: (async (model: string, options: RunArgs) => {
      calls.push({ model, options });
      return responder(model, options);
    }) as unknown as Ai["run"],
  } as Ai;
  return { ai, calls };
}

describe("summarizeArticle", () => {
  it("sends a system + user message and returns the trimmed response", async () => {
    const { ai, calls } = mockAi(async () => ({ response: "  これは要約です。  " }));

    const result = await summarizeArticle(ai, "@cf/model", 300, "記事タイトル", "本文");

    expect(result).toBe("これは要約です。");
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("@cf/model");
    expect(calls[0].options.max_tokens).toBe(300);
    const [system, user] = calls[0].options.messages;
    expect(system.role).toBe("system");
    expect(system.content).toContain("技術ニュースの編集者");
    expect(user.role).toBe("user");
    expect(user.content).toContain("記事タイトル");
    expect(user.content).toContain("本文");
  });

  it("truncates the body excerpt to 6,000 characters in the prompt", async () => {
    const { ai, calls } = mockAi();
    const longBody = "あ".repeat(10000);

    await summarizeArticle(ai, "@cf/model", 300, "t", longBody);

    const user = calls[0].options.messages[1].content;
    // The prompt must not carry the full 10,000-char body.
    expect(user).toContain("あ".repeat(6000));
    expect(user).not.toContain("あ".repeat(6001));
  });
});

describe("summarizeTrend", () => {
  it("summarizes an axis from its top titles and returns the narrative", async () => {
    const { ai, calls } = mockAi(async () => ({ response: "傾向叙述" }));

    const result = await summarizeTrend(ai, "@cf/model", 200, "AI", [
      "記事A",
      "記事B",
    ]);

    expect(result).toBe("傾向叙述");
    const user = calls[0].options.messages[1].content;
    expect(user).toContain("AI");
    expect(user).toContain("記事A");
    expect(user).toContain("記事B");
  });
});

describe("summarizeTopEntries", () => {
  function target(overrides: Partial<SummaryTarget> = {}): SummaryTarget {
    return {
      articleId: 1,
      title: "タイトル",
      source: "hn",
      url: "https://example.invalid/a",
      feedSummary: "フィード要約",
      ...overrides,
    };
  }

  const digest = { model: "@cf/model", summaryTopN: 10, maxOutputTokens: 300 };

  it("summarizes each target and returns summaries keyed by article id", async () => {
    const { ai } = mockAi(async () => ({ response: "s" }));
    const resolveBody = async () => "本文テキスト";

    const { summaries, failed } = await summarizeTopEntries(
      ai,
      digest,
      [target({ articleId: 1 }), target({ articleId: 2 })],
      resolveBody,
    );

    expect(failed).toBe(0);
    expect(summaries.get(1)).toBe("s");
    expect(summaries.get(2)).toBe("s");
  });

  it("falls back to feedSummary when the body resolver returns null (body-less source)", async () => {
    let capturedBody = "";
    const { ai } = mockAi(async (_m, options) => {
      capturedBody = options.messages[1].content;
      return { response: "s" };
    });
    const resolveBody = async () => null;

    const { summaries, failed } = await summarizeTopEntries(
      ai,
      digest,
      [target({ articleId: 1, feedSummary: "これはフィード要約" })],
      resolveBody,
    );

    expect(failed).toBe(0);
    expect(summaries.get(1)).toBe("s");
    expect(capturedBody).toContain("これはフィード要約");
  });

  it("falls back to feedSummary when the body resolver throws, without stopping the loop", async () => {
    const { ai } = mockAi(async () => ({ response: "s" }));
    const resolveBody = async () => {
      throw new Error("re-fetch failed");
    };

    const { summaries, failed } = await summarizeTopEntries(
      ai,
      digest,
      [target({ articleId: 1 }), target({ articleId: 2 })],
      resolveBody,
    );

    expect(failed).toBe(0);
    expect(summaries.get(1)).toBe("s");
    expect(summaries.get(2)).toBe("s");
  });

  it("excludes an entry whose summarization fails but keeps processing the rest", async () => {
    const { ai } = mockAi(async (_m, options) => {
      if (options.messages[1].content.includes("落ちる")) {
        throw new Error("LLM error");
      }
      return { response: "ok" };
    });
    const resolveBody = async (t: SummaryTarget) => t.title;

    const { summaries, failed } = await summarizeTopEntries(
      ai,
      digest,
      [
        target({ articleId: 1, title: "落ちる記事" }),
        target({ articleId: 2, title: "通る記事" }),
      ],
      resolveBody,
    );

    expect(failed).toBe(1);
    expect(summaries.has(1)).toBe(false);
    expect(summaries.get(2)).toBe("ok");
  });
});
