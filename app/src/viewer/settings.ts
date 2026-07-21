/**
 * 設定画面（FR-8）。D1 の UserConfig（interestAxes / sources）を編集する。
 *
 * 編集対象: 関心軸（トピック label + カテゴリ・行ごとに追加/削除）と
 * ソース（feeds = 任意の RSS/Atom フィード URL・行ごとに追加/削除）。
 * 関心軸のベクトルは日次パスが label から自動生成する（記述文の入力は不要）。
 * id はシステムが採番する不変キー — ユーザーは label だけ入力し、既存軸は行の
 * data-id で round-trip、新規軸は保存時に crypto.randomUUID() を採番する。これにより
 * ラベルを変えても過去の hit_axis/feed_trends が孤立しない。
 * scoring 等のシステム側パラメータ（SYSTEM_CONFIG）は表示のみ（UI で変更しない）。
 * D1 に軸が無くても空のひな形（EMPTY_USER_CONFIG）でフォームを開ける。
 *
 * 挙動: 行の編集・追加・削除はクライアント JS が DOM を真実源にして拾い、変更を
 * デバウンスして `POST /api/config`（JSON・全置換）へ自動保存する（保存ボタンは無い）。
 * 保存は直列化し、採番された id は応答で各行へ書き戻す。JS 無効時は現在値の閲覧のみ。
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

/** インライン SVG（lucide 由来・装飾なので aria-hidden）。色は currentColor に委譲する。 */
const svg = (paths: string, size = 16): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
  `stroke="currentColor" stroke-width="2" stroke-linecap="round" ` +
  `stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const ICON_BACK = svg('<path d="m12 19-7-7 7-7M19 12H5"/>', 14);
const ICON_RUN = svg(
  '<path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>',
);
const ICON_PLUS = svg('<path d="M12 5v14M5 12h14"/>', 15);
const ICON_TRASH = svg(
  '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/>',
);
const ICON_CHECK = svg('<path d="M20 6 9 17l-5-5"/>', 13);

/** フォーム上の軸（描画用）。id は既存軸のみ持つ（新規は空 = 保存時に採番）。 */
interface AxisField {
  id: string;
  label: string;
  category: string;
}

/**
 * 関心軸 1 行。サーバ初期描画とクライアントの追加（<template> 複製）で同一構造を使う。
 * data-id が不変キー（新規は空）。入力値はクライアントが gather 時に読む。
 */
function axisRowHtml(axis: AxisField): string {
  return (
    `<div class="row axis-row" data-id="${escapeHtml(axis.id)}">` +
    `<div class="field"><input class="axis-label" value="${escapeHtml(axis.label)}" placeholder="トピック名" aria-label="トピック"></div>` +
    `<div class="field"><input class="axis-category" value="${escapeHtml(axis.category)}" placeholder="未分類" aria-label="カテゴリ"></div>` +
    `<button type="button" class="btn-icon row-del" aria-label="この軸を削除" title="削除">${ICON_TRASH}</button>` +
    `</div>`
  );
}

/** ソース 1 行。構造は axisRowHtml と同じ思想（DOM が真実源）。 */
function feedRowHtml(url: string): string {
  return (
    `<div class="row feed-row">` +
    `<div class="field"><input class="feed-url mono" value="${escapeHtml(url)}" placeholder="https://example.com/feed" aria-label="フィード URL"></div>` +
    `<button type="button" class="btn-icon row-del" aria-label="このソースを削除" title="削除">${ICON_TRASH}</button>` +
    `</div>`
  );
}

/**
 * 自動保存のクライアント JS。DOM の行を真実源として gather し、デバウンス（700ms）＋
 * 直列化して `POST /api/config` に投げる。保存前にクライアント側でも検証し（軸 ≥1・
 * ラベル非空・feed は http(s)）、不正なら送らずステータスに理由を出す（サーバも同じ検証で
 * 400 を返すので二重の安全網）。採番された id は応答（送信順一致）で各行へ書き戻す。
 * 素の JS のみ（フレームワーク無し）。文字列はすべて DOM API 経由で入れるため XSS 無し。
 */
const SETTINGS_SCRIPT = `
(function () {
  var axesList = document.getElementById("axes-list");
  var feedsList = document.getElementById("feeds-list");
  if (!axesList || !feedsList) return;
  var statuses = document.querySelectorAll(".autosave");
  var timer = null, saving = false, pending = false;

  function setStatus(state, text) {
    statuses.forEach(function (el) {
      el.setAttribute("data-state", state);
      el.textContent = text;
    });
  }
  function isHttp(u) {
    try { var p = new URL(u); return p.protocol === "http:" || p.protocol === "https:"; }
    catch (e) { return false; }
  }
  function gather() {
    var axes = [].map.call(axesList.querySelectorAll(".axis-row"), function (row) {
      var label = row.querySelector(".axis-label").value.trim();
      var category = row.querySelector(".axis-category").value.trim();
      var a = { id: row.dataset.id || "", label: label };
      if (category) a.category = category;
      return a;
    });
    var feeds = [].map.call(feedsList.querySelectorAll(".feed-url"), function (i) {
      return i.value.trim();
    }).filter(function (u) { return u !== ""; });
    return { interestAxes: axes, feeds: feeds };
  }
  function validate(d) {
    if (d.interestAxes.length === 0) return "関心軸を 1 つ以上入力してください";
    for (var i = 0; i < d.interestAxes.length; i++) {
      if (d.interestAxes[i].label === "") return "関心軸のラベルが空です";
    }
    for (var j = 0; j < d.feeds.length; j++) {
      if (!isHttp(d.feeds[j])) return "フィード URL が不正です";
    }
    return null;
  }
  function save() {
    if (saving) { pending = true; return; }
    var data = gather();
    var err = validate(data);
    if (err) { setStatus("error", "未保存: " + err); return; }
    saving = true;
    setStatus("saving", "保存中…");
    fetch("/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    })
      .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
      .then(function (res) {
        if (!res.ok || !res.body || !res.body.ok) {
          var msg = (res.body && res.body.errors && res.body.errors[0]) || "サーバエラー";
          setStatus("error", "未保存: " + msg);
          return;
        }
        var rows = axesList.querySelectorAll(".axis-row");
        (res.body.interestAxes || []).forEach(function (a, i) {
          if (rows[i]) rows[i].dataset.id = a.id;
        });
        setStatus("saved", "保存済み");
      })
      .catch(function () { setStatus("error", "未保存: 通信エラー"); })
      .then(function () { saving = false; if (pending) { pending = false; save(); } });
  }
  function scheduleSave() { if (timer) clearTimeout(timer); timer = setTimeout(save, 700); }
  function addRow(list, tplId, focusSel) {
    var tpl = document.getElementById(tplId);
    var node = tpl.content.firstElementChild.cloneNode(true);
    list.appendChild(node);
    return node;
  }

  axesList.addEventListener("input", scheduleSave);
  feedsList.addEventListener("input", scheduleSave);
  axesList.addEventListener("click", function (e) {
    var b = e.target.closest(".row-del");
    if (b) { b.closest(".axis-row").remove(); scheduleSave(); }
  });
  feedsList.addEventListener("click", function (e) {
    var b = e.target.closest(".row-del");
    if (b) { b.closest(".feed-row").remove(); scheduleSave(); }
  });
  document.getElementById("add-axis").addEventListener("click", function () {
    var label = document.getElementById("draft-axis-label");
    var cat = document.getElementById("draft-axis-category");
    if (label.value.trim() === "") { label.focus(); return; }
    var node = addRow(axesList, "axis-tpl");
    node.querySelector(".axis-label").value = label.value.trim();
    node.querySelector(".axis-category").value = cat.value.trim();
    label.value = ""; cat.value = ""; label.focus();
    save();
  });
  document.getElementById("add-feed").addEventListener("click", function () {
    var url = document.getElementById("draft-feed");
    if (url.value.trim() === "") { url.focus(); return; }
    var node = addRow(feedsList, "feed-tpl");
    node.querySelector(".feed-url").value = url.value.trim();
    url.value = ""; url.focus();
    save();
  });
})();
`;

function modelFromUserConfig(user: UserConfig): {
  axes: AxisField[];
  feeds: string[];
} {
  return {
    axes: user.interestAxes.map((a) => ({
      id: a.id,
      label: a.label,
      category: a.category ?? "",
    })),
    feeds: [...user.sources.feeds],
  };
}

function renderForm(
  axes: AxisField[],
  feeds: string[],
  scoring: ScoringConfig,
  runId: string | null,
): string {
  // 手動実行の注記は POST /run 直後（?run=<instanceId>）のみ出す。実行は Workflow が
  // 担うため、状態は status 照会（/runs/{id}）で確認する（この場では完了を待たない）。
  const ranNote =
    runId === null || runId === ""
      ? ""
      : `<p class="note">日次パスを起動しました（instance ${escapeHtml(runId)}）。` +
        `状態: <a href="/runs/${encodeURIComponent(runId)}">/runs/${escapeHtml(runId)}</a></p>`;

  const autosave = `<span class="autosave">${ICON_CHECK}変更は自動保存されます</span>`;

  const scoringRows: [string, string | number][] = [
    ["interest 重み", scoring.weights.interest],
    ["freshness 重み", scoring.weights.freshness],
    ["sourceTrust 重み", scoring.weights.sourceTrust],
    ["freshnessHalfLifeDays", scoring.freshnessHalfLifeDays],
    ["semanticDedupThreshold", scoring.semanticDedupThreshold],
  ];
  const scoringHtml = scoringRows
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd>`)
    .join("");

  const emptyAxis: AxisField = { id: "", label: "", category: "" };

  const body =
    `<div class="wrap-narrow" id="settings-root">` +
    `<header class="settings-header">` +
    `<a class="back-link" href="/">${ICON_BACK}フィードへ戻る</a>` +
    `<h1>設定</h1>` +
    `</header>` +
    ranNote +
    `<section class="section">` +
    `<h2>手動実行</h2>` +
    `<p class="section-note">日次パス（取得→要約→ランキング）を今すぐ 1 回実行します。実行は数分かかり、完了後にフィードへ反映されます。</p>` +
    `<form method="post" action="/run">` +
    `<button class="btn-primary" type="submit">${ICON_RUN}今すぐ日次パスを実行</button>` +
    `</form>` +
    `</section>` +
    `<section class="section">` +
    `<div class="section-head"><h2>関心軸</h2>${autosave}</div>` +
    `<p class="section-note">トピックのラベルだけ入力してください（日本語可）。関心記述文とベクトルは次回の日次パスがラベルから自動生成します。ラベルを変えると次回パスで再生成されます。</p>` +
    `<div id="axes-list">${axes.map(axisRowHtml).join("")}</div>` +
    `<div class="add-block">` +
    `<div class="add-block-label">軸を追加</div>` +
    `<div class="add-row">` +
    `<div class="field"><input id="draft-axis-label" placeholder="トピック（例: エッジコンピューティング）" aria-label="追加するトピック"></div>` +
    `<div class="field"><input id="draft-axis-category" placeholder="カテゴリ（任意）" aria-label="追加するカテゴリ"></div>` +
    `<button type="button" id="add-axis" class="btn-add">${ICON_PLUS}追加</button>` +
    `</div></div>` +
    `</section>` +
    `<section class="section">` +
    `<div class="section-head"><h2>ソース</h2>${autosave}</div>` +
    `<p class="section-note">購読するフィードの URL（RSS/Atom）。ブログ / Medium 著者 / ニュースレター等。</p>` +
    `<div id="feeds-list">${feeds.map(feedRowHtml).join("")}</div>` +
    `<div class="add-block">` +
    `<div class="add-block-label">ソースを追加</div>` +
    `<div class="add-row">` +
    `<div class="field"><input id="draft-feed" class="mono" placeholder="https://example.com/feed" aria-label="追加するフィード URL"></div>` +
    `<button type="button" id="add-feed" class="btn-add">${ICON_PLUS}追加</button>` +
    `</div></div>` +
    `</section>` +
    `<section class="section">` +
    `<h2>スコアリング <span class="meta">（表示のみ）</span></h2>` +
    `<dl class="scoring">${scoringHtml}</dl>` +
    `</section>` +
    `<template id="axis-tpl">${axisRowHtml(emptyAxis)}</template>` +
    `<template id="feed-tpl">${feedRowHtml("")}</template>` +
    `<script>${SETTINGS_SCRIPT}</script>` +
    `</div>`;

  return page("設定", body);
}

/**
 * `GET /settings`: D1 の UserConfig（空なら既定）を編集フォームで返す。
 * `runId` は POST /run 直後（?run=<instanceId>）に、起動した Workflow インスタンスの
 * ID と状態照会リンクを注記するためのもの（無ければ null）。
 */
export async function renderSettingsForm(
  env: Env,
  runId: string | null = null,
): Promise<Response> {
  const user = await loadUserConfigForForm(env);
  const model = modelFromUserConfig(user);
  return htmlResponse(
    renderForm(model.axes, model.feeds, SYSTEM_CONFIG.scoring, runId),
  );
}

/**
 * `POST /api/config`: JSON `{ interestAxes:[{id?,label,category?}], feeds:[string] }` を
 * 受け取り、全置換で D1 へ保存する（settings 画面の自動保存の保存先）。新規軸（id 空）へは
 * ここで crypto.randomUUID() を採番する。検証は saveConfig（config.ts）に委ね、違反は
 * `{ ok:false, errors:[...] }` + 400 で返す（保存しない）。成功時は採番後の
 * interestAxes（送信順）と feeds を返し、クライアントが id を各行へ同期できるようにする。
 */
export async function handleConfigApi(
  env: Env,
  request: Request,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ ok: false, errors: ["不正な JSON"] }, { status: 400 });
  }
  if (!raw || typeof raw !== "object") {
    return Response.json(
      { ok: false, errors: ["不正なリクエスト"] },
      { status: 400 },
    );
  }
  const body = raw as Record<string, unknown>;
  const rawAxes = Array.isArray(body.interestAxes) ? body.interestAxes : [];
  const rawFeeds = Array.isArray(body.feeds) ? body.feeds : [];

  const interestAxes: InterestAxis[] = rawAxes.map((a) => {
    const o = (a ?? {}) as Record<string, unknown>;
    const id =
      typeof o.id === "string" && o.id.trim() !== ""
        ? o.id.trim()
        : crypto.randomUUID();
    const label = typeof o.label === "string" ? o.label.trim() : "";
    const category = typeof o.category === "string" ? o.category.trim() : "";
    return category === "" ? { id, label } : { id, label, category };
  });
  const feeds = rawFeeds
    .map((u) => (typeof u === "string" ? u.trim() : ""))
    .filter((u) => u !== "");

  const user: UserConfig = { interestAxes, sources: { feeds } };
  try {
    await saveConfig(env, user);
  } catch (e) {
    return Response.json(
      { ok: false, errors: [e instanceof Error ? e.message : String(e)] },
      { status: 400 },
    );
  }

  return Response.json({ ok: true, interestAxes, feeds });
}
