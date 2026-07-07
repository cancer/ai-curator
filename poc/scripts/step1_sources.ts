/**
 * Step 1: ソース疎通（検証①）。全ソースを live fetch し、取得件数・エラー・
 * サンプルタイトルを stdout に出す。取得メタ（body 除く）を out/step1_articles.json
 * に保存する。本文はファイル・DB に保存しない (docs/01_requirements.md NFR-2)。
 */
import { mkdir } from "node:fs/promises";
import {
  githubRepos,
  hnMinPoints,
  mediumAuthorFeed,
  mediumTagFeed,
} from "../config";
import { fetchFowlerFeed } from "../src/adapters/fowler";
import { fetchGithubReleases } from "../src/adapters/github";
import { fetchHnStories } from "../src/adapters/hn";
import { fetchMediumFeed } from "../src/adapters/medium";
import type { NormalizedArticle } from "../src/types";

interface SourceTask {
  name: string;
  fetch: () => Promise<NormalizedArticle[]>;
}

const tasks: SourceTask[] = [
  ...githubRepos.map((repo) => ({
    name: `github:${repo}`,
    fetch: () => fetchGithubReleases(repo),
  })),
  { name: "hn", fetch: () => fetchHnStories(hnMinPoints) },
  {
    name: mediumAuthorFeed.source,
    fetch: () => fetchMediumFeed(mediumAuthorFeed.path, mediumAuthorFeed.source),
  },
  {
    name: mediumTagFeed.source,
    fetch: () => fetchMediumFeed(mediumTagFeed.path, mediumTagFeed.source),
  },
  { name: "fowler", fetch: () => fetchFowlerFeed() },
];

interface SourceResult {
  name: string;
  count: number;
  error?: string;
  articles: NormalizedArticle[];
}

async function runTask(task: SourceTask): Promise<SourceResult> {
  try {
    const articles = await task.fetch();
    return { name: task.name, count: articles.length, articles };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return { name: task.name, count: 0, error, articles: [] };
  }
}

/** 保存前に body を落とす。本文永続化禁止 (NFR-2)。feed_summary は保存可。 */
function stripBody(article: NormalizedArticle): Omit<NormalizedArticle, "body"> {
  const { body: _body, ...meta } = article;
  return meta;
}

const results = await Promise.all(tasks.map(runTask));

console.log("# Step 1: ソース疎通（検証①）\n");
for (const r of results) {
  const status = r.error ? `ERROR: ${r.error}` : "ok";
  console.log(`## ${r.name}  取得件数=${r.count}  ${status}`);
  for (const a of r.articles.slice(0, 3)) {
    console.log(`   - ${a.title}`);
  }
  console.log();
}

console.log("## サマリ");
console.log("| ソース | 取得件数 | エラー |");
console.log("|---|---|---|");
for (const r of results) {
  console.log(`| ${r.name} | ${r.count} | ${r.error ?? "—"} |`);
}

const outDir = `${import.meta.dir}/../out`;
await mkdir(outDir, { recursive: true });
const meta = results.flatMap((r) => r.articles.map(stripBody));
await Bun.write(
  `${outDir}/step1_articles.json`,
  JSON.stringify(meta, null, 2),
);
console.log(`\n保存: out/step1_articles.json（${meta.length} 件, body 除外）`);
