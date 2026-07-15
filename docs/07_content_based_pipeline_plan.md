# 実装計画: 本文駆動パイプライン再設計（content-based feed）

## 1. Context（背景・目的）

アプリの核心価値は「記事を**読む/読まないの判断を、記事内容の要約から**下せること」。
ランキング（関連度）も要約も**本文由来**でなければならない。タイトル＋スニペットだけの
判定なら生の HN/RSS を読めば足り、AI に課金する意味がない（memory:
`ai-curator-value-is-content-based`）。

現状はこの要件を満たしていない。実データ（2026-07-15）で確定した事実:

- **ランキングが本文を使っていない**: `embeddingInput`/`hashInput` は `title + feedSummary`
  （フィードのスニペット ~100字）だけ（daily.ts:192-198）。本文は `summarizeFeed` でしか取得せず、
  **関連度判定に一切還元していない**。これがフィード品質の根本的な弱点。
- **本文取得可否（HTTP）**:
  - 取得可: `*.medium.com` サブドメイン、全文フィード（`content:encoded`/Atom `content`。
     ingest 時点で `NormalizedArticle.body` に載る＝ページ取得不要）、多くの通常ページ。
  - `medium.com/*` 本体の HTML 記事ページは常時 403 ボットチャレンジ（人間向けパスへの Bot アクセス）。
  - **Medium 本文は「正規のフィード経路」で全文取得できる（実証）**: 著者フィード `medium.com/feed/@author`・
    publication フィード `medium.com/feed/{slug}`・サブドメイン `{sub}.medium.com/feed` が HTTP 200 で
    `content:encoded`（全文）を返す。403 で弾かれた記事も著者フィードでは全文取れた。
- **抽出**: Medium は `<main>` 無し `<article>` 有り。現 `resolveFeedBody` は `main`→全ページで
  boilerplate 混入。`main`→`article`→全体 ＋ nav/footer/aside/header 除外にすべき。
- **トークン/コスト**: bge-m3 8192tok / `config.embedding.maxInputChars=20000` で truncate すれば足りる。
  件数 34〜59/日。
- **制約**: 記事本文は D1・KV・ログ・step 戻り値に保存しない（法務原則）。本文は step 内メモリでのみ扱う。

### アクセスの倫理（確定）
Medium の robots.txt がブロックするのは **AI 学習・大規模収集クローラ**（GPTBot/ClaudeBot/Amazonbot/
Bytespider/Applebot‑Extended/meta‑externalagent/GoogleOther）で、検索クローラ（Googlebot/Applebot）・
RSS リーダーは許可（Applebot 可・Applebot‑Extended だけ不可＝「検索は可・AI 学習は不可」の明示）。
本ツールは**学習でも大規模収集でも再配布でもない私的・一過性の要約**（本文非保存）なので、feed 全文の
利用は Medium が拒否する用途に当たらない、と判断。**良き市民ルール**を守る: 正直な UA（`ai-curator`・偽装
しない）／robots の Disallow を踏まない・学習収集しない／低レート＋キャッシュ／本文非保存・非再配布・私用
限定／発行者の新たな拒否 signal に従う。ToS 明文は別レイヤーで未確認（私用・非再配布前提の実務判断）。

## 2. 設計判断（確定）

- **価値の本体は content-based ランキング（embedding の本文化）**。正しい記事を正しい順で浮かせる。
  ランキングが本文駆動になれば、本文が取れない記事は弱い signal（スニペット）で自然に沈み、上位に
  出にくくなる。
- **grouping（メイン/タイトルのみの明示分割）は投機的に作らない**。embedding 改善後に「本文なし記事が
  上位に残って邪魔」「別枠表示の需要がある」と**観測で実証されたときだけ**やる（不要なら丸ごと捨てる）。
- Medium 本文はフィード経由で回収する（HTML ページを叩かない）。
- 本文は一度解決したら embedding と要約で使う。取得不能はふりをしない（要約を作らない）。
- Browser Rendering は今回スコープ外（将来オプション）。
- 今日デプロイ済の Qwen3 要約・構造化描画・digest_metrics の上に乗せる。

## 3. PR 構成

各 PR は単独でデプロイ可能・価値を生む・システムを壊さないことを満たす。

### PR1: content-based ランキング（価値の本体・自己完結）— スキーマ変更なし
| # | タスク | 概要 |
|---|--------|------|
| 1 | 本文抽出の改善 | `resolveArticleBody`: main→article→whole ＋ nav/footer/aside/header 除外。共通化 |
| 1b | Medium フィード経由の本文回収 | 記事URL→著者/publicationフィード導出→`content:encoded` を本文に。良き市民ルール遵守 |
| 3 | embedding の本文化 | ingest で本文を解決し、本文で embedding。取得不可はスニペットへフォールバック |
| G | 劣化止め（最小） | body が空/極小なら要約を作らない（退化要約「本文抜粋が提供されていません」を出さない） |

- 改善した `resolveArticleBody`/Medium フィード経路は **summarize も使う** → ランキングも要約も同時に改善
  （Medium 本文回収の恩恵が両方に効く）。
- **スキーマ変更なし**（`embedding` 列は既存、入力を本文へ変えるだけ）。`content_available`/`tier` は作らない。
- viewer は不変（従来表示のまま、ランキングだけ良くなる）。

### 観測ゲート（PR1 デプロイ後・チューニング）
- 手動 run → 実フィードを確認: 本文ベースのランキングが妥当か／`resolveArticleBody` の取得率（source別）／
  本文なし記事が上位に残って邪魔か／退化要約が消えたか。
- 取得率は `console.log`（Workers Logs）と、必要なら記事本文長のスポット確認で見る（専用テーブルは作らない）。
- この観測結果で **PR2 をやるか・不要か**を判断する。

### PR2: grouping ＋ 2 セクション表示（条件付き＝観測で必要と分かったときだけ）
| # | タスク | 概要 |
|---|--------|------|
| 2 | 本文分類とスキーマ | `articles.content_available` ＋ migration。ingest 分類 |
| 4 | feed のグループ分け | `feed_entries.tier` ＋ migration。score が振り分け |
| 5 | 要約のグループ対応 | メインのみ要約（PR1 の劣化止めを tier ベースへ格上げ） |
| 6 | ビューアの2セクション | メイン ＋「タイトルのみ」を分けて描画 |

- PR1 の観測で「grouping 不要（ランキングが沈めて十分・別枠需要なし）」なら**着手しない**。

## 4. 各タスクの詳細（PR1）

### タスク1: 本文抽出の改善（`resolveArticleBody`）
- **対象**: `app/src/adapters/feed.ts`（`resolveFeedBody` 改修/改称）、`app/src/adapters/feed.test.ts`
- **作業内容**: 抽出カスケードを `root:"main"`→`root:"article"`→全体 の順に最初の非空を採用。
  各段 `exclude:["nav","footer","aside","header"]`。インライン全文（`article.body`）は最優先（ページ取得しない）。
- **参考**: 既存 `resolveFeedBody`(feed.ts:200-)、`htmlToText` の root/exclude（void 要素を渡さない注意）。

### タスク1b: Medium フィード経由の本文回収
- **対象**: `app/src/adapters/feed.ts`、`app/src/adapters/feed.test.ts`
- **作業内容**: 記事URL→フィードURL導出（`medium.com/@h/…`→`medium.com/feed/@h`、
  `medium.com/{pub}/…`→`medium.com/feed/{pub}`、`{sub}.medium.com/…`→`{sub}.medium.com/feed`）。
  取得して `guid`/`link` 一致 item の `content:encoded` を本文に採用。body 解決順: インライン全文 →
  Medium フィード導出 → 通常ページ取得。フィードはソース単位でキャッシュ。roll-off/欠落は次手段/フォールバック。
- **良き市民ルール（必守）**: 正直 UA・robots の Disallow を踏まない・低レート＋キャッシュ・本文非保存・私用限定。
- **参考**: `fetchFeed`/`parseFeed`（`content:encoded`→body パースは既存）。

### タスク3: embedding の本文化
- **対象**: `app/src/pipeline/daily.ts`（ingest に本文解決を追加、`embeddingInput`）
- **作業内容**: ingest の生存記事で `resolveArticleBody` により本文を解決（インライン→Mediumフィード→ページ）。
  本文があれば本文（`maxInputChars=20000` で truncate）で embedding、無ければ従来 `title + feedSummary`。
  本文は step 内メモリのみ・保存しない。
- **注意**: ingest でのページ取得が増える（全文フィードは inline で不要）。件数 34〜59/日で許容。
- **参考**: `ingestFeed`(daily.ts:231-)、`embeddingInput`(daily.ts:197)、embedding 呼び出し(daily.ts:312-)。

### タスクG: 劣化止め（最小）
- **対象**: `app/src/pipeline/daily.ts`（`summarizeFeed`）or `app/src/lib/summarize.ts`
- **作業内容**: summarize に渡す本文が空/極小なら LLM を呼ばず要約を作らない（summaries 行を作らない）。
  ビューアは要約なしで表示（既存の「summary が null なら省略」挙動を使う）。
- **参考**: `summarizeEntries`(summarize.ts) の body 解決、viewer の `entry.summary === null` 分岐(index.ts)。

## 5. 修正対象ファイル（PR1）
- `app/src/adapters/feed.ts` / `feed.test.ts` — 抽出カスケード・Medium フィード本文回収
- `app/src/pipeline/daily.ts` / `daily.test.ts` — ingest の本文解決＋embedding 本文化、空 body の劣化止め
- （必要なら）`app/src/lib/summarize.ts` / `summarize.test.ts` — 空 body ガード
- `docs/05_v1_work_plan.md` / `DEPLOY.md` — 設計追記

## 6. 検証方法（PR1）
- `cd app && npm run typecheck && npm test`（TDD: 抽出カスケード・Medium フィード導出/一致・embedding が本文を使う・
  空 body で要約を作らない、をユニットで固定）
- 実 Workers AI での本番パス検証（手動 run 1回）: ランキングが本文ベースで妥当か、Medium 本文が回収されるか、
  退化要約が消えたかを実フィード＋Workers Logs で確認

## 7. 推奨する実行方法
- **PR1 を `/dev-workflow` で実装**（タスク 1・1b・3・G はサブエージェントに割れる粒度、TDD）。
- デプロイ後に**観測ゲート**を通し、PR2（grouping）が必要かを判断。不要なら作らない。
- migration・本番デプロイは実装・検証完了後にユーザー承認のうえ実施。

## 8. 実装レビューで確定すべき残論点
- 「本文あり」とみなす本文長の下限（embedding 本文化・劣化止めの閾値。例 500字）。
- `hashInput`(SimHash) も本文ベースにするか（重複判定精度 vs 軽量性。現状維持でも可）。
- （PR2 に進む場合のみ）分類閾値・tier ランキング・表示位置・migration 粒度。
