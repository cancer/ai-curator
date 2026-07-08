# デプロイ・運用手順書（ai-curator v1）

単一 Worker `ai-curator` を Cloudflare にデプロイし、本番運用へ乗せるまでの手順書。
上から順に実行すれば動作する。コマンドはすべて `app/` ディレクトリで実行する前提。

構成（`wrangler.jsonc`）:

- Worker 名: `ai-curator`（`src/index.ts`）
- cron 1 本（`triggers.crons`）:
  - `0 21 * * *` — 日次パス（21:00 UTC = 朝 6 時 JST）。取得〜全件要約までを 1 実行で行う（`runDaily`）
- バインディング: `AI`（Workers AI）/ `DB`（D1）/ `CONFIG`（KV）
- `observability.enabled: true`

---

## 1. 前提

- Cloudflare アカウントがあること。
- `wrangler login` 済みであること（`npx wrangler whoami` で確認できる）。
- Node.js / npm が入っていること。
- 依存インストール:

  ```bash
  cd app
  npm install
  ```

---

## 2. リソース作成と設定

### 2-1. D1 データベース作成

```bash
npx wrangler d1 create ai-curator-db
```

出力される `database_id` を、`wrangler.jsonc` の `d1_databases[0].database_id`
（現在 `REPLACE_WITH_D1_DATABASE_ID` プレースホルダ）に記入する。

### 2-2. マイグレーション適用

`migrations/0001_init.sql`（articles / interest_axes / feedback / feed_entries / feed_trends）を適用する。

```bash
# ローカル（wrangler dev 用の擬似 D1）
npx wrangler d1 migrations apply ai-curator-db --local

# 本番（リモート D1）
npx wrangler d1 migrations apply ai-curator-db --remote
```

### 2-3. KV Namespace 作成

```bash
npx wrangler kv namespace create CONFIG
```

出力される `id` を、`wrangler.jsonc` の `kv_namespaces[0].id`
（現在 `REPLACE_WITH_KV_NAMESPACE_ID` プレースホルダ）に記入する。

### 2-4. config.json 作成

**この設定ファイルはコミットしない**（ルート `.gitignore` に `app/config.json` が登録済み）。
`src/config.ts` の `Config` スキーマに厳密に従う（`loadConfig` が起動時に検証し、
欠損・型不一致があれば fail-fast で throw する）。

`app/config.json` を以下のテンプレートを基に作成する。
`digest.model` は §5 で選定した値に差し替えること（テンプレートでは `REPLACE_WITH_DIGEST_MODEL`）。

```json
{
  "interestAxes": [
    {
      "id": "web-fw",
      "label": "Web フレームワーク",
      "seedText": "Modern web frameworks and their runtime and rendering architecture: React, Next.js, Remix, Svelte, SvelteKit, Vue, Nuxt, Astro, Qwik, SolidJS. Server components, streaming SSR, hydration, islands architecture, edge rendering, routing, and build tooling."
    },
    {
      "id": "ai",
      "label": "AI / 機械学習",
      "seedText": "Applied AI and machine learning engineering: large language models, embeddings, retrieval-augmented generation, vector search, fine-tuning, inference optimization, prompt engineering, evaluation, and integrating model APIs into production software."
    },
    {
      "id": "agentic-coding",
      "label": "エージェント型コーディング",
      "seedText": "Agentic coding and AI-assisted software development: autonomous coding agents, LLM tool use and function calling, code generation, AI pair programming, developer copilots, agent orchestration, and workflows where models plan and edit code."
    },
    {
      "id": "software-design",
      "label": "ソフトウェア設計",
      "seedText": "Software design and architecture: clean architecture, domain-driven design, refactoring, design patterns, testing strategy, API design, modularity, coupling and cohesion, maintainability, and engineering practices that reduce cognitive load."
    }
  ],
  "sources": {
    "githubRepos": [
      "facebook/react",
      "vercel/next.js",
      "sveltejs/svelte",
      "withastro/astro"
    ],
    "hnMinPoints": 50,
    "mediumAuthorFeeds": [],
    "mediumTagFeeds": [
      "software-engineering",
      "artificial-intelligence"
    ],
    "fowlerFeed": true
  },
  "scoring": {
    "weights": {
      "interest": 0.6,
      "freshness": 0.3,
      "sourceTrust": 0.1
    },
    "freshnessHalfLifeDays": 3,
    "semanticDedupThreshold": 0.9,
    "sourceTrust": {
      "github": 1.0,
      "fowler": 1.0,
      "medium": 0.7,
      "hn": 0.5
    }
  },
  "embedding": {
    "model": "@cf/baai/bge-m3",
    "maxInputChars": 20000
  },
  "digest": {
    "model": "REPLACE_WITH_DIGEST_MODEL",
    "maxOutputTokens": 300
  }
}
```

補足:

- `interestAxes[].seedText` は英語で書く（embedding モデル `@cf/baai/bge-m3` は多言語対応だが、
  対象記事が英語中心のため関心軸も英語で揃える）。`githubRepos` / `mediumAuthorFeeds` /
  `mediumTagFeeds` の中身は運用者の関心に応じて調整してよい。
- `scoring` の各値はテンプレートが v1 の既定値。

### 2-5. KV 投入（初回のみ）

```bash
npx wrangler kv key put --binding CONFIG "config:v1" --path config.json --remote
```

> **設定変更の正の経路は設定画面（`GET`/`POST /settings`）。**
> 初回投入後の設定変更は設定画面から行う。Worker が `saveConfig`（`src/config.ts`）で
> KV キー `config:v1` に書き戻す。`config.json` を再投入するのはリセットしたい場合のみ。

---

## 3. デプロイ

```bash
npx wrangler deploy
```

（`npm run deploy` でも同じ。）

---

## 4. Cloudflare Access による保護（本番投入前に必須）

Viewer（`/`・`/settings`・`/r/{id}`・`/api/feedback`）は認証を持たない。
**本番でフィードにダミー以外のデータを入れる前に、必ず Access で保護する。**

1. Cloudflare Zero Trust ダッシュボード → **Access → Applications** →
   **Add an application → Self-hosted** を選ぶ。
2. アプリのドメインに、デプロイした Worker の `workers.dev` ドメイン
   （またはカスタムドメイン）を登録する。パスはアプリ全体（ルート）を対象にする。
3. ポリシーで **自分のメールアドレスのみ許可**（Action: Allow, Include: Emails →
   自分のアドレス）を設定する。
4. 保護対象の確認: `/`・`/settings`・`/r/1`・`/api/feedback` の**すべて**が
   Access の内側（同一アプリ配下）にあることを確認する。一部だけ外れると
   フィードバック API 経由などで裏口が開く。

> **Access 設定が完了するまで、フィードにダミー以外のデータを入れない。**

---

## 5. digest LLM モデルの選定（本番前の人手作業）

`config.digest.model` は KV 設定値であり、**コード変更なしに差し替え可能**
（設定画面 or `config.json` 再投入）。以下の手順で初期値を決める。

1. Workers AI のテキスト生成モデル一覧
   （https://developers.cloudflare.com/workers-ai/models/）から、
   **日本語対応が明記されているモデルを 2〜3 候補**選ぶ。
2. 実記事 5 件で日本語要約品質を目視比較し、最良のものを `config.digest.model` の初期値にする。
3. **`@cf/meta/llama-3.2-3b-instruct` は日本語品質が不十分なため選ばない。**

決めた model id を §2-4 の `config.json`（または設定画面）に反映する。

---

## 6. 動作確認

### 6-1. ローカルで cron を手動発火

```bash
npx wrangler dev --test-scheduled
```

別ターミナルで、cron 式をクエリに渡して発火させる:

```bash
# 日次パス（取得〜全件要約までを 1 実行）
curl "http://localhost:8787/__scheduled?cron=0+21+*+*+*"
```

> ローカル D1 を使う場合は §2-2 の `--local` マイグレーションを先に適用しておくこと。

### 6-2. 本番の cron を確認

```bash
npx wrangler tail
```

でログを見ながら初回 cron を待つ（またはダッシュボードから手動トリガ）。
翌朝、以下を確認する:

- フィード（`/`）が生成されていること。
- 要約品質（自然な日本語か）。
- Workers AI ダッシュボードの **neurons 消費**。全件要約のため記事件数に比例する（個人規模なら無料枠 10,000/日に十分収まる想定。実測して桁を把握し、継続的に無料枠を超えるなら記事件数・モデルを見直す）。

---

## 7. 確認チェックリスト（poc_results 合格基準）

- [ ] 4 ソース（GitHub / HN / Medium / Fowler）すべてから記事が入る（`articles` にレコードがある）
- [ ] 同一 URL の再 fetch で重複しない（`articles.url` は UNIQUE。冪等キー）
- [ ] フィード上位がゴミだらけでない・下位に技術外トピックが沈む
- [ ] 要約が自然な日本語である
- [ ] `articles`・`feed_entries` のどこにも**記事本文が保存されていない**（`SELECT` で確認）
- [ ] 未認証アクセスが Access でブロックされる（`/`・`/settings`・`/r/1` すべて）
- [ ] スマホから設定画面でソース追加・関心軸 seedText 編集ができ、翌日フィードに反映される
- [ ] 記事リンクのクリックと 👍/👎 が `feedback` テーブルに記録される

本文非保存の確認例（本番 D1 に対して）:

```bash
# articles に feed_summary/body 列が無いこと（原文非永続）を確認
npx wrangler d1 execute ai-curator-db --remote \
  --command "SELECT id, url, title, source FROM articles LIMIT 20;"
npx wrangler d1 execute ai-curator-db --remote \
  --command "SELECT date, rank, summary FROM feed_entries ORDER BY date DESC, rank LIMIT 20;"
```

`articles` に保存されるのは metadata（`url`/`title`/`source`/`published_at`）・`content_hash`・
`embedding`(+モデル名)・`score`/`hit_axis` のみ。**フィード提供の要約・本文などの原文テキストは列ごと持たない**（取得時にメモリで埋め込み・要約に使い破棄）。
`feed_entries.summary` は自前生成の LLM 要約（**全件**。取得失敗時のみ NULL）。いずれも記事本文の複製ではない。

---

## 8. 既知の制限（v1）

### GitHub リリースの SimHash 衝突

近傍重複判定に使う SimHash の入力は
`` `${article.title} ${article.feedSummary ?? ""}` ``（`src/pipeline/daily.ts`。
`feedSummary` はメモリ上の一時値で、ハッシュ計算に使うが永続化はしない）。

GitHub リリースは `feedSummary` を持たず**タイトルのみ**でハッシュ化されるため、
**異なるリポジトリが完全に同一のリリースタイトル（例 `"v1.0.0"`）を持つ場合、
ハミング距離 0 で相互に重複判定され、後発が取り込まれない**ことがある。

`source` をハッシュ入力に含めれば回避できるが、そうすると
**異ソース間の同一記事の重複検出**（例: HN と Medium で同じ記事）が壊れる。
このトレードオフのため、v1 では現状の式を維持する。実害が出たら v2 で見直す。

### その他

- 傾向サマリ（`feed_trends`）は時系列比較なし。当日分のみ。
- 要約はフィード全件に生成する（本文取得失敗時のみ NULL）。上位 N 件限定は廃止。
- HN のリンク先本文は粗いタグ除去で取得するため、要約入力にヘッダ等のノイズが混じりうる（SPA/ペイウォール等では取得失敗しタイトルにフォールバック）。
- フィードバック（`feedback` テーブル）は**収集のみ**。スコアリングへの学習利用は v2。
