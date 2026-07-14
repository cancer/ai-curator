# AI curator

パーソナル技術情報キュレーションの本番 v1。単一の Cloudflare Worker（`app/`）が
日次 cron（`0 21 * * *` = 朝 6 時 JST）で全ソースを取得し、正規化・重複排除・
Embedding・スコアリングを経て、フィード全記事を LLM（digest モデル）で日本語要約する。

- 要件 / 仕様 / 設計: [`docs/01_requirements.md`](docs/01_requirements.md) / [`docs/02_specification.md`](docs/02_specification.md) / [`docs/03_design.md`](docs/03_design.md)
- 実装計画: [`docs/05_v1_work_plan.md`](docs/05_v1_work_plan.md)
- デプロイ・運用手順: [`app/DEPLOY.md`](app/DEPLOY.md)

## 開発

```bash
cd app
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
```

## 運用: digest 生成ログの調査（`digest_metrics`）

digest モデルは推論モデル（Gemma 4）で、生成量が run ごとに大きくぶれる。推論だけで
`max_tokens` に達し可視回答が空になる「暴走」が非決定的に起きるため、要約 1 試行ごとの
メトリクスを D1 テーブル `digest_metrics` に記録している（リトライ各回・失敗も 1 行ずつ）。
`max_tokens`（`app/src/config.ts` の `SYSTEM_CONFIG.digest.maxOutputTokens`）の適値は、
このログを実運用で溜めてから判断する。

### テーブル

| 列 | 意味 |
|---|---|
| `label` | `'article'`（記事要約） / `'trend'`（傾向叙述） |
| `model` | 生成モデル名 |
| `attempt` | 0 起点の試行番号（>0 はリトライが起きた） |
| `ms` | その試行の所要ミリ秒 |
| `finish_reason` | `'stop'`=完走 / `'length'`=上限で打ち切り。例外時は `NULL` |
| `completion_tokens` | 推論＋回答の合計トークン（取得できた場合） |
| `max_tokens` | その時の上限設定 |
| `content_len` | 可視回答の文字数（0 = 空） |
| `empty` | `1`=可視回答が空（推論のみで終了 or 取得失敗） |
| `error` | 例外時のメッセージ（先頭 200 字） |
| `created_at` | 記録時刻 |

本文・生成テキストそのものは保存しない（一時データのため）。

### クエリ（本番 D1。`app/` で実行）

finish_reason 別の分布（完走率・トークン量・レイテンシ）:

```bash
npx wrangler d1 execute ai-curator-db --remote --command \
"SELECT label, finish_reason, empty, count(*) n, \
        round(avg(completion_tokens)) avg_tok, max(completion_tokens) max_tok, \
        round(avg(ms)) avg_ms \
 FROM digest_metrics GROUP BY label, finish_reason, empty ORDER BY n DESC;"
```

暴走（空回答）率:

```bash
npx wrangler d1 execute ai-curator-db --remote --command \
"SELECT count(*) attempts, sum(empty) empty_attempts, \
        round(100.0*sum(empty)/count(*), 1) empty_pct \
 FROM digest_metrics WHERE label='article';"
```

完走した要約が実際に使ったトークン量（= `max_tokens` の下限の根拠）:

```bash
npx wrangler d1 execute ai-curator-db --remote --command \
"SELECT round(avg(completion_tokens)) avg_tok, max(completion_tokens) max_tok \
 FROM digest_metrics WHERE label='article' AND finish_reason='stop' AND empty=0;"
```

リトライ深さの分布（`attempt`>0 が多いほど 1 記事に時間・コストがかかっている）:

```bash
npx wrangler d1 execute ai-curator-db --remote --command \
"SELECT attempt, count(*) n FROM digest_metrics GROUP BY attempt ORDER BY attempt;"
```

### 読み方 → `max_tokens` の調整

- `finish_reason='stop'` かつ `empty=0` の `max_tok` … 正常に完走する要約が要するトークンの上端。
  `max_tokens` はこれ＋安全余裕あれば足りる（下げ余地の判断材料）。
- `empty=1` / `finish_reason='length'` の割合 … 暴走頻度。高いほど 1 記事あたりリトライで
  時間・コストがかさむ。`max_tokens` を上げても暴走は防げず、失敗 1 回が高く・遅くなるだけなので、
  上限は「完走に必要な量＋余裕」に留め、暴走はリトライで吸収する設計。
- `attempt` 分布・`ms` … 実レイテンシ。日次パスは Workflow（非同期）なので長時間でも許容だが、
  記事件数 × 平均試行数で総処理時間が決まる。

### ライブ観測

```bash
cd app && npx wrangler tail
```

digest_metrics への書き込み失敗は生成本体を止めず、`wrangler tail` に warn として流れる
（`digest metric persist failed: ...`）。要約自体の失敗（本文取得失敗のフォールバック等）も
同様に warn で確認できる。
