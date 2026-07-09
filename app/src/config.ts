/**
 * 設定の型と KV アクセス。
 *
 * 設定は 2 層に分かれる:
 * - UserConfig（interestAxes / sources）: ユーザー可変データ。KV キー `config:v1`
 *   に保存し、設定画面(/settings)から編集する。コードやファイルに書かない。
 * - SYSTEM_CONFIG（scoring / embedding / digest）: v1 ではコード内固定。UI 非公開で、
 *   変更するにはこの定数を編集する。
 *
 * 消費側（daily.ts / viewer）は `loadConfig` が返す完全な `Config`（両層のマージ）を使う。
 */

import type { Env } from "./index";

/** GitHub リポジトリ指定の形式（owner/repo、スラッシュ・空白を含まない 2 要素）。 */
const REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/;

export interface InterestAxis {
  id: string;
  label: string;
  seedText: string;
}

export interface Sources {
  githubRepos: string[];
  hnMinPoints: number;
  mediumAuthorFeeds: string[];
  mediumTagFeeds: string[];
  fowlerFeed: boolean;
}

export interface ScoringWeights {
  interest: number;
  freshness: number;
  sourceTrust: number;
}

export interface SourceTrustScores {
  github: number;
  fowler: number;
  medium: number;
  hn: number;
}

export interface ScoringConfig {
  weights: ScoringWeights;
  freshnessHalfLifeDays: number;
  semanticDedupThreshold: number;
  sourceTrust: SourceTrustScores;
}

export interface EmbeddingConfig {
  model: string;
  maxInputChars: number;
}

export interface DigestConfig {
  model: string;
  maxOutputTokens: number;
}

/** システム側パラメータ（v1 はコード固定・UI 非公開）。 */
export interface SystemConfig {
  scoring: ScoringConfig;
  embedding: EmbeddingConfig;
  digest: DigestConfig;
}

/** ユーザー可変データ（KV `config:v1` に保存する唯一の対象）。 */
export interface UserConfig {
  interestAxes: InterestAxis[];
  sources: Sources;
}

/** 消費側が使う完全な設定（UserConfig + SystemConfig）。 */
export interface Config extends UserConfig, SystemConfig {}

/**
 * システム側パラメータの固定値。v1 では UI から変更せず、必要ならこの定数を編集する。
 *
 * digest.model は運用前にコードで選定値へ差し替える前提の暫定既定。
 * 選定手順は DEPLOY.md §5（Workers AI の日本語対応モデルを実記事で目視比較）。
 * 現状値は日本語対応候補の一例で、運用前に選定・要検証（未検証のまま本番投入しない）。
 * `@cf/meta/llama-3.2-3b-instruct` は日本語品質が不十分なため選ばない。
 */
export const SYSTEM_CONFIG: SystemConfig = {
  scoring: {
    weights: {
      interest: 0.6,
      freshness: 0.3,
      sourceTrust: 0.1,
    },
    freshnessHalfLifeDays: 3,
    semanticDedupThreshold: 0.9,
    sourceTrust: {
      github: 1.0,
      fowler: 1.0,
      medium: 0.7,
      hn: 0.5,
    },
  },
  embedding: {
    model: "@cf/baai/bge-m3",
    maxInputChars: 20000,
  },
  digest: {
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    maxOutputTokens: 300,
  },
};

/**
 * 初回 `GET /settings` のフォーム初期表示用の既定 UserConfig。
 * seedText は英語で書く（対象記事が英語中心のため関心軸も英語で揃える）。
 * 保存されるまで KV には入らない（フォームの雛形）。
 */
export const DEFAULT_USER_CONFIG: UserConfig = {
  interestAxes: [
    {
      id: "web-fw",
      label: "Web フレームワーク",
      seedText:
        "Modern web frameworks and their runtime and rendering architecture: React, Next.js, Remix, Svelte, SvelteKit, Vue, Nuxt, Astro, Qwik, SolidJS. Server components, streaming SSR, hydration, islands architecture, edge rendering, routing, and build tooling.",
    },
    {
      id: "ai",
      label: "AI / 機械学習",
      seedText:
        "Applied AI and machine learning engineering: large language models, embeddings, retrieval-augmented generation, vector search, fine-tuning, inference optimization, prompt engineering, evaluation, and integrating model APIs into production software.",
    },
    {
      id: "agentic-coding",
      label: "エージェント型コーディング",
      seedText:
        "Agentic coding and AI-assisted software development: autonomous coding agents, LLM tool use and function calling, code generation, AI pair programming, developer copilots, agent orchestration, and workflows where models plan and edit code.",
    },
    {
      id: "software-design",
      label: "ソフトウェア設計",
      seedText:
        "Software design and architecture: clean architecture, domain-driven design, refactoring, design patterns, testing strategy, API design, modularity, coupling and cohesion, maintainability, and engineering practices that reduce cognitive load.",
    },
  ],
  sources: {
    githubRepos: ["facebook/react", "withastro/astro"],
    hnMinPoints: 50,
    mediumAuthorFeeds: [],
    mediumTagFeeds: ["software-engineering", "artificial-intelligence"],
    fowlerFeed: true,
  },
};

/**
 * Validate InterestAxis
 */
function validateInterestAxis(axis: unknown): InterestAxis {
  if (!axis || typeof axis !== "object") {
    throw new Error("InterestAxis must be an object");
  }

  const obj = axis as Record<string, unknown>;

  if (typeof obj.id !== "string" || obj.id.trim() === "") {
    throw new Error("InterestAxis.id must be a non-empty string");
  }

  if (typeof obj.label !== "string" || obj.label.trim() === "") {
    throw new Error("InterestAxis.label must be a non-empty string");
  }

  if (typeof obj.seedText !== "string" || obj.seedText.trim() === "") {
    throw new Error("InterestAxis.seedText must be a non-empty string");
  }

  return {
    id: obj.id,
    label: obj.label,
    seedText: obj.seedText,
  };
}

/**
 * Validate Sources
 */
function validateSources(sources: unknown): Sources {
  if (!sources || typeof sources !== "object") {
    throw new Error("sources must be an object");
  }

  const obj = sources as Record<string, unknown>;

  if (!Array.isArray(obj.githubRepos)) {
    throw new Error("sources.githubRepos must be an array");
  }

  for (const repo of obj.githubRepos) {
    if (typeof repo !== "string" || !REPO_PATTERN.test(repo)) {
      throw new Error(
        `sources.githubRepos entries must be "owner/repo" strings: ${JSON.stringify(repo)}`
      );
    }
  }

  if (typeof obj.hnMinPoints !== "number") {
    throw new Error("sources.hnMinPoints must be a number");
  }

  if (!Number.isInteger(obj.hnMinPoints) || obj.hnMinPoints < 0) {
    throw new Error("sources.hnMinPoints must be a non-negative integer");
  }

  if (!Array.isArray(obj.mediumAuthorFeeds)) {
    throw new Error("sources.mediumAuthorFeeds must be an array");
  }

  for (const feed of obj.mediumAuthorFeeds) {
    if (typeof feed !== "string") {
      throw new Error("sources.mediumAuthorFeeds entries must be strings");
    }
  }

  if (!Array.isArray(obj.mediumTagFeeds)) {
    throw new Error("sources.mediumTagFeeds must be an array");
  }

  for (const feed of obj.mediumTagFeeds) {
    if (typeof feed !== "string") {
      throw new Error("sources.mediumTagFeeds entries must be strings");
    }
  }

  if (typeof obj.fowlerFeed !== "boolean") {
    throw new Error("sources.fowlerFeed must be a boolean");
  }

  return {
    githubRepos: obj.githubRepos as string[],
    hnMinPoints: obj.hnMinPoints,
    mediumAuthorFeeds: obj.mediumAuthorFeeds as string[],
    mediumTagFeeds: obj.mediumTagFeeds as string[],
    fowlerFeed: obj.fowlerFeed,
  };
}

/**
 * UserConfig（KV に置く可変データ）を検証する。
 * 返り値は interestAxes / sources だけを持つ（システム側フィールドは含めない）。
 */
function validateUserConfig(data: unknown): UserConfig {
  if (!data || typeof data !== "object") {
    throw new Error("Config must be an object");
  }

  const obj = data as Record<string, unknown>;

  if (!Array.isArray(obj.interestAxes)) {
    throw new Error("interestAxes must be an array");
  }

  if (obj.interestAxes.length === 0) {
    throw new Error("interestAxes must not be empty (at least one axis)");
  }

  const interestAxes = obj.interestAxes.map((axis) =>
    validateInterestAxis(axis)
  );

  // 重複 id は feed_trends の UNIQUE(date, axis_id) で実行時クラッシュを招くため拒否する。
  const seenAxisIds = new Set<string>();
  for (const axis of interestAxes) {
    if (seenAxisIds.has(axis.id)) {
      throw new Error(`Duplicate interestAxis id: "${axis.id}"`);
    }
    seenAxisIds.add(axis.id);
  }

  return {
    interestAxes,
    sources: validateSources(obj.sources),
  };
}

/**
 * KV の UserConfig を検証し、SYSTEM_CONFIG をマージして完全な Config を返す。
 * KV 欠落・JSON 不正・検証失敗は throw（fail-fast。黙って既定値にしない）。
 */
export async function loadConfig(env: Env): Promise<Config> {
  const raw = await env.CONFIG.get("config:v1");

  if (!raw) {
    throw new Error('Config key "config:v1" not found in KV');
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Failed to parse config JSON: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  return { ...validateUserConfig(data), ...SYSTEM_CONFIG };
}

/**
 * UserConfig を検証し、interestAxes / sources のみを KV に書く。
 * 検証違反は throw（呼び出し側で 400 にする）。
 */
export async function saveConfig(env: Env, user: UserConfig): Promise<void> {
  const validated = validateUserConfig(user);

  await env.CONFIG.put("config:v1", JSON.stringify(validated));
}

/**
 * 設定画面の初期表示用。KV が存在し妥当なら KV の UserConfig を、
 * 無い・不正なら DEFAULT_USER_CONFIG を返す（throw しない。空 KV でもフォームを開ける）。
 */
export async function loadUserConfigForForm(env: Env): Promise<UserConfig> {
  const raw = await env.CONFIG.get("config:v1");
  if (!raw) {
    return DEFAULT_USER_CONFIG;
  }

  try {
    return validateUserConfig(JSON.parse(raw));
  } catch {
    return DEFAULT_USER_CONFIG;
  }
}
