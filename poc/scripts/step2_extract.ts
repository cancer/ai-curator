/**
 * Step 2: 本文抽出（検証②）。両極の抽出方式を検証する:
 *   - Medium（テンプレ抽出）: 著者 feed の content:encoded から本文を取る
 *   - Fowler（個別抽出）: 記事ページの <main> から本文を取る
 * 各記事の「タイトル / 本文文字数 / 冒頭 200 字」を stdout に出す。
 * 本文はファイル・DB に保存しない (docs/01_requirements.md NFR-2)。
 * Fowler への連続アクセスには 1 秒の間隔を置く。
 */
import { mediumAuthorFeed } from "../config";
import { fetchFowlerBody, fetchFowlerFeed } from "../src/adapters/fowler";
import { fetchMediumFeed } from "../src/adapters/medium";

const FOWLER_TARGET_COUNT = 6;
const FOWLER_INTERVAL_MS = 1000;

function report(index: number, title: string, body: string): void {
  const head = body.slice(0, 200).replace(/\s+/g, " ").trim();
  console.log(`${index}. ${title}`);
  console.log(`   本文文字数: ${body.length}`);
  console.log(`   冒頭200字: ${head}`);
  console.log();
}

console.log("# Step 2: 本文抽出（検証②）\n");

console.log("## Medium 著者 feed（テンプレ抽出: content:encoded）");
const mediumArticles = await fetchMediumFeed(
  mediumAuthorFeed.path,
  mediumAuthorFeed.source,
);
const mediumWithBody = mediumArticles.filter(
  (a) => a.body !== undefined && a.body.length > 0,
);
console.log(
  `feed 内 ${mediumArticles.length} 件中 ${mediumWithBody.length} 件に本文あり\n`,
);
mediumWithBody.forEach((a, i) => report(i + 1, a.title, a.body!));

console.log("## Fowler 記事ページ（個別抽出: <main>）");
const fowlerFeed = await fetchFowlerFeed();
const targets = fowlerFeed.slice(0, FOWLER_TARGET_COUNT);
console.log(`feed 先頭 ${targets.length} 件の記事ページを抽出（1秒間隔）\n`);
for (const [i, article] of targets.entries()) {
  if (i > 0) await Bun.sleep(FOWLER_INTERVAL_MS);
  try {
    const body = await fetchFowlerBody(article.url);
    report(i + 1, article.title, body);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`${i + 1}. ${article.title}`);
    console.log(`   抽出失敗: ${msg}\n`);
  }
}
