/**
 * 設定画面（FR-8）。KV の UserConfig（interestAxes / sources）をフォーム表示し、
 * 更新を KV に書き戻す。
 *
 * 編集対象: 関心軸（トピックの label のみ・追加/削除）と
 * ソース（feeds / githubRepos / hnMinPoints）。
 * 関心軸のベクトルは日次パスが label から自動生成する（記述文の入力は不要）。
 * id はシステムが採番する不変キー — ユーザーは label だけ入力し、既存軸は hidden id で
 * round-trip、新規軸は保存時に crypto.randomUUID() を採番する。これによりラベルを
 * 変えても過去の hit_axis/feed_trends が孤立しない。
 * scoring 等のシステム側パラメータ（SYSTEM_CONFIG）は表示のみ（UI で変更しない）。
 * KV が空でも DEFAULT_USER_CONFIG でフォームを開ける。
 *
 * 素の HTML `<form method="post">` のみで完結させる（JS を必須にしない）。
 */

import type { Env } from "../index";
import {
  type InterestAxis,
  type ScoringConfig,
  type UserConfig,
  SYSTEM_CONFIG,
  loadUserConfigForForm,
  saveConfig,
} from "../config";
import { escapeHtml, page, htmlResponse } from "./layout";

const REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/;

/** フォーム上の軸。id は既存軸のみ持つ（新規は保存時に採番するため空）。 */
interface AxisField {
  id: string;
  label: string;
}

/** 送信値・config どちらからも組み立てる、フォーム再現用のモデル。 */
interface FormModel {
  axes: AxisField[];
  feeds: string;
  githubRepos: string;
  hnMinPoints: string;
}

function modelFromUserConfig(user: UserConfig): FormModel {
  return {
    axes: user.interestAxes.map((a) => ({ id: a.id, label: a.label })),
    feeds: user.sources.feeds.join("\n"),
    githubRepos: user.sources.githubRepos.join("\n"),
    hnMinPoints: String(user.sources.hnMinPoints),
  };
}

/** テキストエリアの複数行を trim して空行を除いた配列にする。 */
function lines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** http(s):// で始まる URL か。 */
function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** POST body から軸・ソースの生値を抽出する（削除・空の追加行は落とす）。 */
function modelFromForm(form: FormData): FormModel {
  const indices = new Set<number>();
  for (const key of form.keys()) {
    const m = key.match(/^axis-(\d+)-label$/);
    if (m) indices.add(Number(m[1]));
  }

  const axes: AxisField[] = [];
  for (const i of [...indices].sort((a, b) => a - b)) {
    if (form.get(`axis-${i}-delete`) !== null) continue;
    const id = String(form.get(`axis-${i}-id`) ?? "").trim();
    const label = String(form.get(`axis-${i}-label`) ?? "").trim();
    // 未入力の追加行はスキップする。
    if (id === "" && label === "") continue;
    axes.push({ id, label });
  }

  return {
    axes,
    feeds: String(form.get("feeds") ?? ""),
    githubRepos: String(form.get("githubRepos") ?? ""),
    hnMinPoints: String(form.get("hnMinPoints") ?? ""),
  };
}

/** モデルを検証する。問題があれば人間可読なエラー文字列の配列を返す。 */
function validate(model: FormModel): string[] {
  const errors: string[] = [];

  if (model.axes.length === 0) {
    errors.push("関心軸を 1 つ以上入力してください");
  }
  for (const axis of model.axes) {
    if (axis.label === "") {
      errors.push("関心軸のラベルが空です");
    }
  }

  for (const feed of lines(model.feeds)) {
    if (!isHttpUrl(feed)) {
      errors.push(`フィードは http(s):// の URL にしてください: "${feed}"`);
    }
  }

  for (const repo of lines(model.githubRepos)) {
    if (!REPO_PATTERN.test(repo)) {
      errors.push(`GitHub リポジトリは owner/name 形式にしてください: "${repo}"`);
    }
  }

  // Number("") は 0 になり素通りするため、trim 後に空・非数値を明示的に弾く。
  const hnRaw = model.hnMinPoints.trim();
  const hn = Number(hnRaw);
  if (hnRaw === "" || !Number.isInteger(hn) || hn < 0) {
    errors.push("hnMinPoints は 0 以上の整数にしてください");
  }

  return errors;
}

/** 検証済みモデルから保存用の UserConfig を組み立てる。新規軸に id を採番する。 */
function buildUserConfig(model: FormModel): UserConfig {
  const interestAxes: InterestAxis[] = model.axes.map((a) => ({
    id: a.id === "" ? crypto.randomUUID() : a.id,
    label: a.label,
  }));
  return {
    interestAxes,
    sources: {
      feeds: lines(model.feeds),
      githubRepos: lines(model.githubRepos),
      hnMinPoints: Number(model.hnMinPoints),
    },
  };
}

function renderAxis(index: number, axis: AxisField): string {
  // id は不変キー。既存軸は hidden で round-trip、新規行は空（保存時に採番）。
  return (
    `<fieldset>` +
    `<input type="hidden" name="axis-${index}-id" value="${escapeHtml(axis.id)}">` +
    `<label>トピック（ラベル）</label>` +
    `<input name="axis-${index}-label" value="${escapeHtml(axis.label)}">` +
    `<label><input type="checkbox" name="axis-${index}-delete"> この軸を削除</label>` +
    `</fieldset>`
  );
}

function renderForm(
  model: FormModel,
  scoring: ScoringConfig,
  errors: string[],
  ran: boolean,
): string {
  const errorHtml =
    errors.length === 0
      ? ""
      : `<ul class="error">${errors
          .map((e) => `<li>${escapeHtml(e)}</li>`)
          .join("")}</ul>`;

  // 手動実行の注記は POST /run 直後（?ran=1）のみ出す。
  const ranNote = ran
    ? `<p class="note">実行を開始しました（結果はフィードに反映。詳細ログは wrangler tail）。</p>`
    : "";

  // 日次パスの手動実行ボタン。設定保存フォームとは別 form にして送信が混ざらないようにする。
  const runForm =
    `<form method="post" action="/run">` +
    `<button type="submit">今すぐ日次パスを実行</button>` +
    `</form>`;

  // 既存軸 + 追加用の空行を 1 つ描画する。
  const axisFields = [...model.axes, { id: "", label: "" }]
    .map((a, i) => renderAxis(i, a))
    .join("");

  const scoringRows = [
    `interest 重み: ${scoring.weights.interest}`,
    `freshness 重み: ${scoring.weights.freshness}`,
    `sourceTrust 重み: ${scoring.weights.sourceTrust}`,
    `freshnessHalfLifeDays: ${scoring.freshnessHalfLifeDays}`,
    `semanticDedupThreshold: ${scoring.semanticDedupThreshold}`,
  ]
    .map((t) => `<li>${escapeHtml(t)}</li>`)
    .join("");

  const body =
    `<h1>設定</h1>` +
    `<p><a href="/">フィードへ戻る</a></p>` +
    ranNote +
    `<h2>手動実行</h2>` +
    runForm +
    errorHtml +
    `<form method="post" action="/settings">` +
    `<h2>関心軸</h2>` +
    `<p class="note">トピックのラベルだけ入力してください（日本語可）。関心記述文とベクトルは次回の日次パスがラベルから自動生成します。ラベルを変えると次回パスで再生成されます。</p>` +
    axisFields +
    `<h2>ソース</h2>` +
    `<label>フィード URL（1 行 1 件・RSS/Atom。ブログ/ニュースレター等）</label>` +
    `<textarea name="feeds" rows="6">${escapeHtml(model.feeds)}</textarea>` +
    `<label>GitHub リポジトリ（1 行 1 件・owner/name）</label>` +
    `<textarea name="githubRepos" rows="4">${escapeHtml(model.githubRepos)}</textarea>` +
    `<label>Hacker News 最低ポイント</label>` +
    `<input name="hnMinPoints" value="${escapeHtml(model.hnMinPoints)}" inputmode="numeric">` +
    `<h2>スコアリング（表示のみ）</h2><ul>${scoringRows}</ul>` +
    `<p><button type="submit">保存</button></p>` +
    `</form>`;

  return page("設定", body);
}

/**
 * `GET /settings`: KV の UserConfig（空なら既定）をフォーム表示する。
 * `ran` は POST /run 直後（?ran=1）に手動実行の注記を出すためのフラグ。
 */
export async function renderSettingsForm(
  env: Env,
  ran = false,
): Promise<Response> {
  const user = await loadUserConfigForForm(env);
  return htmlResponse(
    renderForm(modelFromUserConfig(user), SYSTEM_CONFIG.scoring, [], ran),
  );
}

/**
 * `POST /settings`: フォーム値を検証し、通れば saveConfig で KV 更新して
 * 303 で GET /settings へリダイレクト。エラーは 400 + 入力値保持で再表示。
 */
export async function handleSettingsUpdate(
  env: Env,
  request: Request,
): Promise<Response> {
  const form = await request.formData();
  const model = modelFromForm(form);

  const errors = validate(model);
  if (errors.length === 0) {
    try {
      await saveConfig(env, buildUserConfig(model));
      return new Response(null, {
        status: 303,
        headers: { location: "/settings" },
      });
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  return htmlResponse(
    renderForm(model, SYSTEM_CONFIG.scoring, errors, false),
    400,
  );
}
