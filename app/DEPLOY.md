# デプロイ・運用手順書（ai-curator v1）

単一 Worker `ai-curator` を Cloudflare にデプロイし、本番運用へ乗せるまでの手順書。
上から順に実行すれば動作する。コマンドはすべて `app/` ディレクトリで実行する前提。

構成（`wrangler.jsonc`）:

- Worker 名: `ai-curator`（`src/index.ts`）
- cron 1 本（`triggers.crons`）:
  - `0 21 * * *` — 日次パス（21:00 UTC = 朝 6 時 JST）。取得〜全件要約までを 1 実行で行う（`runDaily`）
- バインディング: `AI`（Workers AI）/ `DB`（D1）。設定（関心軸・フィード）は D1 に置く（KV は使わない）
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

`migrations/` 一式を適用する（`0001_init.sql` の articles / interest_axes / feedback /
feed_entries / feed_trends に加え、`0005_promote_interest_axes_and_feeds.sql` で
interest_axes を設定の源泉テーブルへ昇格し、フィードを保持する feed_source を作る）。

```bash
# ローカル（wrangler dev 用の擬似 D1）
npx wrangler d1 migrations apply ai-curator-db --local

# 本番（リモート D1）
npx wrangler d1 migrations apply ai-curator-db --remote
```

> **設定は D1 に置く（KV は使わない）。** 関心軸・ソース（`interestAxes` / `sources`）は
> デプロイ後にブラウザで `/settings` を開いて入力・保存する（§5-2）。保存先は D1 の
> `interest_axes`（源泉列 `axis_id`/`label`）と `feed_source`（`url`）。scoring / embedding /
> digest はコード内固定（`src/config.ts` の `SYSTEM_CONFIG`）で、D1 にも KV にも入れない。
>
> 既存本番が旧構成（設定を KV `config:v1` に持つ）から移行する場合は、通常のデプロイの前に
> §9「KV→D1 config 移行」を実施すること。

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

関心軸（`interestAxes`）とソース（`sources`）は D1 に置き、**設定画面から入力・保存する**。
Access 保護（§4）が済んだら、ブラウザで `/settings` を開く。

1. 初回は D1 に軸が 1 件も無くても、空のひな形（`EMPTY_USER_CONFIG`）でフォームが開く。
2. 関心軸（トピックの **label のみ**・追加/削除）とソース（**フィード URL リスト**）を編集し、
   **保存**する。Worker が `saveConfig`（`src/config.ts`）で D1 の `interest_axes`
   （源泉列 `axis_id`/`label`）と `feed_source`（`url`）へ原子的に書き込む（`env.DB.batch`）。
   関心記述文の手書きは不要（ベクトルは label から自動生成）。
3. 以後の設定変更も同じく `/settings` から行う（設定変更の正の経路）。

> 関心軸は **label（トピック名）だけ**入力する。関心記述文とベクトルは次回の日次パスが
> label から LLM で生成→埋め込みして作る。label を変えると次回パスで再生成される。
> Medium・martinfowler.com 等は「フィード URL」に追加する（専用欄は無い）。
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
- [ ] スマホから設定画面でフィード URL 追加・関心軸ラベル編集ができ、翌日フィードに反映される
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

---

## 9. KV→D1 config 移行（既存本番の 1 回限りの移行手順）

設定の保存先を KV（`config:v1` の JSON blob）から D1 の正規化テーブル
（`interest_axes` の源泉列 `axis_id`/`label` と `feed_source`）へ移す。**新規デプロイには
不要**（§2 の手順で D1 に直接投入する）。既に KV で稼働している本番だけがこの節を実施する。

本番 KV の現行値は本番からしか取れないため、**以下の `--remote` / `kv` 操作はすべて
デプロイ担当（本リポジトリのオーナー）が実行する**（本手順書の作業者は実行しない）。
本番の KV namespace-id は旧 `wrangler.jsonc` の値 `04a1885ee0e1421d8ccce689acace6c9`
（`CONFIG` バインディング）。

### デプロイ順序（各段で可逆＝ロールバック可能）

移行中は「旧コードは KV を読んで稼働したまま」を保ち、新コードへ切り替えるまで本番機能を
止めない。各段の直後にロールバックする場合は、その段の変更を戻す（または旧バージョンを
再デプロイする）だけでよい。KV の値は移行完了を確認するまで**削除しない**（最終的な退避先）。

1. **migration 0005 を適用する。**
   ```bash
   npx wrangler d1 migrations apply ai-curator-db --remote
   ```
   これは列追加・新テーブル作成のみで既存データを壊さない。旧コード（KV 読取）は影響を
   受けず稼働継続する。ロールバック不要（前方互換）。

2. **KV の `config:v1` を読み、D1 へ投入する。**まず現行値を取得する。
   ```bash
   npx wrangler kv key get "config:v1" \
     --namespace-id 04a1885ee0e1421d8ccce689acace6c9 --remote
   ```
   取得した JSON の `interestAxes[].{id,label}` と `sources.feeds[]` を D1 へ移す SQL を
   用意し、`--file` で投入する（例。実際の id/label/url は取得値で置き換える）。
   ```sql
   -- interest_axes: label を源泉として reconcile する。embedding などの派生列は
   -- 温存する（ON CONFLICT DO UPDATE SET label のみ）。既存行があれば label を更新し、
   -- 無ければ源泉行を作る（派生列は NULL のまま → 次 cron が埋める）。
   INSERT INTO interest_axes (axis_id, label) VALUES ('ai', 'AI')
     ON CONFLICT(axis_id) DO UPDATE SET label = excluded.label;
   -- feed_source: KV の feeds をそのまま 1 本 1 行で入れる。
   INSERT INTO feed_source (url) VALUES ('https://martinfowler.com/feed.atom')
     ON CONFLICT(url) DO NOTHING;
   ```
   ```bash
   npx wrangler d1 execute ai-curator-db --remote --file=./migrate_config.sql
   ```
   この段でも本番はまだ旧コード（KV 読取）で稼働している。投入をやり直す場合は D1 の
   `interest_axes`/`feed_source` を消して再投入すればよい（KV は無傷）。

3. **新コードをデプロイする。**本 PR は D1 読み書きへの切替と `CONFIG`（KV）バインディング
   除去を同時に含むため、このデプロイで設定の読取先が D1 に切り替わる。
   ```bash
   npx wrangler deploy
   ```
   > デプロイ前に §2 で D1（`interest_axes`/`feed_source`）へ設定が投入済みであることを
   > 確認する。未投入だと新コードは軸 0 件で `loadConfig` が throw する（fail-fast）。
   > 問題があれば旧バージョン（KV 読取・`CONFIG` バインディング付き）を再デプロイして
   > ロールバックする。KV の値は残しているので旧コードはそのまま復旧する。

4. **実エンドポイントで疎通確認する。**
   - `GET /settings` — 移行した関心軸・フィードがフォームに表示される。
   - `GET /` — フィードが表示される（当日フィードがあれば）。
   - `POST /run` — 日次パスを起動し、`/runs/{id}` の status で完走を確認する。

5. **KV を破棄する（任意・確認後）。**§4 の疎通と翌日フィードまで確認できたら、不要になった
   KV namespace を削除してよい。急がず、しばらく退避先として残してもよい。
   ```bash
   npx wrangler kv namespace delete --namespace-id 04a1885ee0e1421d8ccce689acace6c9
   ```
