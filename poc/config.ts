/**
 * PoC の設定値。監視対象と関心軸シードをコードから分離する
 * (docs/02_specification.md §2「監視対象はユーザー設定とし、コードから分離する」)。
 * 具体値は docs/04_poc_plan.md §3-2 の確定・暫定値に対応する。後から差し替え可能。
 */

/** GitHub Releases の監視リポジトリ (docs/04_poc_plan.md §3-2)。 */
export const githubRepos = [
  "sveltejs/svelte",
  "withastro/astro",
  "anthropics/claude-code",
];

/** HN: この points 超の story を取得する。キーワード事前フィルタはしない (docs/04_poc_plan.md §3-2)。 */
export const hnMinPoints = 50;

/** Medium 著者 feed（content:encoded に本文全文を含む。テンプレ抽出の対象）。 */
export const mediumAuthorFeed = {
  path: "@kentbeck_7670",
  source: "medium:@kentbeck_7670",
};

/** Medium タグ feed（description の snippet のみ。メタ収集用）。 */
export const mediumTagFeed = {
  path: "tag/software-architecture",
  source: "medium:tag/software-architecture",
};

/**
 * 関心軸シード。軸は 4 つで確定 (docs/02_specification.md §6.2)。
 * seed は Step 3 で Embedding される英語の短文。関連度の精度追求はしないため、
 * ここでは各軸の関心範囲を素直に記述する（後で調整可能な暫定値）。
 */
export interface InterestAxis {
  id: string;
  label: string;
  seed: string;
}

export const interestAxes: InterestAxis[] = [
  {
    id: "web-fw",
    label: "Web FW",
    seed: "Web application frameworks and their rendering, routing, and component models: Svelte, SvelteKit, Astro, React, and tradeoffs between server-side rendering, static generation, islands, and client reactivity.",
  },
  {
    id: "ai",
    label: "AI",
    seed: "Large language models and applied machine learning: model capabilities, training and fine-tuning, evaluation, embeddings, retrieval, and integrating AI into software products.",
  },
  {
    id: "agentic-coding",
    label: "Agentic Coding",
    seed: "AI coding agents and agentic developer tools: autonomous code generation and editing, LLM-driven pair programming, tool use, and agent workflows such as Claude Code for building software.",
  },
  {
    id: "software-designing",
    label: "Software Designing",
    seed: "Software design and architecture: modularity, refactoring, domain modeling, testing, design patterns, and the principles behind maintainable, well-structured, low-cognitive-load codebases.",
  },
];

/**
 * qwen3 の多言語対応は Cloudflare ページに明記がないため、1 軸だけ日本語シードを用意し、
 * 英語版との cosine を両モデルで測って多言語対応を確認する（docs/04_poc_plan.md）。
 */
export const japaneseSeedSample = {
  axisId: "software-designing",
  seedJa: "ソフトウェア設計とアーキテクチャ: モジュール性、リファクタリング、ドメインモデリング、テスト、デザインパターン、保守しやすく構造化された認知負荷の低いコードベースを支える原則。",
};

/** Embedding 入力バリエーション（docs/04_poc_plan.md 出口判断）。 */
export type EmbeddingInputVariant = "title-summary" | "title-bodyhead" | "fulltext";

/** (ii) title-bodyhead で使う本文冒頭の文字数。 */
export const bodyHeadChars = 2000;

export interface EmbeddingModel {
  id: string;
  /** 入力の最大トークン数。これを超える入力は文字数換算で切り詰める。 */
  contextTokens: number;
  /** 入力トークン単価（neurons/M tokens、Cloudflare pricing 2026-07）。 */
  inputNeuronsPerM: number;
  multilingual: boolean;
}

/**
 * 第一候補 bge-m3 と代替 qwen3 を A/B する（docs/03_design.md §4）。
 * contextTokens は 1 シーケンスあたりのトークン上限。実測 2026-07-06: bge-m3 は Workers AI 上で
 * 8192 tokens で "Sequence too long" となる（pricing ページの context window 60,000 とは別の実効上限）。
 */
export const embeddingModels = {
  bgeM3: {
    id: "@cf/baai/bge-m3",
    contextTokens: 8192,
    inputNeuronsPerM: 1075,
    multilingual: true,
  },
  qwen3: {
    id: "@cf/qwen/qwen3-embedding-0.6b",
    contextTokens: 8192,
    inputNeuronsPerM: 1075,
    multilingual: true,
  },
} satisfies Record<string, EmbeddingModel>;

/**
 * Embedding 入力の最大文字数。8192 tokens のシーケンス上限に、密なテキスト（表・図ラベル等で
 * 文字/トークン比が下がる）でも収まるよう保守的に設定する（20000 chars ≈ 8000 tokens @ 2.5 c/t）。
 * (iii) 全文は長い記事ではこの上限までの冒頭になる。
 */
export const maxEmbedChars = 20000;

/**
 * Digest 用 LLM。安価なテキスト生成モデルを選定（docs/04_poc_plan.md Step 4）。
 * llama-3.2-3b: 入力 4,625 / 出力 30,475 neurons/M（Cloudflare pricing 2026-07）。
 * 選定理由: 1b より要約品質が安定し、70b の 1/6 未満の単価。1 日 10 件の digest でも無料枠に余裕。
 */
export const digestModel = {
  id: "@cf/meta/llama-3.2-3b-instruct",
  inputNeuronsPerM: 4625,
  outputNeuronsPerM: 30475,
};

/** Digest 要約プロンプトに渡す本文の冒頭文字数（コスト抑制と入力長超過防止のため切り詰める）。 */
export const digestBodyChars = 4000;

/** Digest 要約の生成トークン上限（2〜3 文の短い要約を想定）。 */
export const digestMaxOutputTokens = 300;

/** スコア式の重み（docs/02_specification.md §6.1、暫定）。 */
export const scoreWeights = { w1: 0.6, w2: 0.3, w3: 0.1 };

/** 鮮度の指数減衰の半減期（日、暫定）。 */
export const freshnessHalfLifeDays = 14;

/**
 * ソース信頼度（0〜1 の固定値、暫定。docs/02_specification.md §6.3）。
 * source の完全一致を優先し、無ければ ":" より前の接頭辞で解決する。
 */
export const sourceTrust: Record<string, number> = {
  fowler: 1.0,
  "medium:@kentbeck_7670": 0.9,
  github: 0.7,
  hn: 0.5,
  "medium:tag/software-architecture": 0.4,
};

/** 意味的 Dedup の cosine 閾値（docs/02_specification.md §4、暫定）。 */
export const semanticDedupThreshold = 0.9;

/** 機械的 Dedup（SimHash）の Hamming 距離閾値。64bit のうちこの距離以下を重複とみなす。 */
export const simhashHammingThreshold = 3;
