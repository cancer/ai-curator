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

> **KV への初期投入コマンドは不要。** 関心軸・ソース（`interestAxes` / `sources`）は
> デプロイ後にブラウザで `/settings` を開いて入力・保存する（§5-2）。scoring / embedding /
> digest はコード内固定（`src/config.ts` の `SYSTEM_CONFIG`）なので KV には入れない。

---

## 3. デプロイ

> デプロイ前に §5-1 で `SYSTEM_CONFIG.digest.model`（`src/config.ts`）が
> 選定済みの値になっているか確認する。

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

## 5. 初期設定

### 5-1. digest LLM モデルの選定（デプロイ前のコード編集）

`digest.model` は KV ではなく **コード内固定**（`src/config.ts` の `SYSTEM_CONFIG.digest.model`）。
UI からは変更しない。デプロイ前に以下の手順で選定値へ差し替える（コード編集）。

1. Workers AI のテキスト生成モデル一覧
   （https://developers.cloudflare.com/workers-ai/models/）から、
   **日本語対応が明記されているモデルを 2〜3 候補**選ぶ。
2. 実記事 5 件で日本語要約品質を目視比較し、最良のものを `SYSTEM_CONFIG.digest.model` の値にする。
3. **`@cf/meta/llama-3.2-3b-instruct` は日本語品質が不十分なため選ばない。**

> `src/config.ts` の現状値は日本語対応候補の一例（暫定既定）で、**運用前に選定・要検証**。
> 未検証のまま本番投入しない。

### 5-2. 関心軸・ソースの投入（`/settings` で入力）

関心軸（`interestAxes`）とソース（`sources`）は KV に置き、**設定画面から入力・保存する**。
Access 保護（§4）が済んだら、ブラウザで `/settings` を開く。

1. 初回は KV が空でも、既定値（`DEFAULT_USER_CONFIG`）が入った状態でフォームが開く。
2. 関心軸（label / seedText・追加/削除）とソース（GitHub リポジトリ / Medium 著者・タグ /
   Hacker News 最低ポイント）を編集し、**保存**する。Worker が `saveConfig`（`src/config.ts`）で
   KV キー `config:v1` に `interestAxes` / `sources` のみを書き込む。
3. 以後の設定変更も同じく `/settings` から行う（設定変更の正の経路）。

> `seedText` を変更すると、次回日次パスで関心軸ベクトルが自動再生成される。
> scoring / embedding / digest は `/settings` では表示のみ（変更はコード編集）。

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
