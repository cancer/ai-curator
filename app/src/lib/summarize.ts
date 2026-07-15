/**
 * LLM による記事要約と軸別の傾向叙述（Cron B の上位要約ステップ）。
 *
 * 生成物（要約・叙述）は自前生成のため保存してよい。記事本文(body)は
 * ここでも一時データで、プロンプトに載せるのみ・D1 やログに書かない。
 *
 * digest モデルはハードコードせず config.digest.model を使う。
 * 注意: llama-3.2-3b-instruct は日本語品質が不十分なため既定候補にはしない
 * （モデル選定は運用時の人手比較=タスク10 で行う）。
 */

import type { DigestConfig } from "../config";

/**
 * 記事要約の 4 項目。LLM は固定見出し（想定対象読者／全体の要約／命題／結論）で
 * プレーンテキストを返すが、ビューアが見出しごとに整形できるよう、生成時にこの構造へ
 * パースして JSON で保存する（summaries.text）。パースできない出力（見出し欠落など）は
 * raw に丸ごと入れて欠落させない。旧プレーン行は JSON でないので decode 側で raw 扱いにする。
 */
export interface StructuredSummary {
  audience: string;
  overview: string;
  thesis: string;
  conclusion: string;
}

/** summaries.text に入れる JSON の形。構造化できた場合と、できなかった raw の 2 系統。 */
type StoredSummary =
  | ({ v: 1 } & StructuredSummary)
  | { v: 1; raw: string };

/** 見出しキー → 表示ラベル。パースと描画の単一の情報源。順序が本文中の出現順。 */
export const SUMMARY_SECTIONS: { key: keyof StructuredSummary; label: string }[] =
  [
    { key: "audience", label: "想定対象読者" },
    { key: "overview", label: "全体の要約" },
    { key: "thesis", label: "命題" },
    { key: "conclusion", label: "結論" },
  ];

/**
 * 固定見出しのプレーンテキストを 4 項目へパースする。見出しは順番に現れる前提で、
 * 直前の見出し以降から次の見出しを探す（本文中に紛れた同語を誤検出しない）。全項目が
 * 順序どおり見つからなければ null（=構造化失敗、raw 扱い）。見出しは全角「：」半角「:」
 * どちらでも、先頭の「・」有無も許容する。
 */
export function parseStructuredSummary(text: string): StructuredSummary | null {
  const starts: number[] = [];
  const valueFrom: number[] = [];
  let searchFrom = 0;
  for (const { label } of SUMMARY_SECTIONS) {
    let sep = `${label}：`;
    let idx = text.indexOf(sep, searchFrom);
    if (idx < 0) {
      sep = `${label}:`;
      idx = text.indexOf(sep, searchFrom);
    }
    if (idx < 0) return null;
    starts.push(idx);
    valueFrom.push(idx + sep.length);
    searchFrom = idx + sep.length;
  }

  const result = {} as StructuredSummary;
  for (let i = 0; i < SUMMARY_SECTIONS.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : text.length;
    // 次の見出し行の先頭に付く「・」や改行・空白を値から落とす。
    const value = text
      .slice(valueFrom[i], end)
      .replace(/[・\s]+$/u, "")
      .trim();
    result[SUMMARY_SECTIONS[i].key] = value;
  }
  return result;
}

/** LLM 生出力を保存用 JSON へ変換する。構造化できなければ raw で保持。 */
export function encodeSummary(rawText: string): string {
  const parsed = parseStructuredSummary(rawText);
  const stored: StoredSummary = parsed
    ? { v: 1, ...parsed }
    : { v: 1, raw: rawText };
  return JSON.stringify(stored);
}

/**
 * 保存文字列を描画用に復元する。JSON なら構造化 or raw、JSON でなければ（旧プレーン行）
 * その文字列を raw として返す。ビューアはこの結果だけを見ればよい。
 */
export function decodeSummary(
  stored: string,
): { sections: StructuredSummary } | { raw: string } {
  // raw テキストは、旧プレーン行（見出し付き 4 項目のことが多い）でも構造化できるよう
  // パースを試み、失敗したときだけ raw のまま返す。これで新規保存分だけでなく既存行も
  // 見出し付きで整形される。
  const fromRaw = (raw: string): { sections: StructuredSummary } | { raw: string } => {
    const parsed = parseStructuredSummary(raw);
    return parsed ? { sections: parsed } : { raw };
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return fromRaw(stored); // 旧プレーンテキスト行
  }
  const p = parsed as Partial<StoredSummary> & Record<string, unknown>;
  if (p && p.v === 1 && typeof p.audience === "string") {
    return {
      sections: {
        audience: String(p.audience),
        overview: String((p as StructuredSummary).overview ?? ""),
        thesis: String((p as StructuredSummary).thesis ?? ""),
        conclusion: String((p as StructuredSummary).conclusion ?? ""),
      },
    };
  }
  if (p && p.v === 1 && typeof p.raw === "string") {
    return fromRaw(p.raw);
  }
  return fromRaw(stored);
}

/**
 * digest 生成 1 試行分の観測メトリクス（リトライ各回・失敗も含む）。永続化先は
 * 呼び出し側が決める（パイプラインでは D1 digest_metrics へ）。本文・生成テキスト
 * そのものは持たない。
 */
export interface DigestMetric {
  /** 'article' | 'trend' などの用途ラベル。 */
  label: string;
  model: string;
  /** 0 起点の試行番号。 */
  attempt: number;
  /** その試行の所要ミリ秒。 */
  ms: number;
  /** 'stop' / 'length' など。エラー時は null。 */
  finishReason: string | null;
  /** 推論＋回答の合計トークン（取得できた場合）。 */
  completionTokens: number | null;
  maxTokens: number;
  /** 可視回答の文字数（0 = 空）。 */
  contentLen: number;
  empty: boolean;
  /** 例外時のメッセージ（先頭 200 字）。正常時は null。 */
  error: string | null;
}

/** メトリクス永続化フック。観測が生成本体を壊さないよう、例外は呼ばれ側で握り潰す。 */
export type OnDigestMetric = (metric: DigestMetric) => Promise<void> | void;

/** プロンプトに載せる本文抜粋の最大文字数（24k context に収まる保守値）。 */
const BODY_EXCERPT_CHARS = 20000;

/** 初期試行の後の最大リトライ回数（計 4 試行、バックオフ 1s → 2s → 4s）。 */
const MAX_RETRIES = 3;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const ARTICLE_SYSTEM =
  "あなたは技術ニュースの編集者です。入力は記事のタイトルと本文抜粋であり、本文全体ではない可能性があります。" +
  "必ず与えられた本文抜粋の範囲だけに基づき、次の2フェーズを順番どおりに行ってください。\n\n" +
  "フェーズ1：原文要約\n" +
  "原文と同じ言語で、記事を読んでいない人にも重要な内容と話の流れが分かる要約案を作ってください。この段階では翻訳しないでください。" +
  "本文で確認できる固有名詞、数値、背景、主要な事実、因果関係を可能な限り残し、特に重要な人名、組織名、製品名、役割、数値は省略しないでください。" +
  "誰が何を述べたかという帰属を変えず、引用・紹介された人物の主張と記事著者自身の見解を区別し、重要な数値や具体例も残してください。" +
  "本文にない情報を補ったり推測したりせず、評価、一般論、将来予測も本文に明記されたものだけを記述してください。" +
  "複数の話題を扱う記事を無理に一つの命題や結論へ統合せず、記事の後半を含む主要な話題を最初から最後まで確認してください。\n\n" +
  "フェーズ2：日本語翻訳\n" +
  "フェーズ1の要約案だけを日本語へ翻訳してください。意味・帰属・固有名詞・数値・話題の数を変更、追加、削除しないでください。" +
  "専門用語は妥当な日本語訳に確信がある場合だけ翻訳し、見つからない場合は日本語へ置き換えず原文のまま（原文の綴りを維持して）残してください。\n\n" +
  "フェーズ1の要約案や作業過程は出力せず、フェーズ2の結果だけを以下の4項目で出力してください。" +
  "次の見出しを一字一句変えず、各見出しから書き始めてください。\n" +
  "・想定対象読者：必ず1文。必要な前提知識や関心分野だけを示し、記事内に登場する人物を対象読者とみなさない\n" +
  "・全体の要約：8〜12文。主要な話題を入力順に漏らさず、一つの話題へ偏る前に全話題を扱い、発言者、数値や具体例、議論、結果・影響の関係が分かるようにまとめる\n" +
  "・命題：1〜2文。本文で明示された中心的な論点や主張を示す。単一の命題がなければ、必ず『統一的な命題は明示されていない』と書き、一般論で代替しない\n" +
  "・結論：1〜2文。本文が明示する結論、成果、方針、今後の見通しだけを示す。統一的な結論がなければ、必ず『統一的な結論は明示されていない』と書き、本文外の総括を加えない";

const TREND_SYSTEM =
  "あなたは技術ニュースの編集者です。ある関心テーマについて、当日の記事タイトル一覧から、" +
  "その日の技術的な傾向を 1〜2 文の日本語で簡潔に叙述してください。" +
  "誇張や主観的評価を避けてください。";

/**
 * SSE ストリームから最終回答テキストだけを取り出す。
 *
 * digest モデルは推論モデルなので、可視回答の前に推論トークンを生成する。同期 AI.run
 * だと推論生成が長引くと ~60s ゲートウェイに達し 504 になりうるため stream:true で呼ぶ
 * （最初のバイトがすぐ流れて接続が維持される）。返却は行区切りの SSE で、各データ行は
 * JSON。可視回答は response（従来形式）または choices[0].delta.content（OpenAI 互換形式）に
 * 入る。delta.reasoning（推論チャンク）は要約に含めない。
 */
/** ストリーム消費の結果。content 以外は観測用メタ（finish_reason・使用トークン）。 */
interface StreamedGeneration {
  content: string;
  finishReason: string | null;
  completionTokens: number | null;
}

async function collectStreamedContent(
  stream: ReadableStream<Uint8Array>,
): Promise<StreamedGeneration> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason: string | null = null;
  let completionTokens: number | null = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice("data:".length).trim();
        if (data === "" || data === "[DONE]") continue;

        let chunk: unknown;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue; // keepalive など非 JSON 行は読み飛ばす
        }
        const c = chunk as {
          response?: unknown;
          choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[];
          usage?: { completion_tokens?: unknown };
        };
        // 可視回答は response（従来形式）と choices[].delta.content（OpenAI 互換形式）の
        // どちらかに入る。モデルによっては 1 チャンクに両方同じデルタが載るため、
        // 両方を足すと二重化する（Qwen3 で観測）。非空の response を優先し、無ければ
        // choices 側を使う（どちらか一方だけ加算する）。
        const deltaContent = c.choices?.[0]?.delta?.content;
        if (typeof c.response === "string" && c.response !== "") {
          content += c.response;
        } else if (typeof deltaContent === "string") {
          content += deltaContent;
        }
        const fr = c.choices?.[0]?.finish_reason;
        if (typeof fr === "string") finishReason = fr;
        const ct = c.usage?.completion_tokens;
        if (typeof ct === "number") completionTokens = ct;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { content, finishReason, completionTokens };
}

/**
 * ai.run をストリーミング＋リトライ付きで呼ぶ。AI バインディングは一時エラーで
 * 例外を投げることがある（PoC 実測）ため、例外時は指数バックオフ（1s → 2s → 4s）で
 * 最大 MAX_RETRIES 回まで再試行する。embedding.ts の aiCallWithRetry と同方針。
 * sleep はテストで実時間を待たないよう注入可能にする。
 *
 * 推論モデルは推論だけで上限に達し可視回答が空になることがある（finish_reason
 * =length）。空回答は成功として保存せず、エラー扱いにしてリトライ・最終的に呼び出し
 * 側（summarizeEntries）の失敗計上へ委ねる。
 *
 * 観測: 試行ごとに finish_reason・completion_tokens・content 長・所要時間を
 * onMetric へ渡す（パイプラインでは D1 digest_metrics に保存）。推論モデルの生成量は
 * run 間で大きくぶれるため、実運用ログから max_tokens の適値と暴走頻度を判断するのが
 * 目的。本文・生成テキストそのものは渡さない。onMetric の例外は握り潰す（観測が生成
 * 本体を壊さないため）。
 */
async function recordMetric(
  onMetric: OnDigestMetric | undefined,
  metric: DigestMetric,
): Promise<void> {
  if (!onMetric) return;
  try {
    await onMetric(metric);
  } catch {
    // 観測の失敗は生成の失敗にしない。
  }
}

async function runTextGeneration(
  ai: Ai,
  model: string,
  maxTokens: number,
  system: string,
  user: string,
  label: string,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  onMetric?: OnDigestMetric,
): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const startedAt = Date.now();
    try {
      const stream = (await ai.run(model, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: maxTokens,
        temperature: 0,
        stream: true,
      })) as unknown as ReadableStream<Uint8Array>;

      const { content, finishReason, completionTokens } =
        await collectStreamedContent(stream);
      const trimmed = content.trim();
      await recordMetric(onMetric, {
        label,
        model,
        attempt,
        ms: Date.now() - startedAt,
        finishReason,
        completionTokens,
        maxTokens,
        contentLen: trimmed.length,
        empty: trimmed === "",
        error: null,
      });
      if (trimmed === "") {
        throw new Error(
          "text generation returned empty content " +
            "(reasoning-only output or length cutoff before the final answer)",
        );
      }
      return trimmed;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // 空回答（上の throw）は直前に成功パスのメトリクスを記録済みなので、ここでは
      // ストリーム取得自体が失敗した場合だけメトリクスを追加する（二重記録を避ける）。
      if (lastError.message.indexOf("empty content") === -1) {
        await recordMetric(onMetric, {
          label,
          model,
          attempt,
          ms: Date.now() - startedAt,
          finishReason: null,
          completionTokens: null,
          maxTokens,
          contentLen: 0,
          empty: true,
          error: lastError.message.slice(0, 200),
        });
      }
      if (attempt < MAX_RETRIES) {
        await sleep(Math.pow(2, attempt) * 1000);
      }
    }
  }

  throw lastError ?? new Error("text generation failed");
}

/** 1 記事の要約。本文抜粋は先頭 BODY_EXCERPT_CHARS 字に切り詰める。 */
export async function summarizeArticle(
  ai: Ai,
  model: string,
  maxTokens: number,
  title: string,
  body: string,
  sleep?: (ms: number) => Promise<void>,
  onMetric?: OnDigestMetric,
): Promise<string> {
  const excerpt = body.slice(0, BODY_EXCERPT_CHARS);
  const user = `タイトル: ${title}\n\n本文抜粋:\n${excerpt}`;
  const raw = await runTextGeneration(
    ai,
    model,
    maxTokens,
    ARTICLE_SYSTEM,
    user,
    "article",
    sleep,
    onMetric,
  );
  // 4 項目へ構造化して保存する（ビューアが見出しごとに整形できるように）。
  return encodeSummary(raw);
}

/** 1 軸の傾向叙述。その軸のタイトル上位群を入力にする。 */
export function summarizeTrend(
  ai: Ai,
  model: string,
  maxTokens: number,
  axisLabel: string,
  titles: string[],
  sleep?: (ms: number) => Promise<void>,
): Promise<string> {
  const user = `テーマ: ${axisLabel}\n\n本日の記事タイトル:\n${titles.join("\n")}`;
  return runTextGeneration(ai, model, maxTokens, TREND_SYSTEM, user, "trend", sleep);
}

/** 要約対象。本文は source/url から再取得する（resolveBody に委譲）。 */
export interface SummaryTarget {
  articleId: number;
  title: string;
  source: string;
  url: string;
  feedSummary: string | null;
}

export interface SummarizeResult {
  /** article_id → 生成要約。 */
  summaries: Map<number, string>;
  /** 要約に失敗して除外した件数。 */
  failed: number;
}

/**
 * フィード対象エントリを要約する（全件。上位 N 件で絞らない）。各エントリで
 * 本文を resolveBody で解決し、取得できなければ feedSummary にフォールバック
 * する。1 件の要約失敗は try/catch で除外し件数を数えて、ループは止めない。
 *
 * minBodyChars: 解決した本文（body ?? feedSummary）が閾値未満なら LLM を呼ばず、onSummary も
 * 呼ばず、summaries にも入れない。スニペット/空からの退化要約を抑止するためのスキップで、
 * 失敗（failed）とは別に数える（そのエントリは要約なしで、ビューアが省略する）。
 *
 * onSummary を渡すと、1 件を要約できた直後に呼ぶ（永続化フック）。呼び出し側が
 * 「要約→即保存」を per-entry で行い部分進捗を残せるようにするためで、保存の失敗は
 * その 1 件の失敗として扱い（failed に計上）ループは続ける。
 */
export async function summarizeEntries(
  ai: Ai,
  digest: DigestConfig,
  targets: SummaryTarget[],
  resolveBody: (target: SummaryTarget) => Promise<string | null>,
  minBodyChars: number,
  sleep?: (ms: number) => Promise<void>,
  onSummary?: (articleId: number, summary: string) => Promise<void>,
  onMetric?: OnDigestMetric,
): Promise<SummarizeResult> {
  const summaries = new Map<number, string>();
  let failed = 0;
  let skipped = 0;

  for (const target of targets) {
    try {
      let body: string | null = null;
      try {
        body = await resolveBody(target);
      } catch (err) {
        console.warn(
          `summarize: body re-fetch failed for article ${target.articleId}; ` +
            `falling back to feedSummary: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const text = body ?? target.feedSummary ?? "";
      // 退化要約の抑止: 本文が閾値未満（スニペット・空を含む）なら要約を作らない。
      // LLM も onSummary も呼ばず、summaries に入れない（failed ではなくスキップ）。
      if (text.length < minBodyChars) {
        skipped += 1;
        continue;
      }
      const summary = await summarizeArticle(
        ai,
        digest.model,
        digest.maxOutputTokens,
        target.title,
        text,
        sleep,
        onMetric,
      );
      if (onSummary) {
        await onSummary(target.articleId, summary);
      }
      summaries.set(target.articleId, summary);
    } catch (err) {
      failed += 1;
      console.warn(
        `summarize: skipped article ${target.articleId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (skipped > 0) {
    console.log(
      `summarize: ${skipped} entr(ies) skipped (body below ${minBodyChars} chars)`,
    );
  }
  if (failed > 0) {
    console.log(`summarize: ${failed} entr(ies) excluded due to errors`);
  }
  return { summaries, failed };
}
