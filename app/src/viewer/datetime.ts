/**
 * ビューアの日付表示を JST に変換するヘルパ。
 *
 * ここは表示文字列だけを扱う。DB スキーマ・保存値・パイプラインの date キー生成は
 * 一切変更しない（記録は UTC のまま、表示だけ Asia/Tokyo に寄せる）。
 */

/**
 * cron の実行時刻（UTC の時）。`wrangler.jsonc` の `"crons": ["0 21 * * *"]` との結合点。
 * date キーは runAt.toISOString().slice(0,10)（= UTC 暦日）で作られる（pipeline/daily.ts）。
 * つまり date キー D の実体は「D 21:00 UTC」の瞬間であり、これを JST へ写すと D+1 になる。
 * 手動 `POST /run` を 21:00 UTC 以外の時刻で叩くと、この前提とラベルがずれ得る。
 */
export const CRON_UTC_HOUR = 21;

// 暦日と時刻を Asia/Tokyo の各パーツから組み立てる。ロケール依存の暗黙フォーマット
// （sv-SE/en-CA 等）には頼らず、formatToParts で type ごとに拾って自前で連結する。
// hourCycle: "h23" で真夜中を "00" に固定する（"24" 表記を避ける）。
const JST_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function jstParts(date: Date): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const p of JST_FORMAT.formatToParts(date)) parts[p.type] = p.value;
  return parts;
}

/**
 * UTC 日付キー `YYYY-MM-DD` を、cron 実行時刻（`CRON_UTC_HOUR`:00 UTC）の瞬間として
 * 解釈し、Asia/Tokyo の暦日 `YYYY-MM-DD` を返す（結果は D+1）。
 * 不正入力はそのまま返す。
 */
export function toJstFeedDateLabel(dateKey: string): string {
  const hh = String(CRON_UTC_HOUR).padStart(2, "0");
  const date = new Date(`${dateKey}T${hh}:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return dateKey;
  const p = jstParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * UTC ISO 文字列を JST の `YYYY-MM-DD HH:mm` に変換する。不正入力はそのまま返す。
 */
export function formatJstPublishedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const p = jstParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
