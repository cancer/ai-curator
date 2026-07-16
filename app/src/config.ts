/**
 * 設定の型と D1 アクセス。
 *
 * 設定は 2 層に分かれる:
 * - UserConfig（interestAxes / sources）: ユーザー可変データ。D1 の正規化テーブル
 *   （interest_axes の源泉列 axis_id/label、feed_source の url）に保存し、
 *   設定画面(/settings)から編集する。コードやファイルに書かない。
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

/** ユーザー可変データ（D1 の interest_axes 源泉列 / feed_source に保存する唯一の対象）。 */
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
    // Qwen3 30B A3B（推論モデル）。同じく検討した Gemma 4 / GLM‑4.7 / GPT‑OSS は
    // built-in thinking を止める手段が Workers AI に無く、推論だけで max_tokens を
    // 食い潰し可視回答が空になる「暴走」を起こす（Gemma は本番で約 50%）。Qwen3 は
    // 検証・本番で必ず stop・非空に収束する唯一の候補のため採用。
    model: "@cf/qwen/qwen3-30b-a3b-fp8",
    // 推論トークン＋回答トークンの合計上限。Qwen3 の実測完走は ~1,000〜1,100 tok で、
    // 4,000 は十分な余裕。Qwen3 は自発的に stop するため、上限は最悪ケースの天井
    // （＝暴走時のコスト上限）として置くだけで、通常は実消費分しか課金されない。
    maxOutputTokens: 4000,
  },
};

/**
 * 軸が 1 件も無いときに `GET /settings` を開くための空のひな形。
 * 実際の設定（トピック・フィード）はコードに持たず、すべて D1 に置く。
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
 * D1 の正規化テーブルから UserConfig を組み立てる（検証はしない）。
 * axis_id/label は interest_axes の源泉列、feeds は feed_source から読む。
 * どちらも id（INTEGER PRIMARY KEY = 挿入順）昇順で返し、設定画面の並びを保つ。
 */
async function readUserConfig(db: D1Database): Promise<UserConfig> {
  const axisRows =
    (
      await db
        .prepare("SELECT axis_id, label FROM interest_axes ORDER BY id")
        .all<{ axis_id: string; label: string }>()
    ).results ?? [];
  const feedRows =
    (
      await db
        .prepare("SELECT url FROM feed_source ORDER BY id")
        .all<{ url: string }>()
    ).results ?? [];

  return {
    interestAxes: axisRows.map((r) => ({ id: r.axis_id, label: r.label })),
    sources: { feeds: feedRows.map((r) => r.url) },
  };
}

/**
 * D1 の UserConfig を検証し、SYSTEM_CONFIG をマージして完全な Config を返す。
 * 軸 0 件・検証失敗は throw（fail-fast。黙って既定値にしない）。
 */
export async function loadConfig(env: Env): Promise<Config> {
  const user = await readUserConfig(env.DB);
  return { ...validateUserConfig(user), ...SYSTEM_CONFIG };
}

/**
 * UserConfig を検証し、interestAxes / sources を D1 へ原子的に書く。
 * batch（暗黙トランザクション）で「軸の upsert → config から消えた軸の除去 →
 * feed の総入れ替え」をまとめて適用する。軸の upsert は源泉列（axis_id/label）だけを
 * 触り、派生列（seed_hash/embedding/embedding_model）には触れない — label 変更時に
 * seed_hash が旧値のまま残り、次 cron が hash 不一致で再 embed する現行挙動を保つ。
 * 検証違反は throw（呼び出し側で 400 にする）。
 */
export async function saveConfig(env: Env, user: UserConfig): Promise<void> {
  const validated = validateUserConfig(user);

  const statements: D1PreparedStatement[] = [];
  for (const axis of validated.interestAxes) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO interest_axes (axis_id, label) VALUES (?, ?) " +
          "ON CONFLICT(axis_id) DO UPDATE SET label = excluded.label"
      ).bind(axis.id, axis.label)
    );
  }
  // config から消えた軸を除去する（検証で軸 ≥ 1 保証済みなので IN は非空）。
  const axisIds = validated.interestAxes.map((a) => a.id);
  statements.push(
    env.DB.prepare(
      `DELETE FROM interest_axes WHERE axis_id NOT IN (${axisIds
        .map(() => "?")
        .join(", ")})`
    ).bind(...axisIds)
  );
  // feeds は KV blob の総入れ替えと等価に delete → insert する。
  statements.push(env.DB.prepare("DELETE FROM feed_source"));
  for (const url of validated.sources.feeds) {
    statements.push(
      env.DB.prepare("INSERT INTO feed_source (url) VALUES (?)").bind(url)
    );
  }

  await env.DB.batch(statements);
}

/**
 * 設定画面の初期表示用。軸が 1 件以上あれば D1 の UserConfig を、無ければ
 * EMPTY_USER_CONFIG（空フォーム）を返す（throw しない。空 D1 でもフォームを開ける）。
 */
export async function loadUserConfigForForm(env: Env): Promise<UserConfig> {
  const user = await readUserConfig(env.DB);
  return user.interestAxes.length === 0 ? EMPTY_USER_CONFIG : user;
}
