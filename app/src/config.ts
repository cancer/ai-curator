/**
 * KV 設定ロード・保存。
 *
 * 初回のみ: `wrangler kv key put --binding CONFIG "config:v1" --path config.json --remote`
 * 以後は設定画面(タスク9)から saveConfig 経由で KV に書き戻すのが正の経路。
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

export interface Config {
  interestAxes: InterestAxis[];
  sources: Sources;
  scoring: ScoringConfig;
  embedding: EmbeddingConfig;
  digest: DigestConfig;
}

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
 * Validate ScoringWeights
 */
function validateScoringWeights(weights: unknown): ScoringWeights {
  if (!weights || typeof weights !== "object") {
    throw new Error("scoring.weights must be an object");
  }

  const obj = weights as Record<string, unknown>;

  if (typeof obj.interest !== "number") {
    throw new Error("scoring.weights.interest must be a number");
  }
  if (obj.interest < 0) {
    throw new Error("scoring.weights.interest must be a non-negative number");
  }

  if (typeof obj.freshness !== "number") {
    throw new Error("scoring.weights.freshness must be a number");
  }
  if (obj.freshness < 0) {
    throw new Error("scoring.weights.freshness must be a non-negative number");
  }

  if (typeof obj.sourceTrust !== "number") {
    throw new Error("scoring.weights.sourceTrust must be a number");
  }
  if (obj.sourceTrust < 0) {
    throw new Error("scoring.weights.sourceTrust must be a non-negative number");
  }

  return {
    interest: obj.interest,
    freshness: obj.freshness,
    sourceTrust: obj.sourceTrust,
  };
}

/**
 * Validate SourceTrustScores
 */
function validateSourceTrustScores(trust: unknown): SourceTrustScores {
  if (!trust || typeof trust !== "object") {
    throw new Error("scoring.sourceTrust must be an object");
  }

  const obj = trust as Record<string, unknown>;

  if (typeof obj.github !== "number") {
    throw new Error("scoring.sourceTrust.github must be a number");
  }
  if (obj.github < 0) {
    throw new Error("scoring.sourceTrust.github must be a non-negative number");
  }

  if (typeof obj.fowler !== "number") {
    throw new Error("scoring.sourceTrust.fowler must be a number");
  }
  if (obj.fowler < 0) {
    throw new Error("scoring.sourceTrust.fowler must be a non-negative number");
  }

  if (typeof obj.medium !== "number") {
    throw new Error("scoring.sourceTrust.medium must be a number");
  }
  if (obj.medium < 0) {
    throw new Error("scoring.sourceTrust.medium must be a non-negative number");
  }

  if (typeof obj.hn !== "number") {
    throw new Error("scoring.sourceTrust.hn must be a number");
  }
  if (obj.hn < 0) {
    throw new Error("scoring.sourceTrust.hn must be a non-negative number");
  }

  return {
    github: obj.github,
    fowler: obj.fowler,
    medium: obj.medium,
    hn: obj.hn,
  };
}

/**
 * Validate ScoringConfig
 */
function validateScoringConfig(scoring: unknown): ScoringConfig {
  if (!scoring || typeof scoring !== "object") {
    throw new Error("scoring must be an object");
  }

  const obj = scoring as Record<string, unknown>;

  if (typeof obj.freshnessHalfLifeDays !== "number" || obj.freshnessHalfLifeDays <= 0) {
    throw new Error("scoring.freshnessHalfLifeDays must be a positive number");
  }

  if (typeof obj.semanticDedupThreshold !== "number") {
    throw new Error("scoring.semanticDedupThreshold must be a number");
  }
  if (obj.semanticDedupThreshold < 0 || obj.semanticDedupThreshold > 1) {
    throw new Error("scoring.semanticDedupThreshold must be a number in [0, 1]");
  }

  return {
    weights: validateScoringWeights(obj.weights),
    freshnessHalfLifeDays: obj.freshnessHalfLifeDays,
    semanticDedupThreshold: obj.semanticDedupThreshold,
    sourceTrust: validateSourceTrustScores(obj.sourceTrust),
  };
}

/**
 * Validate EmbeddingConfig
 */
function validateEmbeddingConfig(embedding: unknown): EmbeddingConfig {
  if (!embedding || typeof embedding !== "object") {
    throw new Error("embedding must be an object");
  }

  const obj = embedding as Record<string, unknown>;

  if (typeof obj.model !== "string" || obj.model.trim() === "") {
    throw new Error("embedding.model must be a non-empty string");
  }

  if (typeof obj.maxInputChars !== "number" || obj.maxInputChars <= 0) {
    throw new Error("embedding.maxInputChars must be a positive integer");
  }

  return {
    model: obj.model,
    maxInputChars: obj.maxInputChars,
  };
}

/**
 * Validate DigestConfig
 */
function validateDigestConfig(digest: unknown): DigestConfig {
  if (!digest || typeof digest !== "object") {
    throw new Error("digest must be an object");
  }

  const obj = digest as Record<string, unknown>;

  if (typeof obj.model !== "string" || obj.model.trim() === "") {
    throw new Error("digest.model must be a non-empty string");
  }

  if (typeof obj.maxOutputTokens !== "number" || obj.maxOutputTokens <= 0) {
    throw new Error("digest.maxOutputTokens must be a positive integer");
  }

  return {
    model: obj.model,
    maxOutputTokens: obj.maxOutputTokens,
  };
}

/**
 * Validate Config
 */
function validateConfig(data: unknown): Config {
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
    scoring: validateScoringConfig(obj.scoring),
    embedding: validateEmbeddingConfig(obj.embedding),
    digest: validateDigestConfig(obj.digest),
  };
}

/**
 * Load config from KV.
 * Validates required fields (fail-fast). Throws on missing or invalid data.
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

  return validateConfig(data);
}

/**
 * Save config to KV.
 * Validates before saving. Throws on validation failure.
 */
export async function saveConfig(env: Env, config: Config): Promise<void> {
  // Validate before saving
  const validated = validateConfig(config);

  await env.CONFIG.put("config:v1", JSON.stringify(validated));
}
