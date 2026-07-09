/**
 * 設定画面（FR-8）。KV の UserConfig（interestAxes / sources）をフォーム表示し、
 * 更新を KV に書き戻す。
 *
 * 編集対象: 関心軸（label / seedText / 追加・削除）と
 * ソース（githubRepos / mediumAuthorFeeds / mediumTagFeeds / hnMinPoints）。
 * scoring 等のシステム側パラメータ（SYSTEM_CONFIG）は表示のみ（UI で変更しない）。
 * フォームに無い fowlerFeed は、読み込んだ UserConfig の値をそのまま保存する。
 * KV が空でも DEFAULT_USER_CONFIG でフォームを開ける。
 *
 * 素の HTML `<form method="post">` のみで完結させる（JS を必須にしない）。
 * 追加は末尾の空行に入力、削除は各行の削除チェックボックスで行う。
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

const AXIS_ID_PATTERN = /^[a-z0-9-]+$/;
const REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/;

interface AxisField {
  id: string;
  label: string;
  seedText: string;
}

/** 送信値・config どちらからも組み立てる、フォーム再現用のモデル。 */
interface FormModel {
  axes: AxisField[];
  githubRepos: string;
  mediumAuthorFeeds: string;
  mediumTagFeeds: string;
  hnMinPoints: string;
}

function modelFromUserConfig(user: UserConfig): FormModel {
  return {
    axes: user.interestAxes.map((a) => ({
      id: a.id,
      label: a.label,
      seedText: a.seedText,
    })),
    githubRepos: user.sources.githubRepos.join("\n"),
    mediumAuthorFeeds: user.sources.mediumAuthorFeeds.join("\n"),
    mediumTagFeeds: user.sources.mediumTagFeeds.join("\n"),
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

/** POST body から軸・ソースの生値を抽出する（削除・空の追加行は落とす）。 */
function modelFromForm(form: FormData): FormModel {
  const indices = new Set<number>();
  for (const key of form.keys()) {
    const m = key.match(/^axis-(\d+)-id$/);
    if (m) indices.add(Number(m[1]));
  }

  const axes: AxisField[] = [];
  for (const i of [...indices].sort((a, b) => a - b)) {
    if (form.get(`axis-${i}-delete`) !== null) continue;
    const id = String(form.get(`axis-${i}-id`) ?? "").trim();
    const label = String(form.get(`axis-${i}-label`) ?? "").trim();
    const seedText = String(form.get(`axis-${i}-seedText`) ?? "").trim();
    // 未入力の追加行はスキップする。
    if (id === "" && label === "" && seedText === "") continue;
    axes.push({ id, label, seedText });
  }

  return {
    axes,
    githubRepos: String(form.get("githubRepos") ?? ""),
    mediumAuthorFeeds: String(form.get("mediumAuthorFeeds") ?? ""),
    mediumTagFeeds: String(form.get("mediumTagFeeds") ?? ""),
    hnMinPoints: String(form.get("hnMinPoints") ?? ""),
  };
}

/** モデルを検証する。問題があれば人間可読なエラー文字列の配列を返す。 */
function validate(model: FormModel): string[] {
  const errors: string[] = [];

  const seen = new Set<string>();
  for (const axis of model.axes) {
    if (!AXIS_ID_PATTERN.test(axis.id)) {
      errors.push(`関心軸 id が不正です（英小文字・数字・ハイフンのみ）: "${axis.id}"`);
    } else if (seen.has(axis.id)) {
      errors.push(`関心軸 id が重複しています: "${axis.id}"`);
    }
    seen.add(axis.id);
    if (axis.seedText === "") {
      errors.push(`seedText が空です（軸: "${axis.id || axis.label}"）`);
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

/** 検証済みモデルと元 UserConfig から、保存用の UserConfig を組み立てる。 */
function buildUserConfig(model: FormModel, base: UserConfig): UserConfig {
  const interestAxes: InterestAxis[] = model.axes.map((a) => ({
    id: a.id,
    label: a.label,
    seedText: a.seedText,
  }));
  return {
    interestAxes,
    sources: {
      ...base.sources,
      githubRepos: lines(model.githubRepos),
      mediumAuthorFeeds: lines(model.mediumAuthorFeeds),
      mediumTagFeeds: lines(model.mediumTagFeeds),
      hnMinPoints: Number(model.hnMinPoints),
    },
  };
}

function renderAxis(
  index: number,
  axis: AxisField,
  lockedIds: Set<string>,
): string {
  const id = escapeHtml(axis.id);
  // 既存軸の id は変更不可（readonly）、新規行のみ編集可能。
  const idAttr =
    axis.id !== "" && lockedIds.has(axis.id) ? " readonly" : "";
  return (
    `<fieldset>` +
    `<label>id</label><input name="axis-${index}-id" value="${id}"${idAttr}>` +
    `<label>ラベル</label>` +
    `<input name="axis-${index}-label" value="${escapeHtml(axis.label)}">` +
    `<label>seedText</label>` +
    `<textarea name="axis-${index}-seedText" rows="2">${escapeHtml(axis.seedText)}</textarea>` +
    `<label><input type="checkbox" name="axis-${index}-delete"> この軸を削除</label>` +
    `</fieldset>`
  );
}

function renderForm(
  model: FormModel,
  scoring: ScoringConfig,
  lockedIds: Set<string>,
  errors: string[],
): string {
  const errorHtml =
    errors.length === 0
      ? ""
      : `<ul class="error">${errors
          .map((e) => `<li>${escapeHtml(e)}</li>`)
          .join("")}</ul>`;

  // 既存軸 + 追加用の空行を 1 つ描画する。
  const axisFields = [...model.axes, { id: "", label: "", seedText: "" }]
    .map((a, i) => renderAxis(i, a, lockedIds))
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
    errorHtml +
    `<form method="post" action="/settings">` +
    `<h2>関心軸</h2>` +
    `<p class="note">seedText を変更すると、次回 Cron B で関心軸ベクトルが自動再生成されます。</p>` +
    axisFields +
    `<h2>ソース</h2>` +
    `<label>GitHub リポジトリ（1 行 1 件・owner/name）</label>` +
    `<textarea name="githubRepos" rows="4">${escapeHtml(model.githubRepos)}</textarea>` +
    `<label>Medium 著者フィード（1 行 1 件）</label>` +
    `<textarea name="mediumAuthorFeeds" rows="3">${escapeHtml(model.mediumAuthorFeeds)}</textarea>` +
    `<label>Medium タグフィード（1 行 1 件）</label>` +
    `<textarea name="mediumTagFeeds" rows="3">${escapeHtml(model.mediumTagFeeds)}</textarea>` +
    `<label>Hacker News 最低ポイント</label>` +
    `<input name="hnMinPoints" value="${escapeHtml(model.hnMinPoints)}" inputmode="numeric">` +
    `<h2>スコアリング（表示のみ）</h2><ul>${scoringRows}</ul>` +
    `<p><button type="submit">保存</button></p>` +
    `</form>`;

  return page("設定", body);
}

/** `GET /settings`: KV の UserConfig（空なら既定）をフォーム表示する。 */
export async function renderSettingsForm(env: Env): Promise<Response> {
  const user = await loadUserConfigForForm(env);
  const lockedIds = new Set(user.interestAxes.map((a) => a.id));
  return htmlResponse(
    renderForm(modelFromUserConfig(user), SYSTEM_CONFIG.scoring, lockedIds, []),
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
  const base = await loadUserConfigForForm(env);
  const lockedIds = new Set(base.interestAxes.map((a) => a.id));

  const form = await request.formData();
  const model = modelFromForm(form);

  const errors = validate(model);
  if (errors.length === 0) {
    try {
      await saveConfig(env, buildUserConfig(model, base));
      return new Response(null, { status: 303, headers: { location: "/settings" } });
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  return htmlResponse(
    renderForm(model, SYSTEM_CONFIG.scoring, lockedIds, errors),
    400,
  );
}
