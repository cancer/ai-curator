import { describe, it, expect, vi } from "vitest";
import {
  summarizeArticle,
  summarizeTrend,
  summarizeEntries,
  type SummaryTarget,
} from "./summarize";
import { sseStream } from "../../test/sse";
import type { DigestMetric } from "./summarize";
import { decodeSummary, encodeSummary, parseStructuredSummary } from "./summarize";

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
  // メイン要約は system に「フェーズ1」、前提知識は「前提知識」を含むので、その有無で
  // 2 回の呼び出しを区別する（実行順に依存しない）。
  const articleCall = (calls: { model: string; options: RunArgs }[]) =>
    calls.find((c) => c.options.messages[0].content.includes("フェーズ1"))!;
  const backgroundCall = (calls: { model: string; options: RunArgs }[]) =>
    calls.find((c) => c.options.messages[0].content.includes("前提知識"))!;

  it("makes two calls (main summary + background) and returns the trimmed response", async () => {
    const { ai, calls } = mockAi(async () => "  これは要約です。  ");

    const result = await summarizeArticle(ai, "@cf/model", 300, "記事タイトル", "本文");

    // メイン要約が 4 見出しでない → raw 保持、前提知識は破棄される。
    expect(decodeSummary(result)).toEqual({ raw: "これは要約です。" });
    // 要約本体＋前提知識で 2 回呼ぶ。
    expect(calls).toHaveLength(2);
    const article = articleCall(calls);
    expect(article.model).toBe("@cf/model");
    expect(article.options.max_tokens).toBe(300);
    expect(article.options.temperature).toBe(0);
    const [system, user] = article.options.messages;
    expect(system.role).toBe("system");
    expect(system.content).toContain("技術ニュースの編集者");
    expect(user.role).toBe("user");
    expect(user.content).toContain("記事タイトル");
    expect(user.content).toContain("本文");
  });

  it("merges the separately generated background into the stored summary", async () => {
    const four = [
      "・想定対象読者：エンジニア",
      "・全体の要約：本文の主旨。",
      "・著者の主張：主張X",
      "・結論：結論Y",
    ].join("\n");
    const { ai } = mockAi(async (_m, options) =>
      options.messages[0].content.includes("前提知識")
        ? "分散システムの基礎知識。"
        : four,
    );

    const result = await summarizeArticle(ai, "@cf/model", 4000, "t", "b");

    expect(decodeSummary(result)).toEqual({
      sections: {
        audience: "エンジニア",
        background: "分散システムの基礎知識。",
        overview: "本文の主旨。",
        claims: "主張X",
        conclusion: "結論Y",
      },
    });
  });

  it("keeps the summary (background empty) when background generation fails", async () => {
    const four = [
      "・想定対象読者：エンジニア",
      "・全体の要約：本文の主旨。",
      "・著者の主張：主張X",
      "・結論：結論Y",
    ].join("\n");
    const ai = {
      run: (async (_m: string, options: RunArgs) => {
        if (options.messages[0].content.includes("前提知識")) {
          throw new Error("background LLM error");
        }
        return sseStream(four);
      }) as unknown as Ai["run"],
    } as Ai;
    const noSleep = async () => {};

    const result = await summarizeArticle(ai, "@cf/model", 4000, "t", "b", noSleep);

    // 前提知識が全リトライ失敗しても要約本体は保存され、background だけ空になる。
    expect(decodeSummary(result)).toEqual({
      sections: {
        audience: "エンジニア",
        background: "",
        overview: "本文の主旨。",
        claims: "主張X",
        conclusion: "結論Y",
      },
    });
  });

  it("truncates the main body excerpt to 20,000 characters in the prompt", async () => {
    const { ai, calls } = mockAi();
    const longBody = "あ".repeat(30000);

    await summarizeArticle(ai, "@cf/model", 300, "t", longBody);

    const user = articleCall(calls).options.messages[1].content;
    // The main prompt must not carry the full 30,000-char body.
    expect(user).toContain("あ".repeat(20000));
    expect(user).not.toContain("あ".repeat(20001));
  });

  it("uses a shorter body excerpt for the background call to save tokens", async () => {
    const { ai, calls } = mockAi();
    const longBody = "あ".repeat(30000);

    await summarizeArticle(ai, "@cf/model", 300, "t", longBody);

    const user = backgroundCall(calls).options.messages[1].content;
    // 前提知識はテーマ把握が目的で本文全体は不要 → メインより短い抜粋。
    expect(user).toContain("あ".repeat(4000));
    expect(user).not.toContain("あ".repeat(4001));
  });

  it("retries the main AI call on a transient error and then succeeds", async () => {
    let articleAttempts = 0;
    const ai = {
      run: (async (_m: string, options: RunArgs) => {
        if (options.messages[0].content.includes("前提知識")) {
          return sseStream("背景");
        }
        articleAttempts += 1;
        if (articleAttempts < 2) {
          throw new Error("transient AI error");
        }
        return sseStream("リトライ後の要約");
      }) as unknown as Ai["run"],
    } as Ai;
    const noSleep = async () => {};

    const result = await summarizeArticle(ai, "@cf/model", 300, "t", "本文", noSleep);

    expect(decodeSummary(result)).toEqual({ raw: "リトライ後の要約" });
    expect(articleAttempts).toBe(2);
  });

  it("records a per-attempt metric with finish/content length on success", async () => {
    const { ai } = mockAi(async () => "これは要約です。");
    const metrics: DigestMetric[] = [];

    await summarizeArticle(ai, "@cf/model", 10000, "t", "b", undefined, (m) => {
      metrics.push(m);
    });

    // メイン要約と前提知識でそれぞれ 1 件記録する。
    const article = metrics.filter((m) => m.label === "article");
    const background = metrics.filter((m) => m.label === "background");
    expect(article).toHaveLength(1);
    expect(background).toHaveLength(1);
    expect(article[0]).toMatchObject({
      label: "article",
      model: "@cf/model",
      attempt: 0,
      maxTokens: 10000,
      finishReason: "stop",
      empty: false,
      error: null,
    });
    expect(article[0].contentLen).toBeGreaterThan(0);
  });

  it("records an empty metric for every attempt when the model returns no content", async () => {
    // 推論だけで可視回答が空 → 空メトリクス記録＋エラー化してリトライ、を全試行繰り返す。
    // メイン要約が全試行空で失敗すると前提知識まで進まないので、metric はメイン 4 件のみ。
    const { ai } = mockAi(async () => "");
    const metrics: DigestMetric[] = [];
    const noSleep = async () => {};

    await expect(
      summarizeArticle(ai, "@cf/model", 10000, "t", "b", noSleep, (m) => {
        metrics.push(m);
      }),
    ).rejects.toThrow("empty content");

    // 初回 + リトライ 3 = 4 試行、いずれも空。すべてメイン要約（article）。
    expect(metrics).toHaveLength(4);
    expect(
      metrics.every((m) => m.empty && m.error === null && m.label === "article"),
    ).toBe(true);
    expect(metrics.map((m) => m.attempt)).toEqual([0, 1, 2, 3]);
  });

  it("asks the main call for a detailed, factual four-part summary that stands on its own", async () => {
    const { ai, calls } = mockAi();
    await summarizeArticle(ai, "@cf/model", 300, "t", "b");
    const system = articleCall(calls).options.messages[0].content;
    expect(system).toContain("想定対象読者");
    expect(system).toContain("全体の要約");
    expect(system).toContain("著者の主張");
    expect(system).toContain("結論");
    // 本文由来は 4 項目。前提知識は別呼び出しなのでメインの見出しには含めない。
    expect(system).toContain("以下の4項目");
    expect(system).not.toContain("・前提知識：");
    expect(system).not.toContain("・命題：");
    expect(system).toContain("記事を読んでいない人");
    expect(system).toContain("8〜12文");
    expect(system).toContain("背景");
    expect(system).toContain("主要な事実");
    expect(system).toContain("固有名詞");
    expect(system).toContain("人名");
    expect(system).toContain("役割");
    expect(system).toContain("数値");
    expect(system).toContain("推測");
    expect(system).toContain("一般論");
    expect(system).toContain("将来予測");
    expect(system).toContain("本文抜粋");
    expect(system).toContain("複数の話題");
    expect(system).toContain("一つの主張や結論");
    expect(system).toContain("記事の後半");
    expect(system).toContain("原文の綴り");
    expect(system).toContain("日本語へ置き換えず");
    expect(system).toContain("一般論で代替しない");
    expect(system).toContain("誰が何を述べたか");
    expect(system).toContain("数値や具体例");
    expect(system).toContain("記事内に登場する人物");
    expect(system).toContain("記事著者自身の見解");
    expect(system).toContain("見出しを一字一句変えず");
    expect(system).toContain("著者自身の主張は明示されていない");
    expect(system).toContain("フェーズ1：原文要約");
    expect(system).toContain("原文と同じ言語");
    expect(system).toContain("この段階では翻訳しない");
    expect(system).toContain("フェーズ2：日本語翻訳");
    expect(system).toContain("妥当な日本語訳");
    expect(system).toContain("原文のまま");
    expect(system.indexOf("フェーズ1：原文要約")).toBeLessThan(
      system.indexOf("フェーズ2：日本語翻訳"),
    );
  });

  it("asks the background call to explain prerequisites from general knowledge", async () => {
    const { ai, calls } = mockAi();
    await summarizeArticle(ai, "@cf/model", 300, "t", "b");
    const system = backgroundCall(calls).options.messages[0].content;
    expect(system).toContain("前提知識");
    // この項目だけ本文外の一般知識を使ってよい例外である旨。
    expect(system).toContain("一般知識");
    expect(system).toContain("2〜4文");
    // 記事そのものの要約・結論・著者の主張は書かせない。
    expect(system).toContain("要約や");
    expect(system).toContain("著者の主張は書かない");
    expect(system).toContain("見出しや箇条書きは付けず");
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

    // 1 記事につきメイン要約＋前提知識で 2 回呼ぶ。
    expect(calls).toHaveLength(2);
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
  // メイン要約は本文由来の 4 項目のみ（前提知識は別呼び出しで生成しマージするため、
  // メイン出力のパース対象には含めない）。
  const FOUR = [
    "・想定対象読者：技術者向け",
    "・全体の要約：AとBが議論された。CはDと述べた。",
    "・著者の主張：著者自身の主張は明示されていない",
    "・結論：統一的な結論は明示されていない",
  ].join("\n");

  it("splits the fixed four body headings into fields", () => {
    expect(parseStructuredSummary(FOUR)).toEqual({
      audience: "技術者向け",
      overview: "AとBが議論された。CはDと述べた。",
      claims: "著者自身の主張は明示されていない",
      conclusion: "統一的な結論は明示されていない",
    });
  });

  it("tolerates a missing 「・」 bullet and half-width colon", () => {
    const noBullet =
      "想定対象読者:読者\n全体の要約:ようやく\n著者の主張:しゅちょう\n結論:けつろん";
    expect(parseStructuredSummary(noBullet)).toEqual({
      audience: "読者",
      overview: "ようやく",
      claims: "しゅちょう",
      conclusion: "けつろん",
    });
  });

  it("returns null when a heading is missing (falls back to raw)", () => {
    const missing = "・想定対象読者：x\n・全体の要約：y";
    expect(parseStructuredSummary(missing)).toBeNull();
  });
});

describe("encodeSummary", () => {
  it("merges a 4-heading main output and a separate background into decodable sections", () => {
    const four = [
      "・想定対象読者：エンジニア",
      "・全体の要約：本文の主旨。",
      "・著者の主張：主張X",
      "・結論：結論Y",
    ].join("\n");
    const result = encodeSummary(four, "  背景Z  ");

    expect(decodeSummary(result)).toEqual({
      sections: {
        audience: "エンジニア",
        background: "背景Z", // 前後の空白は trim される
        overview: "本文の主旨。",
        claims: "主張X",
        conclusion: "結論Y",
      },
    });
  });

  it("keeps raw (dropping background) when the main output is not 4-heading structured", () => {
    const result = encodeSummary("ただの一文です", "背景Z");
    expect(decodeSummary(result)).toEqual({ raw: "ただの一文です" });
  });
});

describe("decodeSummary", () => {
  it("structures a plain-text summary (no JSON) into body sections with empty background", () => {
    // プレーン行（非 JSON）は本文 4 項目のみ。前提知識は JSON 保存分にしか無いので空で補う。
    const legacy = [
      "・想定対象読者：読者",
      "・全体の要約：ようやく",
      "・著者の主張：しゅちょう",
      "・結論：けつろん",
    ].join("\n");
    expect(decodeSummary(legacy)).toEqual({
      sections: {
        audience: "読者",
        background: "",
        overview: "ようやく",
        claims: "しゅちょう",
        conclusion: "けつろん",
      },
    });
  });

  it("reads a legacy JSON row (thesis key) into claims, keeping background empty", () => {
    // 旧スキーマの保存行（前提知識なし・命題=thesis キー）も欠落なく描画できること。
    const legacyJson = JSON.stringify({
      v: 1,
      audience: "読者",
      overview: "ようやく",
      thesis: "きゅうめいだい",
      conclusion: "けつろん",
    });
    expect(decodeSummary(legacyJson)).toEqual({
      sections: {
        audience: "読者",
        background: "",
        overview: "ようやく",
        claims: "きゅうめいだい",
        conclusion: "けつろん",
      },
    });
  });

  it("keeps unparseable text as raw", () => {
    expect(decodeSummary("ただの一文です")).toEqual({ raw: "ただの一文です" });
  });
});
