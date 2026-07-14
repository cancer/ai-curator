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

/**
 * 関心軸。ユーザーはラベル（自然言語のトピック名）だけを与える。関心記述文と
 * そのベクトルは日次パスが label から自動生成する（seedText は廃止）。id は不変
 * キー（設定画面で新規軸に採番）で、ラベルを変えても過去の hit_axis/feed_trends が
 * 孤立しないようにする。
 */
export interface InterestAxis {
  id: string;
  label: string;
}

/**
 * 取得ソース。feeds は任意の RSS/Atom フィード URL のリスト（汎用アダプタが処理）。
 * 全ソースを feed に一本化した（github/hn の専用ソースは廃止）。
 */
export interface Sources {
  feeds: string[];
}

export interface ScoringWeights {
  interest: number;
  freshness: number;
  sourceTrust: number;
}

/**
 * ソース種別ごとの信頼度。種別は source 文字列の `:` より前（`feed:{url}`→`feed`）。
 * 任意フィードは 1 本ずつ質を測れないため feed でひとまとめにする。
 */
export interface SourceTrustScores {
  feed: number;
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
      feed: 0.7,
    },
  },
  embedding: {
    model: "@cf/baai/bge-m3",
    maxInputChars: 20000,
  },
  digest: {
    // Gemma 4 は built-in thinking の推論モデル。要約品質（帰属・原語保持）は
    // 高いが、同期 AI.run では推論生成が ~60s ゲートウェイに達し 504 になるため
    // summarize.ts はストリーミング必須で呼ぶ。返却は choices 形式・推論は破棄する。
    model: "@cf/google/gemma-4-26b-a4b-it",
    // 推論トークン＋回答トークンの合計上限（トークン単位）。推論モデルは生成量が
    // run 間で大きくぶれるため、実測（回答到達時 ~5k tok）に安全余裕を足した値。
    // ストリーミングなので stop で止まった分しか課金されない（上限は最悪コスト）。
    maxOutputTokens: 10000,
  },
};

/**
 * KV が空/不正なときに `GET /settings` を開くための空のひな形。
 * 実際の設定（トピック・フィード）はコードに持たず、すべて KV に置く。
 * これはあくまで「まだ何も無い」状態を表す空フォーム用で、そのままでは
 * 保存できない（保存には関心軸が 1 つ以上必要）。
 */
export const EMPTY_USER_CONFIG: UserConfig = {
  interestAxes: [],
  sources: {
    feeds: [],
  },
};

/**
 * Validate InterestAxis（id 非空・label 非空。seedText は廃止）。
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

  return {
    id: obj.id,
    label: obj.label,
  };
}

/** http(s):// で始まる URL か（feeds 要素の検証用）。 */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Validate Sources（feeds は http(s) URL の配列）。 */
function validateSources(sources: unknown): Sources {
  if (!sources || typeof sources !== "object") {
    throw new Error("sources must be an object");
  }

  const obj = sources as Record<string, unknown>;

  if (!Array.isArray(obj.feeds)) {
    throw new Error("sources.feeds must be an array");
  }

  for (const feed of obj.feeds) {
    if (typeof feed !== "string" || !isHttpUrl(feed)) {
      throw new Error(
        `sources.feeds entries must be http(s):// URLs: ${JSON.stringify(feed)}`
      );
    }
  }

  return {
    feeds: obj.feeds as string[],
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
 * 無い・不正なら EMPTY_USER_CONFIG（空フォーム）を返す（throw しない。空 KV でもフォームを開ける）。
 */
export async function loadUserConfigForForm(env: Env): Promise<UserConfig> {
  const raw = await env.CONFIG.get("config:v1");
  if (!raw) {
    return EMPTY_USER_CONFIG;
  }

  try {
    return validateUserConfig(JSON.parse(raw));
  } catch {
    return EMPTY_USER_CONFIG;
  }
}
