/**
 * Step 3: Embedding + スコアリング（検証③）。
 * 全ソースを live fetch（本文はメモリ内のみ）→ 機械的 Dedup → モデル×入力の組み合わせごとに
 * Embedding → 意味的 Dedup → スコアリング → ランキング生成。
 * 出力（本文を含まない）:
 *   - out/step3_ranking.md    : 組み合わせごとの上位/下位 10 件（ユーザーの目視評価用）
 *   - out/step3_top10.json    : 既定組み合わせの上位 10 件メタ（Step 4 への受け渡し）
 * コストは CostLedger に積算し stdout に出す（検証④の一次データ）。本文はファイルに保存しない (NFR-2)。
 */
import { mkdir } from "node:fs/promises";
import {
  bodyHeadChars,
  type EmbeddingInputVariant,
  type EmbeddingModel,
  embeddingModels,
  freshnessHalfLifeDays,
  githubRepos,
  hnMinPoints,
  interestAxes,
  japaneseSeedSample,
  mediumAuthorFeed,
  mediumTagFeed,
  scoreWeights,
  semanticDedupThreshold,
  simhashHammingThreshold,
  sourceTrust,
} from "../config";
import { fetchFowlerBody, fetchFowlerFeed } from "../src/adapters/fowler";
import { fetchGithubReleases } from "../src/adapters/github";
import { fetchHnStories } from "../src/adapters/hn";
import { fetchMediumFeed } from "../src/adapters/medium";
import { embed } from "../src/ai_client";
import { CostLedger } from "../src/cost";
import { buildEmbeddingInput } from "../src/embedding_input";
import { mechanicalDedup } from "../src/simhash";
import {
  type AxisVector,
  computeScore,
  cosineSimilarity,
  freshnessDecay,
  interestSimilarity,
  resolveSourceTrust,
} from "../src/score";
import { semanticDedup } from "../src/semantic_dedup";
import type { NormalizedArticle } from "../src/types";

/**
 * 1 文字あたりのトークン数の見積り（本文切り詰め用）。実測 2026-07-07: この見積りは短い技術的な
 * 文字列（GitHub リリース名等）で大きく下振れする（50 件の短いタイトルを 1 リクエストにまとめた
 * 場合、見積り合計 807 token に対し実測 11,150 token）。複数記事をバッチ化すると bge-m3 の
 * 合計コンテキスト上限 60,000 token/リクエストを超えて失敗したため、Embedding は 1 記事 1
 * リクエストで行う（下記 embedAll）。
 */
const CHARS_PER_TOKEN = 3.5;
const FOWLER_INTERVAL_MS = 1000;
/** 1 記事 1 リクエストにした結果リクエスト数が増えるため、連続呼び出しの間隔を空ける。 */
const EMBED_INTERVAL_MS = 150;
const now = new Date();
const ledger = new CostLedger();

interface Combo {
  key: string;
  model: EmbeddingModel;
  variant: EmbeddingInputVariant;
}

const combos: Combo[] = [
  { key: "bge-m3 × title-summary", model: embeddingModels.bgeM3, variant: "title-summary" },
  { key: "bge-m3 × title-bodyhead", model: embeddingModels.bgeM3, variant: "title-bodyhead" },
  { key: "bge-m3 × fulltext", model: embeddingModels.bgeM3, variant: "fulltext" },
  { key: "qwen3 × title-summary", model: embeddingModels.qwen3, variant: "title-summary" },
  { key: "qwen3 × title-bodyhead", model: embeddingModels.qwen3, variant: "title-bodyhead" },
];
const DEFAULT_COMBO_KEY = "bge-m3 × title-summary";

async function gatherArticles(): Promise<{ articles: NormalizedArticle[]; fowlerBodyFailures: number }> {
  const articles: NormalizedArticle[] = [];
  for (const repo of githubRepos) articles.push(...(await fetchGithubReleases(repo)));
  articles.push(...(await fetchHnStories(hnMinPoints)));
  articles.push(...(await fetchMediumFeed(mediumAuthorFeed.path, mediumAuthorFeed.source)));
  articles.push(...(await fetchMediumFeed(mediumTagFeed.path, mediumTagFeed.source)));

  const fowler = await fetchFowlerFeed();
  let fowlerBodyFailures = 0;
  for (const [i, article] of fowler.entries()) {
    if (i > 0) await Bun.sleep(FOWLER_INTERVAL_MS);
    try {
      article.body = await fetchFowlerBody(article.url);
    } catch {
      fowlerBodyFailures++;
    }
  }
  articles.push(...fowler);
  return { articles, fowlerBodyFailures };
}

/** 1 テキストがモデルの context を単独で超えないよう切り詰める。 */
function truncateForModel(text: string, model: EmbeddingModel): string {
  const maxChars = Math.floor(model.contextTokens * 0.9 * CHARS_PER_TOKEN);
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/** 1 記事 1 リクエストで Embedding する（上記 CHARS_PER_TOKEN のコメント参照）。 */
async function embedAll(
  model: EmbeddingModel,
  texts: string[],
  tag: string,
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (const [i, text] of texts.entries()) {
    if (i > 0) await Bun.sleep(EMBED_INTERVAL_MS);
    const result = await embed(model.id, [truncateForModel(text, model)]);
    ledger.addEmbedding(tag, result.inputTokens, model.inputNeuronsPerM, result.reportedNeurons);
    vectors.push(...result.vectors);
  }
  return vectors;
}

interface Ranked {
  article: NormalizedArticle;
  score: number;
  hitAxisId: string;
}

/** 意味的 Dedup の代表選出用: ソース信頼度を最優先、次に新しさ。 */
function representativePriority(article: NormalizedArticle): number {
  return resolveSourceTrust(article.source, sourceTrust) * 1e13 + Date.parse(article.publishedAt);
}

async function rankCombo(combo: Combo, articles: NormalizedArticle[]): Promise<Ranked[]> {
  const inputs = articles.map((a) => buildEmbeddingInput(a, combo.variant, bodyHeadChars));
  const vectors = await embedAll(combo.model, inputs, `${combo.key} / articles`);
  const seedVectors = await embedAll(
    combo.model,
    interestAxes.map((ax) => ax.seed),
    `${combo.key} / seeds`,
  );
  const axes: AxisVector[] = interestAxes.map((ax, i) => ({ id: ax.id, vector: seedVectors[i]! }));

  const withVec = articles.map((article, i) => ({ article, vector: vectors[i]! }));
  const survivors = semanticDedup(
    withVec,
    (x) => x.vector,
    semanticDedupThreshold,
    (x) => representativePriority(x.article),
  );

  const ranked = survivors.map(({ article, vector }) => {
    const { similarity, hitAxisId } = interestSimilarity(vector, axes);
    const score = computeScore(
      {
        interest: Math.max(0, similarity),
        freshness: freshnessDecay(article.publishedAt, now, freshnessHalfLifeDays),
        sourceTrust: resolveSourceTrust(article.source, sourceTrust),
      },
      scoreWeights,
    );
    return { article, score, hitAxisId };
  });
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

function axisLabel(id: string): string {
  return interestAxes.find((ax) => ax.id === id)?.label ?? id;
}

function rankingTable(ranked: Ranked[]): string {
  const lines = ["| # | score | ヒット軸 | ソース | タイトル | URL |", "|---|---|---|---|---|---|"];
  ranked.forEach((r, i) => {
    lines.push(
      `| ${i + 1} | ${r.score.toFixed(3)} | ${axisLabel(r.hitAxisId)} | ${r.article.source} | ${r.article.title.replace(/\|/g, "/")} | ${r.article.url} |`,
    );
  });
  return lines.join("\n");
}

async function multilingualCheck(): Promise<string> {
  const enSeed = interestAxes.find((ax) => ax.id === japaneseSeedSample.axisId)!.seed;
  const lines = [
    `関心軸「${axisLabel(japaneseSeedSample.axisId)}」の英語シード vs 日本語シードの cosine:`,
    "",
    "| モデル | cosine(EN, JA) |",
    "|---|---|",
  ];
  for (const model of [embeddingModels.bgeM3, embeddingModels.qwen3]) {
    const [en, ja] = await embedAll(model, [enSeed, japaneseSeedSample.seedJa], `multilingual-check / ${model.id}`);
    lines.push(`| ${model.id} | ${cosineSimilarity(en!, ja!).toFixed(4)} |`);
  }
  return lines.join("\n");
}

function overlapSummary(rankings: Map<string, Ranked[]>): string {
  const topUrls = new Map<string, Set<string>>();
  for (const [key, ranked] of rankings) {
    topUrls.set(key, new Set(ranked.slice(0, 10).map((r) => r.article.url)));
  }
  const defaultTop = topUrls.get(DEFAULT_COMBO_KEY)!;
  const lines = [
    `既定（${DEFAULT_COMBO_KEY}）の上位 10 件と各組み合わせの上位 10 件の重なり:`,
    "",
    "| 組み合わせ | 上位10の重なり数 |",
    "|---|---|",
  ];
  for (const [key, urls] of topUrls) {
    const overlap = [...urls].filter((u) => defaultTop.has(u)).length;
    lines.push(`| ${key} | ${overlap} / 10 |`);
  }
  return lines.join("\n");
}

function costSummary(): string {
  const lines = ["| tag | calls | input tokens | neurons |", "|---|---|---|---|"];
  for (const { tag, entry } of ledger.rows()) {
    lines.push(`| ${tag} | ${entry.calls} | ${entry.inputTokens} | ${entry.neurons.toFixed(3)} |`);
  }
  lines.push(`| **合計** | | | **${ledger.totalNeurons().toFixed(3)}** |`);
  return lines.join("\n");
}

// --- 実行 ---
console.log("# Step 3: Embedding + スコアリング（検証③）\n");
console.log("ソースを live fetch 中（Fowler は本文を 1 秒間隔で取得）...");
const { articles, fowlerBodyFailures } = await gatherArticles();
console.log(`取得: ${articles.length} 件（Fowler 本文取得失敗 ${fowlerBodyFailures} 件）`);

const deduped = mechanicalDedup(articles, (a) => `${a.title}\n${a.feedSummary ?? ""}`, simhashHammingThreshold);
console.log(`機械的 Dedup 後: ${deduped.length} 件（${articles.length - deduped.length} 件除去）\n`);

const rankings = new Map<string, Ranked[]>();
for (const combo of combos) {
  console.log(`Embedding + スコアリング: ${combo.key} ...`);
  rankings.set(combo.key, await rankCombo(combo, deduped));
}

console.log("多言語対応チェック中...");
const multilingual = await multilingualCheck();

const outDir = `${import.meta.dir}/../out`;
await mkdir(outDir, { recursive: true });

const sections = [
  "# Step 3 ランキング（検証③・目視評価用）",
  "",
  `生成: ${now.toISOString()} / 記事 ${deduped.length} 件（機械的 Dedup 後）`,
  "",
  "本文は含まない（NFR-2）。score は 関心類似×0.6 + 鮮度×0.3 + ソース信頼度×0.1（暫定重み）。",
  "",
  "## 多言語対応チェック",
  "",
  multilingual,
  "",
  "## 組み合わせ間の上位 10 件の重なり",
  "",
  overlapSummary(rankings),
];
for (const combo of combos) {
  const ranked = rankings.get(combo.key)!;
  sections.push("", `## ${combo.key}（意味的 Dedup 後 ${ranked.length} 件）`, "", "### 上位 10 件", "", rankingTable(ranked.slice(0, 10)), "", "### 下位 10 件", "", rankingTable(ranked.slice(-10)));
}
await Bun.write(`${outDir}/step3_ranking.md`, sections.join("\n"));

const defaultRanked = rankings.get(DEFAULT_COMBO_KEY)!;
const top10Bridge = defaultRanked.slice(0, 10).map((r) => ({
  url: r.article.url,
  title: r.article.title,
  source: r.article.source,
  publishedAt: r.article.publishedAt,
  feedSummary: r.article.feedSummary, // フィード提供の要約は保存可 (NFR-2 §10)
  score: r.score,
  hitAxisId: r.hitAxisId,
}));
await Bun.write(`${outDir}/step3_top10.json`, JSON.stringify(top10Bridge, null, 2));

console.log("\n## コスト（Embedding、検証④一次データ）");
console.log(costSummary());
console.log(`\n保存: out/step3_ranking.md / out/step3_top10.json（本文なし）`);
console.log(`Fowler 本文取得失敗: ${fowlerBodyFailures} 件`);
