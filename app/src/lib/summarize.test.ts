import { describe, it, expect, vi } from "vitest";
import {
  summarizeArticle,
  summarizeTrend,
  summarizeEntries,
  type SummaryTarget,
} from "./summarize";
import { sseStream } from "../../test/sse";
import type { DigestMetric } from "./summarize";
import { decodeSummary, parseStructuredSummary } from "./summarize";

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

    expect(decodeSummary(result)).toEqual({ raw: "これは要約です。" });
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

    expect(decodeSummary(result)).toEqual({ raw: "リトライ後の要約" });
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
      0,
    );

    expect(failed).toBe(0);
    expect(decodeSummary(summaries.get(1)!)).toEqual({ raw: "s" });
    expect(decodeSummary(summaries.get(2)!)).toEqual({ raw: "s" });
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
      0,
    );

    expect(failed).toBe(0);
    expect(decodeSummary(summaries.get(1)!)).toEqual({ raw: "s" });
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
      0,
    );

    expect(failed).toBe(0);
    expect(decodeSummary(summaries.get(1)!)).toEqual({ raw: "s" });
    expect(decodeSummary(summaries.get(2)!)).toEqual({ raw: "s" });
  });

  it("skips an entry whose resolved text is below the minimum body length (no LLM, no summary)", async () => {
    const { ai, calls } = mockAi(async () => "s");
    const resolveBody = async () => "短い抜粋"; // below the threshold
    const onSummary = vi.fn(async () => {});

    const { summaries, failed } = await summarizeEntries(
      ai,
      digest,
      [target({ articleId: 1, feedSummary: null })],
      resolveBody,
      500,
      undefined,
      onSummary,
    );

    // Degenerate summaries are suppressed: the LLM is never called and no row is produced.
    expect(calls).toHaveLength(0);
    expect(onSummary).not.toHaveBeenCalled();
    expect(summaries.size).toBe(0);
    expect(failed).toBe(0); // skipped, not failed
  });

  it("skips an entry when no text is available at all (body null, no feedSummary)", async () => {
    const { ai, calls } = mockAi(async () => "s");

    const { summaries, failed } = await summarizeEntries(
      ai,
      digest,
      [target({ articleId: 1, feedSummary: null })],
      async () => null,
      500,
    );

    expect(calls).toHaveLength(0);
    expect(summaries.size).toBe(0);
    expect(failed).toBe(0);
  });

  it("summarizes an entry whose resolved body meets the minimum length", async () => {
    const { ai, calls } = mockAi(async () => "s");
    const body = "本文".repeat(300); // ≥ 500 chars

    const { summaries, failed } = await summarizeEntries(
      ai,
      digest,
      [target({ articleId: 1 })],
      async () => body,
      500,
    );

    expect(calls).toHaveLength(1);
    expect(decodeSummary(summaries.get(1)!)).toEqual({ raw: "s" });
    expect(failed).toBe(0);
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
      0,
      noSleep,
    );

    expect(failed).toBe(1);
    expect(summaries.has(1)).toBe(false);
    expect(decodeSummary(summaries.get(2)!)).toEqual({ raw: "ok" });
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
      0,
      noSleep,
      onSummary,
    );

    // Only the surviving entry is persisted; the failed one never reaches onSummary.
    expect(failed).toBe(1);
    expect(persisted.map(([id, sm]) => [id, decodeSummary(sm)])).toEqual([
      [2, { raw: "ok" }],
    ]);
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
      0,
      noSleep,
      onSummary,
    );

    expect(failed).toBe(1);
    expect(summaries.has(1)).toBe(false);
    expect(decodeSummary(summaries.get(2)!)).toEqual({ raw: "ok" });
  });
});

describe("parseStructuredSummary", () => {
  const FOUR = [
    "・想定対象読者：技術者向け",
    "・全体の要約：AとBが議論された。CはDと述べた。",
    "・命題：統一的な命題は明示されていない",
    "・結論：統一的な結論は明示されていない",
  ].join("\n");

  it("splits the fixed four headings into fields", () => {
    expect(parseStructuredSummary(FOUR)).toEqual({
      audience: "技術者向け",
      overview: "AとBが議論された。CはDと述べた。",
      thesis: "統一的な命題は明示されていない",
      conclusion: "統一的な結論は明示されていない",
    });
  });

  it("tolerates a missing 「・」 bullet and half-width colon", () => {
    const noBullet =
      "想定対象読者:読者\n全体の要約:ようやく\n命題:めいだい\n結論:けつろん";
    expect(parseStructuredSummary(noBullet)).toEqual({
      audience: "読者",
      overview: "ようやく",
      thesis: "めいだい",
      conclusion: "けつろん",
    });
  });

  it("returns null when a heading is missing (falls back to raw)", () => {
    const missing = "・想定対象読者：x\n・全体の要約：y\n・結論：z";
    expect(parseStructuredSummary(missing)).toBeNull();
  });
});

describe("summarizeArticle structured output", () => {
  it("stores the four-part summary as decodable structured sections", async () => {
    const four = [
      "・想定対象読者：エンジニア",
      "・全体の要約：本文の主旨。",
      "・命題：主張X",
      "・結論：結論Y",
    ].join("\n");
    const { ai } = mockAi(async () => four);

    const result = await summarizeArticle(ai, "@cf/model", 4000, "t", "b");

    expect(decodeSummary(result)).toEqual({
      sections: {
        audience: "エンジニア",
        overview: "本文の主旨。",
        thesis: "主張X",
        conclusion: "結論Y",
      },
    });
  });
});

describe("decodeSummary", () => {
  it("structures a legacy plain-text summary (no JSON) into sections", () => {
    const legacy = [
      "・想定対象読者：読者",
      "・全体の要約：ようやく",
      "・命題：めいだい",
      "・結論：けつろん",
    ].join("\n");
    expect(decodeSummary(legacy)).toEqual({
      sections: {
        audience: "読者",
        overview: "ようやく",
        thesis: "めいだい",
        conclusion: "けつろん",
      },
    });
  });

  it("keeps unparseable text as raw", () => {
    expect(decodeSummary("ただの一文です")).toEqual({ raw: "ただの一文です" });
  });
});
