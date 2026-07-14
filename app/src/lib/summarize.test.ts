import { describe, it, expect } from "vitest";
import {
  summarizeArticle,
  summarizeTrend,
  summarizeEntries,
  type SummaryTarget,
} from "./summarize";
import { sseStream } from "../../test/sse";
import type { DigestMetric } from "./summarize";

interface RunArgs {
  messages: { role: string; content: string }[];
  max_tokens: number;
  temperature: number;
  stream?: boolean;
}

/**
 * ai.run をモックし、呼び出し引数を記録する Ai を作る。本番は stream:true で呼び、
 * 応答を SSE ストリームとして読むため、responder は可視回答の文字列を返し、
 * それを SSE ストリームへ包む。
 */
function mockAi(
  responder: (model: string, options: RunArgs) => Promise<string> = async () =>
    "要約結果",
): { ai: Ai; calls: { model: string; options: RunArgs }[] } {
  const calls: { model: string; options: RunArgs }[] = [];
  const ai = {
    run: (async (model: string, options: RunArgs) => {
      calls.push({ model, options });
      return sseStream(await responder(model, options));
    }) as unknown as Ai["run"],
  } as Ai;
  return { ai, calls };
}

describe("summarizeArticle", () => {
  it("sends a system + user message and returns the trimmed response", async () => {
    const { ai, calls } = mockAi(async () => "  これは要約です。  ");

    const result = await summarizeArticle(ai, "@cf/model", 300, "記事タイトル", "本文");

    expect(result).toBe("これは要約です。");
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("@cf/model");
    expect(calls[0].options.max_tokens).toBe(300);
    expect(calls[0].options.temperature).toBe(0);
    const [system, user] = calls[0].options.messages;
    expect(system.role).toBe("system");
    expect(system.content).toContain("技術ニュースの編集者");
    expect(user.role).toBe("user");
    expect(user.content).toContain("記事タイトル");
    expect(user.content).toContain("本文");
  });

  it("truncates the body excerpt to 20,000 characters in the prompt", async () => {
    const { ai, calls } = mockAi();
    const longBody = "あ".repeat(30000);

    await summarizeArticle(ai, "@cf/model", 300, "t", longBody);

    const user = calls[0].options.messages[1].content;
    // The prompt must not carry the full 30,000-char body.
    expect(user).toContain("あ".repeat(20000));
    expect(user).not.toContain("あ".repeat(20001));
  });

  it("retries the AI call on a transient error and then succeeds", async () => {
    let attempts = 0;
    const ai = {
      run: (async () => {
        attempts += 1;
        if (attempts < 2) {
          throw new Error("transient AI error");
        }
        return sseStream("リトライ後の要約");
      }) as unknown as Ai["run"],
    } as Ai;
    const noSleep = async () => {};

    const result = await summarizeArticle(
      ai,
      "@cf/model",
      300,
      "t",
      "本文",
      noSleep,
    );

    expect(result).toBe("リトライ後の要約");
    expect(attempts).toBe(2);
  });

  it("records a per-attempt metric with finish/content length on success", async () => {
    const { ai } = mockAi(async () => "これは要約です。");
    const metrics: DigestMetric[] = [];

    await summarizeArticle(ai, "@cf/model", 10000, "t", "b", undefined, (m) => {
      metrics.push(m);
    });

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      label: "article",
      model: "@cf/model",
      attempt: 0,
      maxTokens: 10000,
      finishReason: "stop",
      empty: false,
      error: null,
    });
    expect(metrics[0].contentLen).toBeGreaterThan(0);
  });

  it("records an empty metric for every attempt when the model returns no content", async () => {
    // 推論だけで可視回答が空 → 空メトリクス記録＋エラー化してリトライ、を全試行繰り返す。
    const { ai } = mockAi(async () => "");
    const metrics: DigestMetric[] = [];
    const noSleep = async () => {};

    await expect(
      summarizeArticle(ai, "@cf/model", 10000, "t", "b", noSleep, (m) => {
        metrics.push(m);
      }),
    ).rejects.toThrow("empty content");

    // 初回 + リトライ 3 = 4 試行、いずれも空。
    expect(metrics).toHaveLength(4);
    expect(metrics.every((m) => m.empty && m.error === null)).toBe(true);
    expect(metrics.map((m) => m.attempt)).toEqual([0, 1, 2, 3]);
  });

  it("asks for a detailed, factual four-part summary that stands on its own", async () => {
    const { ai, calls } = mockAi();
    await summarizeArticle(ai, "@cf/model", 300, "t", "b");
    const [system] = calls[0].options.messages;
    expect(system.content).toContain("想定対象読者");
    expect(system.content).toContain("全体の要約");
    expect(system.content).toContain("命題");
    expect(system.content).toContain("結論");
    expect(system.content).toContain("記事を読んでいない人");
    expect(system.content).toContain("8〜12文");
    expect(system.content).toContain("背景");
    expect(system.content).toContain("主要な事実");
    expect(system.content).toContain("固有名詞");
    expect(system.content).toContain("人名");
    expect(system.content).toContain("役割");
    expect(system.content).toContain("数値");
    expect(system.content).toContain("推測");
    expect(system.content).toContain("一般論");
    expect(system.content).toContain("将来予測");
    expect(system.content).toContain("本文抜粋");
    expect(system.content).toContain("複数の話題");
    expect(system.content).toContain("一つの命題や結論");
    expect(system.content).toContain("記事の後半");
    expect(system.content).toContain("原文の綴り");
    expect(system.content).toContain("日本語へ置き換えず");
    expect(system.content).toContain("一般論で代替しない");
    expect(system.content).toContain("誰が何を述べたか");
    expect(system.content).toContain("数値や具体例");
    expect(system.content).toContain("記事内に登場する人物");
    expect(system.content).toContain("記事著者自身の見解");
    expect(system.content).toContain("見出しを一字一句変えず");
    expect(system.content).toContain("フェーズ1：原文要約");
    expect(system.content).toContain("原文と同じ言語");
    expect(system.content).toContain("この段階では翻訳しない");
    expect(system.content).toContain("フェーズ2：日本語翻訳");
    expect(system.content).toContain("妥当な日本語訳");
    expect(system.content).toContain("原文のまま");
    expect(system.content.indexOf("フェーズ1：原文要約")).toBeLessThan(
      system.content.indexOf("フェーズ2：日本語翻訳"),
    );
  });
});

describe("summarizeTrend", () => {
  it("summarizes an axis from its top titles and returns the narrative", async () => {
    const { ai, calls } = mockAi(async () => "傾向叙述");

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

describe("summarizeEntries", () => {
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

  const digest = { model: "@cf/model", maxOutputTokens: 300 };

  it("summarizes each target and returns summaries keyed by article id", async () => {
    const { ai } = mockAi(async () => "s");
    const resolveBody = async () => "本文テキスト";

    const { summaries, failed } = await summarizeEntries(
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
      return "s";
    });
    const resolveBody = async () => null;

    const { summaries, failed } = await summarizeEntries(
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
    const { ai } = mockAi(async () => "s");
    const resolveBody = async () => {
      throw new Error("re-fetch failed");
    };

    const { summaries, failed } = await summarizeEntries(
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
      return "ok";
    });
    const resolveBody = async (t: SummaryTarget) => t.title;
    const noSleep = async () => {};

    const { summaries, failed } = await summarizeEntries(
      ai,
      digest,
      [
        target({ articleId: 1, title: "落ちる記事" }),
        target({ articleId: 2, title: "通る記事" }),
      ],
      resolveBody,
      noSleep,
    );

    expect(failed).toBe(1);
    expect(summaries.has(1)).toBe(false);
    expect(summaries.get(2)).toBe("ok");
  });

  it("invokes onSummary per successful entry (persistence hook), not for failed ones", async () => {
    const { ai } = mockAi(async (_m, options) => {
      if (options.messages[1].content.includes("落ちる")) {
        throw new Error("LLM error");
      }
      return "ok";
    });
    const resolveBody = async (t: SummaryTarget) => t.title;
    const noSleep = async () => {};
    const persisted: [number, string][] = [];
    const onSummary = async (articleId: number, summary: string) => {
      persisted.push([articleId, summary]);
    };

    const { failed } = await summarizeEntries(
      ai,
      digest,
      [
        target({ articleId: 1, title: "落ちる記事" }),
        target({ articleId: 2, title: "通る記事" }),
      ],
      resolveBody,
      noSleep,
      onSummary,
    );

    // Only the surviving entry is persisted; the failed one never reaches onSummary.
    expect(failed).toBe(1);
    expect(persisted).toEqual([[2, "ok"]]);
  });

  it("counts an entry as failed when onSummary (persistence) throws, and keeps going", async () => {
    const { ai } = mockAi(async () => "ok");
    const resolveBody = async (t: SummaryTarget) => t.title;
    const noSleep = async () => {};
    const onSummary = async (articleId: number) => {
      if (articleId === 1) throw new Error("D1 write failed");
    };

    const { summaries, failed } = await summarizeEntries(
      ai,
      digest,
      [target({ articleId: 1 }), target({ articleId: 2 })],
      resolveBody,
      noSleep,
      onSummary,
    );

    expect(failed).toBe(1);
    expect(summaries.has(1)).toBe(false);
    expect(summaries.get(2)).toBe("ok");
  });
});
