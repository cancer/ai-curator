/**
 * Step 4: Digest 生成 + コスト実測（検証④）。
 * out/step3_top10.json（bge-m3 × title-summary の上位 10 件）を入力に、上位 10 件のみ本文を
 * 再取得し LLM で要約する（(a) 方式、docs/04_poc_plan.md Step 4）。
 * 再取得: GitHub=API body / Medium=著者 feed content:encoded / Fowler=記事ページ。
 * HN は本文を持たないため feedSummary を代替として使う（失敗ではない）。
 * 再取得失敗（GitHub/Medium/Fowler）はフィード要約にフォールバックし、失敗率を記録する。
 * 出力（本文を含まない。要約は自前生成のため保存可 NFR-2 §10）: out/digest_sample.md
 */
import {
  digestBodyChars,
  digestMaxOutputTokens,
  digestModel,
  interestAxes,
} from "../config";
import { fetchFowlerBody } from "../src/adapters/fowler";
import { fetchGithubReleases } from "../src/adapters/github";
import { fetchMediumFeed } from "../src/adapters/medium";
import { generate } from "../src/ai_client";
import { CostLedger } from "../src/cost";
import { renderDigestMarkdown, type DigestEntry } from "../src/digest";
import type { NormalizedArticle } from "../src/types";

interface Top10Item {
  url: string;
  title: string;
  source: string;
  publishedAt: string;
  feedSummary?: string;
  score: number;
  hitAxisId: string;
}

interface RefetchResult {
  text: string;
  usedFallback: boolean;
  /** GitHub/Medium/Fowler の再取得が例外で失敗した場合のみ true（HN の feedSummary 代替は失敗扱いしない）。 */
  failed: boolean;
}

function toFallback(item: Top10Item, failed: boolean): RefetchResult {
  return { text: item.feedSummary ?? "", usedFallback: true, failed };
}

/** フィードを取得し URL 一致する記事の本文を返す（GitHub/Medium 共通のパターン）。失敗はログに残しつつフォールバックする。 */
async function refetchFromList(
  item: Top10Item,
  fetchList: () => Promise<NormalizedArticle[]>,
): Promise<RefetchResult> {
  try {
    const list = await fetchList();
    const match = list.find((a) => a.url === item.url);
    return match?.body ? { text: match.body, usedFallback: false, failed: false } : toFallback(item, false);
  } catch (e) {
    console.error(`本文再取得失敗 [${item.source}] ${item.url}: ${e instanceof Error ? e.message : String(e)}`);
    return toFallback(item, true);
  }
}

/** 上位 10 件のみ、ソース種別に応じて本文を再取得する（(a) 方式）。失敗はフィード要約にフォールバックする。 */
async function refetchBody(item: Top10Item): Promise<RefetchResult> {
  if (item.source.startsWith("github:")) {
    const repo = item.source.slice("github:".length);
    return refetchFromList(item, () => fetchGithubReleases(repo));
  }
  if (item.source.startsWith("medium:")) {
    const path = item.source.slice("medium:".length);
    return refetchFromList(item, () => fetchMediumFeed(path, item.source));
  }
  if (item.source === "fowler") {
    try {
      const body = await fetchFowlerBody(item.url);
      return { text: body, usedFallback: false, failed: false };
    } catch (e) {
      console.error(`本文再取得失敗 [fowler] ${item.url}: ${e instanceof Error ? e.message : String(e)}`);
      return toFallback(item, true);
    }
  }
  // hn: 本文を持たない設計（docs/02_specification.md §2）。feedSummary 代替は失敗ではない。
  return toFallback(item, false);
}

function axisLabel(id: string): string {
  return interestAxes.find((ax) => ax.id === id)?.label ?? id;
}

function buildDigestMessages(item: Top10Item, bodyText: string): { role: string; content: string }[] {
  const excerpt = bodyText.slice(0, digestBodyChars);
  return [
    {
      role: "system",
      content:
        "あなたは技術ニュースの編集者です。与えられた記事のタイトルと本文抜粋から、内容を2〜3文の日本語で要約してください。誇張や主観的評価を避け、記事の主旨を簡潔に伝えてください。",
    },
    {
      role: "user",
      content: excerpt ? `タイトル: ${item.title}\n\n本文抜粋:\n${excerpt}` : `タイトル: ${item.title}`,
    },
  ];
}

// --- 実行 ---
console.log("# Step 4: Digest 生成 + コスト実測（検証④）\n");

const top10 = (await Bun.file(`${import.meta.dir}/../out/step3_top10.json`).json()) as Top10Item[];
console.log(`入力: out/step3_top10.json（${top10.length} 件）\n`);

const ledger = new CostLedger();
let refetchAttempts = 0;
let refetchFailures = 0;
let summaryFailures = 0;

const entries: DigestEntry[] = [];
for (const item of top10) {
  const refetched = await refetchBody(item);
  // hn は本文再取得を試みない設計のため、失敗率の分母から除く。
  if (item.source !== "hn") {
    refetchAttempts++;
    if (refetched.failed) refetchFailures++;
  }
  console.log(
    `- ${item.title.slice(0, 60)} [${item.source}] 本文取得: ${refetched.usedFallback ? "フォールバック" : "成功"}${refetched.failed ? "（失敗）" : ""}`,
  );

  // LLM 要約が 1 件失敗しても、それまでの結果を捨てずに digest_sample.md へ残す（フェイルセーフ）。
  try {
    const messages = buildDigestMessages(item, refetched.text);
    const result = await generate(digestModel.id, messages, digestMaxOutputTokens);
    ledger.addGeneration(
      "digest",
      result.inputTokens,
      result.outputTokens,
      digestModel.inputNeuronsPerM,
      digestModel.outputNeuronsPerM,
    );
    entries.push({
      title: item.title,
      source: item.source,
      publishedAt: item.publishedAt,
      url: item.url,
      hitAxisLabel: axisLabel(item.hitAxisId),
      summary: result.text.trim(),
    });
  } catch (e) {
    summaryFailures++;
    console.error(`要約生成失敗 [${item.source}] ${item.url}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const outDir = `${import.meta.dir}/../out`;
await Bun.write(`${outDir}/digest_sample.md`, renderDigestMarkdown(entries));

const failureRate = refetchAttempts > 0 ? refetchFailures / refetchAttempts : 0;
console.log(`\n本文再取得（GitHub/Medium/Fowler）: ${refetchAttempts} 件中 ${refetchFailures} 件失敗（失敗率 ${(failureRate * 100).toFixed(1)}%）`);
console.log(`要約生成: ${top10.length} 件中 ${summaryFailures} 件失敗（digest から除外）`);

console.log("\n## コスト（Digest LLM、検証④一次データ）");
const entry = ledger.get("digest");
console.log(
  `calls=${entry?.calls ?? 0} input_tokens=${entry?.inputTokens ?? 0} output_tokens=${entry?.outputTokens ?? 0} neurons=${ledger.totalNeurons().toFixed(3)}`,
);
console.log("\n保存: out/digest_sample.md（本文なし、自前生成の要約のみ）");
