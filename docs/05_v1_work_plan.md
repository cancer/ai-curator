# 実装計画: AI curator 実運用 v1

## 1. Context（背景・目的）

パーソナル情報収集システム AI curator の本番 v1 を Cloudflare スタック上に実装する。

- 要件: `docs/01_requirements.md` / 仕様: `docs/02_specification.md` / 設計: `docs/03_design.md`
- PoC は検証①〜④すべて合格済み（`docs/poc_results.md`）。本計画は PoC の実測知見を織り込み済み
- **PoC コード（`poc/`）を参照・流用してはならない**。実装に必要な知見はすべて本書に転記してある。本書と docs/01〜03 だけで実装を完結させること

### v1 スコープ（本計画で確定させた判断）

| 論点 | v1 の判断 | 根拠 |
|---|---|---|
| LLM 要約の生成範囲 | **全件を日次バッチで生成**（2026-07-09 改定）。フィードに載る全記事に要約を付ける | コストは無料枠 1% 未満で制約でないため体験優先で全件。上位N件限定・「開いた時に要約」は不採用 |
| 傾向サマリの時系列比較 | なし（当日分のみ） | 要件 FR-6.1 の未確定論点。日次集計の保存は v2 で判断 |
| Queues / Vectorize | 使わない（直列 fetch / D1 内ベクトル） | 設計 §6 の段階導入方針どおり |
| フィードバック | **収集（クリック記録・👍/👎）は v1 に含める**。学習（プロファイル還流）は v2 | FR-5（2026-07-08 更新）。収集しないと v2 学習の開始時データがゼロになる。明示ルール（ドメイン填/除外）は v2 のまま |
| 設定管理 UI | **v1 に含める**（ソース・関心軸の Web 編集画面） | FR-8（2026-07-08 追加）。マルチデバイス利用のため CLI 前提では成り立たない |
| Worker 構成 | **単一 Worker**（cron 1 本〔日次〕 + fetch ハンドラ）（2026-07-09 改定） | 取得〜要約を 1 パスに統合。2 系統分離は廃止（原文非保存でメモリ使い回しできるため中間状態が不要） |
| digest LLM モデル | `config.ts` の `SYSTEM_CONFIG.digest.model` にコード固定（2026-07-09 改定。v1 は UI 非公開・変更はコード編集）。初期値は運用前に選定 | PoC で llama-3.2-3b の日本語品質が不十分と実測済み。KV には保存しない |

## 2. 前提知識: PoC の実測で判明した事実（実装に必ず織り込む）

PoC コードを見ずに実装するために、以下をすべて本書の該当タスクに反映してある。背景として通読すること。

1. **フィードによっては本文全文が feed 内に入っている**（例: Medium 著者 feed は `content:encoded`、martinfowler.com の Atom は `content` に本文 HTML を含む）。汎用フィードは feed 内の本文（`content:encoded`/`content`/`description`）を優先して使い、記事ページの fetch を避ける。**Medium の記事ページはそもそも直接 fetch できない**（Cloudflare ボットチャレンジで "Just a moment..." が返る）ため、feed 内本文が無い場合のリンク先取得は失敗しうる（→ スニペット→タイトルにフォールバック）
2. **feed 内本文にはボイラープレートが混じることがある**（タイトル・日付・著者・タグ・目次など）が、要件 FR-2 のとおりノイズは Embedding 時に関連度が低く埋もれるため、汎用フィードは粗いタグ除去（root/exclude を指定しない HTML→テキスト）で足りる。かつての Fowler 専用の `<main>` 抽出＋除外セレクタ列は不要になった（廃止）
3. **HTMLRewriter には癖が 3 つある**（タスク 4 に対処を明記）
4. **fast-xml-parser は既定のエンティティ展開上限 1000 で本文入り feed の parse に失敗する**（本文 HTML をエスケープして含む feed はエンティティが数千個に達する）
5. **bge-m3 は 1 シーケンス 8,192 トークンが実効上限**（"Sequence too long" エラー。料金ページの context window 60,000 は 1 リクエスト合計の上限で別物）。**複数記事のバッチ Embedding は上限超過で失敗する**ため 1 記事 1 リクエストとする
6. **技術系テキストのトークン数は文字数からの見積りを大きく上回る**（実測: 短いタイトル 50 件で見積 807 → 実測 11,150 トークン、約 14 倍）。文字数ベースの切り詰めは保守的に（2.5 chars/token 換算）
7. **外部 fetch は間欠的に失敗する**（GitHub API で `Malformed_HTTP_Response` を複数回観測）。すべての外部 fetch にリトライを入れる
8. **Embedding モデルはランキングをモデル間で大きく変える**（bge-m3 と qwen3 で上位 10 の一致が 3〜4/10）。モデル入替は全記事の再 Embedding を意味し、本文非保存のため再 fetch 頼みになる。**ベクトルには必ず生成モデル名を併記**する
9. **コストは制約にならない**（PoC 実測の桁感: Embedding 1 記事 ~数 neurons、LLM 要約 1 件 ~5 neurons［小型モデル］）。全件要約でも neurons は記事件数に比例するだけで、個人規模なら無料枠 10,000 neurons/日に対し十分小さい。正確な値はモデルと記事件数が決まってから見積もる（総量は予測せず運用実測で確認）
10. **llama-3.2-3b-instruct の日本語要約は品質不十分**（中国語混入・カタカナ誤り・未翻訳残り）。日本語品質でモデルを選び直す
11. **本文取得は失敗しうる**（`description` のみで本文を持たないフィード、HN やフィードのリンク先外部ページが SPA・ペイウォール・ボットブロック等で取得できないことがある）。全件要約では全記事の本文取得を試みるが、**取得失敗時はスニペット→タイトルの順でフォールバック**し、1 件の失敗で日次パス全体を止めない
12. **法務原則**: 他者の著作物の完全複製を保存しない。記事本文は処理中のみメモリで扱い、DB・ログ・テスト fixture のどこにも書かない。テスト fixture は完全に架空の合成データを自作する（実記事のコピペ禁止）

## 3. 全体構成

```
リポジトリ構成（新規作成分）:
app/
  wrangler.jsonc          # 単一 Worker。cron 2 本 + D1/AI/KV バインディング
  package.json
  tsconfig.json
  vitest.config.ts        # @cloudflare/vitest-pool-workers
  migrations/             # D1 マイグレーション SQL
  src/
    index.ts              # entrypoint: scheduled(cron 分岐) + fetch(Viewer)
    config.ts             # KV から設定をロード・検証
    lib/                  # 共通ユーティリティ（タスク 4）
    adapters/             # ソースアダプタ（汎用フィード + GitHub + HN。タスク 5）
    pipeline/             # fetch 系・feed 系のパイプライン（タスク 6, 8）
    viewer/               # フィード表示（タスク 9）
  test/
    fixtures/             # 合成データのみ（実記事コピペ禁止）
```

実行系統（設計 §1）:

- **日次パス（cron 1 本・1 日 1 回）**: 全ソースの当日分を全件取得（ページング）→ 正規化 → SimHash Dedup → D1 保存（メタのみ）→ 関心軸同期 → 各記事 Embedding（title + フィード提供テキスト）→ 意味的 Dedup → スコアリング → feed_entries/feed_trends 生成 → **全件**本文取得 + LLM 要約 → 派生物のみ保存・原文テキストは破棄。取得したフィード提供テキスト/本文は同一パス内でメモリのまま使い回す
- **fetch ハンドラ**: Viewer（ランク付きフィード表示、もっと見る式ページング）。Cloudflare Access で保護

## 4. 対応一覧

| # | タスク | 概要 | 依存 |
|---|--------|------|------|
| 1 | プロジェクト scaffold | wrangler 設定・バインディング・テスト基盤 | - |
| 2 | D1 スキーマ | migrations 作成・適用 | #1 |
| 3 | KV 設定ロード | 関心軸・監視対象・パラメータの外部化 | #1 |
| 4 | 共通ユーティリティ | URL 正規化 / retry / htmlToText / XML parse | #1 |
| 5 | ソースアダプタ | 汎用フィード（RSS/Atom）+ GitHub + HN | #4 |
| 6 | 取得パイプライン（日次パス前半） | 全件取得・SimHash Dedup + D1 保存（メタ） | #2 #3 #5 |
| 7 | Embedding クライアント + 関心軸同期 | Workers AI bge-m3 呼び出しと制約対応 / ラベル→LLM 記述文→Embedding の軸同期（日次パスで統合） | #1 |
| 8 | Feed Builder（日次パス後半） | Embedding・意味的 Dedup・スコアリング・全件要約・傾向サマリ | #2 #3 #6 #7 |
| 9 | Viewer | ランク付きフィード + もっと見る + 傾向表示 | #8 |
| 10 | デプロイ・Access 設定・運用確認 | 本番投入手順 | #9 |

## 5. 各タスクの詳細

### タスク 1: プロジェクト scaffold

- **対象**: `app/wrangler.jsonc` `app/package.json` `app/tsconfig.json` `app/vitest.config.ts` `app/src/index.ts`（骨組み）
- **作業内容**:
  - wrangler.jsonc:
    - `compatibility_date` は実装日の日付
    - `triggers.crons`: `["0 21 * * *"]`（1 日 1 回・日次パス。21:00 UTC = 朝 6 時 JST に朝のフィードができる）（2026-07-09 改定：cron を 1 本に統合）
    - バインディング: `ai`（binding: `AI`）、`d1_databases`（binding: `DB`）、`kv_namespaces`（binding: `CONFIG`）
    - `observability.enabled: true`
  - `src/index.ts` の `scheduled` ハンドラは単一の日次パス（`runDaily(env)` 等）を呼ぶ（cron が 1 本なので分岐不要）
  - テストは `@cloudflare/vitest-pool-workers`（workerd 実行のため HTMLRewriter がテストでもそのまま使える）
  - 依存パッケージは最小にする: `wrangler` `typescript` `vitest` `@cloudflare/vitest-pool-workers` `fast-xml-parser` のみ。HTML 処理はランタイム組み込みの HTMLRewriter を使い、cheerio 等の HTML パーサ依存を追加しない
- **注意**: wrangler の設定キー名はバージョンで変わることがある。実装時に公式ドキュメント（https://developers.cloudflare.com/workers/wrangler/configuration/）で確認する

### タスク 2: D1 スキーマ

- **対象**: `app/migrations/0001_init.sql`
- **作業内容**（設計 §3 のたたき台を正とする）:

```sql
CREATE TABLE articles (
  id            INTEGER PRIMARY KEY,
  url           TEXT NOT NULL UNIQUE,   -- 冪等キー = 正規化済み URL
  title         TEXT NOT NULL,
  source        TEXT NOT NULL,          -- 例: feed:{フィードURL}, github:owner/repo, hn
  published_at  TEXT NOT NULL,          -- ISO 8601
  -- feed_summary 列は持たない（原文由来のため非永続。2026-07-09 改定）
  content_hash  TEXT,                   -- SimHash（16進文字列。title+フィード提供テキストから算出）
  embedding     TEXT,                   -- JSON 数値配列。日次パスが書く
  embedding_model TEXT,                 -- ベクトル生成モデル名。embedding とセットで必須
  score         REAL,
  hit_axis      TEXT,                   -- max cosine を与えた関心軸 id
  created_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_articles_created ON articles(created_at);

CREATE TABLE interest_axes (
  id         INTEGER PRIMARY KEY,
  axis_id    TEXT NOT NULL UNIQUE,      -- 例: web-fw, ai, agentic-coding, software-design
  label      TEXT NOT NULL,             -- ユーザー入力のトピックラベル（日本語可。例: Web フレームワーク）
  label_hash TEXT NOT NULL,             -- label の SHA-256。設定変更の検知用（タスク 7）
  embedding  TEXT NOT NULL,             -- JSON 数値配列（label→LLM 記述文→Embedding で生成）
  embedding_model TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- フィードバック（v1 は収集のみ。学習での利用は v2）
CREATE TABLE feedback (
  id          INTEGER PRIMARY KEY,
  article_id  INTEGER NOT NULL REFERENCES articles(id),
  kind        TEXT NOT NULL CHECK (kind IN ('click', 'up', 'down')),
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_feedback_article ON feedback(article_id);

CREATE TABLE feed_entries (
  id          INTEGER PRIMARY KEY,
  date        TEXT NOT NULL,            -- YYYY-MM-DD（フィード生成日）
  article_id  INTEGER NOT NULL REFERENCES articles(id),
  rank        INTEGER NOT NULL,         -- スコア降順 1 始まり
  summary     TEXT,                     -- LLM 要約（全件生成。本文取得失敗時のみ NULL）
  UNIQUE(date, article_id)
);
CREATE INDEX idx_feed_date_rank ON feed_entries(date, rank);

CREATE TABLE feed_trends (
  id         INTEGER PRIMARY KEY,
  date       TEXT NOT NULL,
  axis_id    TEXT NOT NULL,
  hit_count  INTEGER NOT NULL,
  narrative  TEXT,                      -- LLM による軸別の傾向叙述
  UNIQUE(date, axis_id)
);
```

- **禁止**: 本文（body）カラムを追加しないこと。前提知識 12
- **適用**: `wrangler d1 migrations apply <db> --local`（開発）/ `--remote`（本番）

### タスク 3: KV 設定ロード

- **対象**: `app/src/config.ts`
- **作業内容**:
  - 設定を 2 層に分ける（設計 §6.1）。**KV に置くのは可変データ（`interestAxes` / `sources`）のみ**で、
    設定画面（タスク 9）から投入・編集する（コードやファイルに手書きしない。`config.json` は使わない）。
    system パラメータ（`scoring` / `embedding` / `digest`）は v1 では **コード内固定**（`SYSTEM_CONFIG`）で、
    UI 非公開・変更はコード編集。
  - KV に置く UserConfig のスキーマ（この形をそのまま実装する）:

```jsonc
{
  "interestAxes": [
    { "id": "web-fw", "label": "Web フレームワーク" }
    // ラベルは自然言語（日本語可）。軸ベクトルは日次パスの軸同期で
    // ラベル→LLM 記述文→Embedding により自動生成する（seedText 手書きは廃止）
  ],
  "sources": {
    "feeds": ["https://martinfowler.com/feed.atom", "https://medium.com/feed/@author"],
    "githubRepos": ["owner/repo", "..."],
    "hnMinPoints": 50
  }
}
```

（`feeds` は任意の RSS/Atom フィード URL のリスト。Medium・martinfowler.com もここに URL として並べる。旧 `mediumAuthorFeeds`/`mediumTagFeeds`/`fowlerFeed` は `feeds` に統合し廃止。2026-07-09 改定）

  - system パラメータはコード定数 `SYSTEM_CONFIG`（`scoring` / `embedding` / `digest`）に固定。
    `digest.model` は運用前にコードで選定値へ差し替える前提の暫定既定（`llama-3.2-3b` は使わない）。
    数値は暫定確定値（PoC で「上位/下位の分離が機能する」ことを確認済みの値）。
  - `loadConfig(env)` は KV の UserConfig を検証（fail-fast: 欠落・型不一致・空 interestAxes は即 throw。
    黙って既定値にしない）し、`SYSTEM_CONFIG` をマージして完全な `Config` を返す。
- **投入は設定画面から**: `config.json` も `wrangler kv key put` も使わない。デプロイ後にブラウザで
  `/settings` を開くと、初回は既定値（`DEFAULT_USER_CONFIG`）が入った状態でフォームが開くので、
  関心軸・ソースを入力して保存する。Worker 側から `env.CONFIG.put("config:v1", ...)` で書き戻すため、
  KV の値が常に最新の正。
- 読み書きが 1 箇所になるよう、`loadConfig(env)`・`saveConfig(env, user)`（UserConfig のみ書く。
  バリデーション込み）・`loadUserConfigForForm(env)`（空 KV でも throw せず既定を返す。フォーム用）を
  config.ts に置く。バリデーション違反の保存は 400 で拒否（壊れた設定で cron を走らせない）

### タスク 4: 共通ユーティリティ

- **対象**: `app/src/lib/normalize.ts` `app/src/lib/retry.ts` `app/src/lib/html.ts` `app/src/lib/xml.ts`
- **作業内容**:

**(a) URL 正規化 `normalizeUrl(raw: string): string`**
  - クエリのうちトラッキング系（`utm_*` プレフィックス、`source`、`ref`、`fbclid`、`gclid`）を除去
  - フラグメント（`#...`）除去。それ以外のクエリは保持（HN の `item?id=` を壊さない）
  - 不正 URL は throw（握りつぶさない）
  - これが articles.url の冪等キーになる（Medium は `?source=rss------...` が付くため、正規化しないと同一記事が重複する）

**(b) リトライ `fetchWithRetry(url, init?, options?): Promise<Response>`**
  - ネットワーク例外と HTTP 5xx を最大 3 回リトライ、指数バックオフ 1s → 2s → 4s
  - 4xx は即座に Response を返す（呼び出し側が `!res.ok` で throw する）
  - リトライ枯渇時: 例外は最後の例外を throw、5xx は最後の Response を返す
  - テスト用に fetch 関数と sleep 関数を引数で差し替え可能にする（実時間を待たないテストにする）
  - **すべての外部 fetch（4 アダプタ + 記事ページ取得）で必ずこれを使う**（前提知識 7）

**(c) HTML→テキスト `htmlToText(html: string, options?: { root?: string; exclude?: string[] }): string`**
  - HTMLRewriter で実装（Workers 組み込み。外部依存なし）
  - `root`: このセレクタの内側だけ収集（未指定なら全体）。`exclude`: このセレクタのサブツリーは収集しない。`script`/`style` は常に除外
  - **HTMLRewriter の癖への対処（3 点とも必須。PoC 実測）**:
    1. `el.remove()` しても、別セレクタの text ハンドラは除去済み要素の中身でも発火する。**除外は remove ではなくカウンタ方式で実装する**: 除外セレクタの element ハンドラで `skipDepth++`、`el.onEndTag(() => skipDepth--)`、text ハンドラは `skipDepth === 0` のときだけ収集
    2. ブロック要素間に空白が入らない（`<h1>A</h1><p>B</p>` → "AB"）。ブロック要素（p, div, h1-h6, li, br, tr, td 等）の element ハンドラで区切り空白を push する
    3. text ノードの HTML エンティティはデコードされない（`&amp;` が残る）。収集後に数値参照（`&#123;` `&#x1F;`）と代表的な名前付き（amp/lt/gt/quot/apos/nbsp/mdash/ndash/hellip/引用符類）をデコードする
  - **制約をコメントに明記**: `root`/`exclude` に **void 要素（img, br, hr 等）のセレクタを渡してはならない**。onEndTag が発火せずカウンタが戻らないため、以降のテキストが黙って欠落する（PoC 実測）
  - 最後に空白を正規化（連続空白 → 1 個、trim）

**(d) XML パーサ設定 `feedParserOptions`**
  - fast-xml-parser を使う。**既定のエンティティ展開上限（maxTotalExpansions=1000）では本文入り feed の parse に失敗する**（前提知識 4）
  - フラットな展開回数上限のみ引き上げ（例: 100,000）、再帰深さ制限（billion-laughs 対策）は既定の厳しい値のまま残す
  - 本文 HTML をエスケープして含む汎用フィード（Medium 著者 feed・martinfowler.com の Atom など）の parse でこの設定を使う

- **テスト**: (a)〜(d) すべてユニットテスト必須。エッジケース（不正 URL、リトライ枯渇、void 要素の誤用検知は不可な旨、エンティティ 3000 個超の合成 XML）を含める

### タスク 5: ソースアダプタ（汎用フィード + GitHub + HN）

- **対象**: `app/src/adapters/feed.ts`（汎用 RSS/Atom）`github.ts` `hn.ts` と `app/src/adapters/types.ts`
- **共通インターフェース**:

```ts
interface NormalizedArticle {
  url: string;          // normalizeUrl 済み
  title: string;
  source: string;
  publishedAt: string;  // ISO 8601
  feedSummary?: string;
  body?: string;        // 一時データ。D1 に書いてはならない
}
```

**(a) 汎用フィード（RSS/Atom・主軸）**
  - 入力は `config.sources.feeds`（任意のフィード URL リスト）。各 URL を fetch し、タスク 4(d) の `feedParserOptions` で parse する。RSS（`<item>`）と Atom（`<entry>`）の両形式を扱う
  - item/entry ごとに抽出:
    - `url`: RSS は `<link>` テキスト、Atom は `<link rel="alternate">` の `href`。**normalizeUrl 必須**（Medium は `?source=rss------...` が付くため、正規化しないと同一記事が重複する）
    - `title`: `<title>`
    - `publishedAt`: RSS `pubDate`（RFC 2822 → `new Date(...).toISOString()`）/ Atom `published`（無ければ `updated`。ISO 8601）
    - `feedSummary`: RSS `description` / Atom `summary` を htmlToText。**無ければ本文（下記 body）の先頭を流用**して埋める（Embedding 入力が title のみに退化しないように。前提: Embedding は title + feedSummary — タスク 8）
    - `body`（要約用の一時データ）: **`content:encoded`（RSS）→ `content`（Atom）→ `description` の優先順**で feed 内本文を取り、htmlToText でテキスト化。いずれも無ければ body は空のままにし、要約段（タスク 8）でリンク先取得を試みる
    - `source`: `feed:{フィードURL}`
  - **記事ページの直接 fetch はアダプタでは行わない**。本文が feed 内に無い場合のリンク先取得は要約段（タスク 8）で行う（任意サイトはボットチャレンジ・SPA・ペイウォール等で失敗しうるため、粗いタグ除去＋フォールバックで扱う。前提知識 1・2・11）
  - **当日ウィンドウ内の item を全件対象**にする（フィードの返す範囲で `publishedAt` が当日ウィンドウ内のものを採る）
  - Medium・martinfowler.com も専用扱いせず、この汎用アダプタでフィード URL として処理する（Medium 著者 feed は `content:encoded`、Fowler Atom は `content` に本文が入るため、いずれも feed 内本文で足りる）

**(b) GitHub Releases**
  - `GET https://api.github.com/repos/{owner}/{repo}/releases?per_page=100&page=N`、ヘッダ `user-agent` 必須（無いと 403）。**当日ウィンドウ内のリリースを全件取得**（`published_at` が当日ウィンドウを下回るページに達するまで `page` を進める。先頭 10 件で打ち切らない）
  - `draft: true` と `prerelease: true` は除外。`title = name ?? tag_name`、`body` = release note（markdown のまま可）、`publishedAt = published_at`、`source = github:owner/repo`
  - 未認証はレート制限 60 req/h/IP。日次 1 回 × リポジトリ数 × ページング分の呼び出しになるため、リポジトリが多い場合は制限に触れうる。429/403 with rate-limit はリトライ対象外として警告ログを出し、そのソースはスキップして続行する

**(c) Hacker News（Algolia API）**
  - `GET https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=points%3E{minPoints},created_at_i%3E{当日ウィンドウ下限}&hitsPerPage=...&page=...` で**当日ウィンドウ内を全ページ取得**（`nbPages` まで `page` を進める。先頭 30 件で打ち切らない）
  - `url` が null の self-post は `https://news.ycombinator.com/item?id={objectID}` にフォールバック。`story_text` があれば htmlToText して feedSummary に。`source = hn`
  - キーワード事前フィルタはしない（絞り込みは Scorer の仕事）。**リンク先の外部ページを取得し、粗いタグ除去（root/exclude なしの htmlToText）で本文化する**。任意サイト向けの個別抽出は書かない。取得失敗（SPA・ペイウォール・非 HTML・ボットブロック等）や本文が空/極端に短い場合は story_text→タイトルにフォールバック。この本文取得は要約用で、日次パスの要約段で行う

- **テスト**: 各アダプタの parse 関数を fixture でテストする。**fixture は完全に架空の合成データを自作する**（実在記事・実在 feed のコピペは禁止。前提知識 12）。形式（フィールド名・ネスト構造・CDATA・エスケープ済み HTML）だけ本物を模し、文章・URL・著者名はすべて架空にする。汎用フィードは RSS（`content:encoded` あり/なし）と Atom（`content` あり/なし）の両方、および `description` のみのケースを網羅する

### タスク 6: 取得パイプライン（日次パス前半）

- **対象**: `app/src/pipeline/fetch.ts` `app/src/lib/simhash.ts`
- **作業内容**:
  - 流れ: 全ソースを順に fetch（直列でよい）→ normalize → SimHash 計算 → D1 保存
  - **SimHash**: 64bit。入力は `title + " " + (feedSummary ?? "")`（本文は使わない — 保存対象と揃え、本文有無でハッシュが変わらないように）。トークン分割は空白 + 記号区切りの単純な word 分割で足りる。ハミング距離 3 以下を重複とみなし、**直近 7 日の articles の content_hash と比較**して重複は insert しない
  - D1 保存: `INSERT INTO articles (url, title, source, published_at, content_hash) VALUES (...) ON CONFLICT(url) DO NOTHING`（冪等キー = 正規化 URL。再実行・重複 fetch に安全）。**feed_summary は列ごと廃止したので保存しない**
  - フィード提供テキスト・body はこの段では保存しない。フィード提供テキストは SimHash と（後続段の）Embedding 入力に使うため、同一日次パス内でメモリに保持して使い回す。feed 内に本文が無い記事（`description` のみのフィード・HN リンク先など）の本文は、後半の全件要約段でリンク先を取得する
  - 1 ソースの失敗で全体を止めない: ソース単位で try/catch し、失敗ソースはログに残して続行。全ソース失敗時のみ throw（cron 失敗として observability に出す）
- **テスト**: SimHash の性質（同一文字列 → 同一ハッシュ / 1 語違い → ハミング距離小 / 無関係文 → 距離大）、ON CONFLICT の冪等性

### タスク 7: Embedding クライアント

- **対象**: `app/src/lib/embedding.ts`
- **作業内容**:
  - `env.AI.run(model, { text: [input] })` を使う（バインディング経由。REST 直叩き・トークン管理は不要）
  - **1 記事 1 リクエスト**（前提知識 5。複数記事をまとめると合計トークン上限を超えて失敗する）
  - 入力は `config.embedding.maxInputChars`（20,000 字）で切り詰める。根拠: bge-m3 の実効上限 8,192 トークン × 保守的な 2.5 chars/token（前提知識 6。技術テキストはトークン効率が悪い）
  - 連続呼び出しは 150ms 間隔を空ける
  - 5xx・例外はタスク 4(b) と同方針でリトライ（AI バインディング呼び出しにも一時エラーがある。PoC 実測）
  - 返り値: `{ vector: number[], inputTokens?: number }`。レスポンスの `meta`（`cost_metric_value_1` = input tokens, `neurons`）があれば記録し、実行サマリのログに合計を出す（コスト監視。ダッシュボードとの突き合わせ用）
  - Embedding を保存する際は **`embedding_model` カラムに必ずモデル名を書く**（前提知識 8）。読み出し時はモデル名が一致するベクトルだけを比較に使う
- **関心軸ベクトルの同期**（2026-07-09 改定。ラベルから自動生成）: 日次パスの Embedding 段の冒頭で interest_axes を読み、`config.interestAxes` の各軸について次のいずれかに該当したら軸ベクトルを再生成して upsert する: (a) テーブルに未登録 (b) `sha256(label) ≠ label_hash`（設定画面でのラベル変更検知） (c) `embedding_model` が config と不一致（モデル入替）。config から消えた軸は行を削除する
  - 再生成の手順: **ラベル → LLM（`config.digest.model`）で関心記述文を生成 → 記事と同一の Embedding モデルでベクトル化**。ユーザーはラベル（日本語可）しか与えないので、埋め込み用の記述文はここで機械生成する。生成記述文は保存不要（埋め込みに使って破棄し、`embedding` / `label_hash` / `embedding_model` のみ保存する）
  - LLM 呼び出し（記述文生成）: `env.AI.run(config.digest.model, { messages, max_tokens: ... })`。system プロンプト例: 「次のトピックについて、関連記事を検索するための関心記述文を 2〜3 文で書いてください。」 user: ラベル。要約用と同じ生成モデルを使うため、この段でも生成 LLM が要る（Embedding クライアントに加えて `env.AI` のテキスト生成を呼ぶ）
  - **依存**: この同期関数は Embedding クライアント（本タスク）に加え、config（タスク 3）・interest_axes（タスク 2）・生成 LLM を使うため、日次パス（タスク 8）で各記事 Embedding の前段に組み込む。Embedding クライアント単体（`embedding.ts`）はタスク 1 だけで実装・テストできる
  - **限界（実装者注意）**: `label_hash` は記述文生成に使う LLM（モデル/プロンプト）の変更までは検知しない。記述文生成の仕様を変えたら、軸テーブルをクリアするかラベルを変えて明示的に再生成すること

### タスク 8: Feed Builder（日次パス後半）

- **対象**: `app/src/pipeline/feed.ts` `app/src/lib/score.ts` `app/src/lib/semantic_dedup.ts` `app/src/lib/summarize.ts`
- **作業内容**（この順で処理）:

1. **対象記事**: 当日ウィンドウ（`created_at` が過去 24 時間）の articles のうち `embedding IS NULL` のもの。単一パスなので通常はこの実行で取得・保存した記事群がそのまま対象になる（再実行時は既に埋め込み済みを飛ばす＝冪等）
2. **Embedding**: 各記事の入力テキストは `title + "\n" + (フィード提供テキスト ?? "")`（**title-summary 方式で確定**。PoC 実測: 入力に本文冒頭・全文を足してもランキングはほぼ変わらず[一致 8/10]。本文ページ取得は埋め込みには使わない）。フィード提供テキストは保存していないので、同一パス内でメモリ保持した値を使う。結果を articles.embedding / embedding_model に保存。埋め込みに失敗した記事はスキップ継続し、フィード構築対象は embedding が非 NULL かつモデル一致のものに限定する
3. **意味的 Dedup**: 当日記事同士の cosine 類似 ≥ `semanticDedupThreshold`（0.9）をクラスタ化（単純な貪欲法: 未割当記事を順に見て、既存クラスタ代表との類似が閾値以上なら合流）。代表 1 本 = ソース信頼度が高く公開日時が新しいもの。非代表はフィードから除外（articles には残す）
4. **スコアリング**: `score = 0.6 × interest + 0.3 × freshness + 0.1 × sourceTrust`
   - `interest = max(cosine(記事ベクトル, 各軸ベクトル))`、最大を与えた軸を hit_axis に記録
   - `freshness = 0.5 ^ (経過日数 / freshnessHalfLifeDays)`（公開日時から現在までの指数減衰）
   - `sourceTrust = config.scoring.sourceTrust[ソース種別]`（source 文字列の `:` より前で引く）
   - cosine は `dot(a,b) / (|a| × |b|)`。ゼロベクトルは 0 とする
5. **feed_entries 書き込み**: スコア降順に rank 1..N で当日分を insert（同日再実行に備え、先に当日分を delete）
6. **全件の要約生成**（フィードに載る全記事）:
   - 本文の取得: GitHub → release note / 汎用フィード → feed 内本文（`content:encoded`/`content`/`description`）があればそれ、無ければリンク先を粗いタグ除去（root/exclude なしの htmlToText）で本文化 / HN → リンク先を粗いタグ除去で本文化。単一パスなので前段でメモリ保持した本文/テキストがあればそれを使い、無いものだけ取得する
   - 取得失敗や本文が空/極端に短い場合はスニペット→タイトルの順でフォールバック。**失敗してもループを止めない**（1 件の失敗で全体を失わない。try/catch で件数をログ）
   - LLM 呼び出し: `env.AI.run(config.digest.model, { messages, max_tokens: 300 })`。system プロンプト: 「あなたは技術ニュースの編集者です。与えられた記事のタイトルと本文抜粋から、内容を 2〜3 文の**日本語**で要約してください。誇張や主観的評価を避け、記事の主旨を簡潔に伝えてください。」 user: `タイトル: {title}\n\n本文抜粋:\n{body の先頭 6,000 字}`
   - 生成した要約を feed_entries.summary に保存（自前生成物なので保存可）
7. **傾向サマリ（feed_trends）**: 軸ごとに hit_count（当日記事の hit_axis 集計）を出し、軸ごとに「その軸のタイトル上位 10 件」を入力に LLM で 1〜2 文の日本語叙述を生成して narrative に保存
- **digest LLM モデルの選定**（実装時に行う）: Workers AI のテキスト生成モデル一覧（https://developers.cloudflare.com/workers-ai/models/）から日本語対応を明記するモデルを 2〜3 候補選び、実記事 5 件で日本語要約品質を目視比較して初期値を決める。**llama-3.2-3b-instruct は日本語品質不十分のため選ばない**（前提知識 10）。モデル id は `SYSTEM_CONFIG.digest.model`（コード内固定）なので、運用前にコード編集で選定値へ差し替える（UI 非公開）
- **テスト**: score / cosine / freshness / 意味的 Dedup / SimHash 以外に、「本文なし記事が混ざっても要約ステップが落ちない」ことをモックでテスト

### タスク 9: Viewer + 設定画面 + フィードバック収集

- **対象**: `app/src/viewer/index.ts`（フィード表示）`app/src/viewer/settings.ts`（設定画面）`app/src/viewer/feedback.ts`（FB 収集）
- **前提**: 全ルートが Cloudflare Access の内側（タスク 10）。Access 未設定のうちは本番投入しない

**(a) フィード表示**
  - `GET /` : 最新 date のフィードを HTML で返す。構成は上から (1) 軸ごとの傾向サマリ（feed_trends: label・件数・narrative） (2) ランク順の記事リスト
  - 記事リストの各項目: rank・タイトル・媒体名・公開日時・ヒット軸ラベル・要約（あれば）・👍/👎 ボタン
  - **記事タイトルのリンク先は `GET /r/{feed_entry_id}`**（下記 (c) のクリック記録リダイレクト）。表示上は一次ソースの URL も併記する（出典の明示。FR-6）
  - ページング: `GET /?page=2` で rank 21〜40 を返す「もっと見る」リンク（1 ページ 20 件）。SPA にしない（素の HTML + リンクで足りる。シンプル優先）
  - デザインは最小限（システムフォント・シングルカラム）。CSS フレームワーク禁止。ただしモバイルで読める viewport 設定とタップ可能なボタンサイズは確保する（利用は主にスマホの想定）
  - **公開経路を作らない**: RSS 出力・共有リンク・SNS 投稿機能を実装しない（要件 FR-7）

**(b) 設定画面（FR-8）**
  - `GET /settings` : KV の UserConfig（`interestAxes` / `sources`。空なら既定）をフォームで表示。編集対象は (1) 関心軸（ユーザーが編集するのは**ラベルのみ**、軸の追加・削除。seedText 手書きは廃止） (2) ソース（`feeds`＝フィード URL リスト / `githubRepos` の各リスト、`hnMinPoints`）。scoring 等の system パラメータは v1 では表示のみ（誤操作防止。変更はコード編集 `SYSTEM_CONFIG` で）
  - **軸 `id` の採番**: `id` は `interest_axes.axis_id` / `articles.hit_axis` / `feed_trends.axis_id` から参照される安定キーなので、ラベルとは独立に軸の**追加時に一度だけ採番**し、以後ラベルを変えても不変とする（ラベルから slug 化しない。ラベル rename で過去の `hit_axis` 行が孤立するのを防ぐ）。ユーザーはラベルだけを編集し、`id` は UI に露出させない（採番方式は未確定。「迷った点」に記載）
  - `POST /settings` : バリデーション（label 非空、新規軸の `id` が既存と衝突しない、feed URL が http(s) の URL 形式、repo が `owner/name` 形式、数値範囲）を通れば `saveConfig` で KV を更新し、303 で `GET /settings` に戻す。エラーは 400 + 入力値保持
  - ラベルを変更した場合、次回の日次パスで関心軸ベクトルが自動再生成される（タスク 7 の label_hash 検知。ラベル→LLM 記述文→Embedding）。その旨を画面に注記する
  - フォームは素の HTML `<form method="post">`。JS 必須にしない

**(c) フィードバック収集（FR-5 の収集のみ。学習は v2）**
  - `GET /r/{feed_entry_id}` : feedback に `kind='click'` を insert → 一次ソース URL へ 302。該当 entry が無ければ 404
  - `POST /api/feedback` : body `{ feed_entry_id, kind: "up" | "down" }` → feedback に insert。フィード画面の 👍/👎 から呼ぶ（最小のインライン JS で fetch、失敗時は無視でよい）
  - v1 では収集のみ。**feedback テーブルを読む処理を実装しない**（学習は v2 スコープ。先回り実装をしない）

- **テスト**: ランク順・ページング境界・要約 NULL 表示 / 設定のバリデーション（不正 repo 形式・不正 feed URL・空 label の拒否、正常系の KV 書き込み） / `/r/` のクリック記録とリダイレクト・存在しない id の 404 / feedback insert

### タスク 10: デプロイ・Access 設定・運用確認

- **作業内容**（手順書として実行）:
  1. D1 作成: `wrangler d1 create ai-curator` → wrangler.jsonc に id 記入 → migrations apply --remote
  2. KV 作成: `wrangler kv namespace create CONFIG` → id 記入（初期投入は不要。関心軸・ソースはデプロイ後に `/settings` で入力）
  3. `wrangler deploy`
  4. **Cloudflare Access で Worker の URL を保護**: Zero Trust ダッシュボード → Access → Applications → Self-hosted で workers.dev ドメイン（またはカスタムドメイン）を登録し、自分のメールアドレスのみ許可するポリシーを設定。**設定完了までフィードにはダミーデータ以外を入れない**
  5. 動作確認: `wrangler dev --test-scheduled` でローカル cron 発火（`curl "http://localhost:8787/__scheduled?cron=0+*/3+*+*+*"` 等）→ 本番は `wrangler tail` でログを見ながら初回 cron を待つ（または dashboard から手動トリガ）
  6. 翌朝: フィード表示・要約品質・Workers AI ダッシュボードの neurons 消費を確認（全件要約なので記事件数に比例。個人規模なら無料枠 10,000/日に十分収まる想定。実測して桁を把握する）
- **確認チェックリスト**（poc_results の合格基準を流用）:
  - [ ] 各ソース（汎用フィード・GitHub・HN）から記事が入る（articles にレコード）
  - [ ] 同一 URL の再 fetch で重複しない
  - [ ] フィード上位がゴミだらけでない・下位に技術外トピックが沈む
  - [ ] 要約が自然な日本語である
  - [ ] articles・feed_entries のどこにも記事本文が保存されていない（SELECT で確認）
  - [ ] 未認証アクセスが Access でブロックされる（`/` `/settings` `/r/1` すべて）
  - [ ] スマホから設定画面でフィード URL 追加・関心軸ラベル編集ができ、翌日のフィードに反映される
  - [ ] 記事リンクのクリックと 👍/👎 が feedback テーブルに記録される

## 6. 修正対象ファイル一覧

すべて新規作成（`app/` 配下）:

- `app/wrangler.jsonc` `app/package.json` `app/tsconfig.json` `app/vitest.config.ts` — 基盤
- `app/migrations/0001_init.sql` — D1 スキーマ
- `app/src/index.ts` — scheduled 分岐 + fetch(Viewer) の entrypoint
- `app/src/config.ts` — KV 設定ロード・検証
- `app/src/lib/normalize.ts` `retry.ts` `html.ts` `xml.ts` `simhash.ts` `embedding.ts` `score.ts` `semantic_dedup.ts` `summarize.ts` — コアロジック（各 `.test.ts` 併設）
- `app/src/adapters/types.ts` `feed.ts` `github.ts` `hn.ts` — ソースアダプタ（各 `.test.ts` 併設）
- `app/src/pipeline/fetch.ts` `feed.ts` — cron パイプライン
- `app/src/viewer/index.ts` — フィード表示
- `app/src/viewer/settings.ts` — 設定画面（KV 読み書き）
- `app/src/viewer/feedback.ts` — クリック記録リダイレクト + 評価 API
- `app/test/fixtures/*` — 合成 fixture（実データ禁止）
- （`config.json` は使わない。KV へは `/settings` から投入する）

## 7. 検証方法

- 各タスク: `npm test`（vitest-pool-workers）+ `npm run typecheck`（`tsc --noEmit`）。write-code スキルのフロー（テスト先行）で実装する
- 結合: `wrangler dev --test-scheduled` で日次パス（cron 1 本）を発火し、ローカル D1 に articles → feed_entries/feed_trends が積まれること、`GET /` でフィードが返ることを確認
- 本番: タスク 10 のチェックリスト
- コスト: Workers AI ダッシュボードで日次 neurons を確認。全件要約のため記事件数に比例する（無料枠 10,000/日を継続的に超えるようなら記事件数・モデルを見直す）

## 8. 推奨する実行方法

タスクは 10 個で依存が明確なので、`/team-manager` で以下の並列度で進めるのが効率的:

- 第 1 陣（並列可）: タスク 1 → 完了後に 2 / 3 / 4 / 7 を並列
- 第 2 陣: タスク 5（4 に依存。アダプタ 4 本はさらに並列可）
- 第 3 陣: タスク 6 → 8 → 9（直列）
- 最後: タスク 10（人間の操作を含む: Access 設定・`/settings` からの設定投入）

単独で順に進める場合は `/implement-issue` 相当のフローでタスク番号順に。いずれの場合も各タスクで write-code スキル（テスト先行）に従うこと。

## 9. 実装者への注意（再掲・厳守）

1. **`poc/` ディレクトリのコードを開かない・コピーしない**。必要な知見は本書 §2 と各タスクに全部書いてある。書いていないことで困ったら本書の不備なので、推測せず質問すること
2. 記事本文（body）を D1・KV・ログ・fixture に書かない
3. 外部 fetch は必ず fetchWithRetry 経由
4. 判断に迷う箇所は docs/01〜03 に根拠があるか確認し、なければ質問する（勝手に仕様を決めない）
