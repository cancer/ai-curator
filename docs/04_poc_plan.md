# AI curator — PoC 実施計画

`docs/03_design.md` の土台が壊れていないことを確認する。関連度判定の精度追求はしない (BS L32, L95)。

根拠の出典表記: `(BS L*)` は `docs/ai_curator_brainstorm.md` の行番号、URL は公式ドキュメントを指す。

## 1. 検証項目と合格基準 (BS L88-95)

| # | 検証項目 | 合格基準 |
|---|---|---|
| ① | GitHub / HN / RSS が安定取得できるか | 4 ソース全てから記事メタが取得でき、連続実行でエラーが頻発しない |
| ② | 本文抽出の両極（Medium=テンプレ / Fowler=個別）が機能するか | 各 5 記事以上で本文テキストが崩れなく取れる |
| ③ | 抽出 → Embedding → 関連度スコアが「読む価値ある順」になるか | 上位 10 件を目視し「ゴミだらけでない」こと (BS L95) |
| ④ | コスト実測 | Workers AI Neurons と LLM digest の実トークンを記録し、月額換算できる |

最大の未検証リスクはソース確保（データをどこから取るか）(BS L96) — ①② が最優先。

## 2. 実施構成

ローカル TypeScript スクリプト + Workers AI REST API で実施する。

- 選定理由: PoC の目的は土台確認のみ (BS L32)。デプロイ・Cron・Queues を省くのが最小構成であり、Neurons 消費は実行元によらず Workers AI ダッシュボードで実測できる（https://dash.cloudflare.com/?to=/:account/ai/workers-ai）
- Workers AI REST API: `POST /accounts/{account_id}/ai/run/{model}`（https://developers.cloudflare.com/workers-ai/get-started/rest-api/）
- 保存先: ローカル SQLite（`docs/03_design.md` §3 のスキーマたたき台を流用。D1 も SQLite 互換のため移行差分が小さい）
- 法務方針は PoC でも遵守する: 本文はスコアリング処理内のみで扱い、DB に保存しない (BS L74-76)

## 3. 事前準備

1. Cloudflare アカウントの Account ID と Workers AI 用 API トークンを用意 —【未了。Step 3-4 の着手前に必要】
2. 監視対象の具体化 —【確定 2026-07-06: ソースは 4 系統で確定（ユーザー回答「その4つでいい」）。具体対象は関心軸から Claude が導出した暫定値で、`poc/config.ts` で差し替え可能】
   - GitHub リポジトリ: `sveltejs/svelte` / `withastro/astro` / `anthropics/claude-code`【暫定】
   - HN: `search_by_date` で points > 50 の story を取得。キーワード事前フィルタはせず、絞り込みは Scorer に委ねる【暫定】
   - Medium: 著者 feed `@kentbeck_7670`（本文全文つき）+ タグ feed `software-architecture`（メタのみ）【暫定】
   - martinfowler.com/feed.atom（固定、BS L63）
3. 関心軸シードの文章化 —【軸は確定 2026-07-06（ユーザー回答）: Web FW / AI / Agentic Coding / Software Designing の 4 軸。各軸のシード文は Claude が起草し `poc/config.ts` で調整可能】(BS L37)
4. Digest 用 LLM —【確定 2026-07-06: Workers AI を使用（ユーザー回答）。追加クレデンシャル不要、Neurons 消費のみ】

## 4. 実施ステップ

各ステップは前のステップの出力を入力とする。詰まったらそのステップで検証結果を記録して判断する（全ステップ完走が目的ではない）。

### Step 1: ソース疎通（検証①）

- 4 ソースの Adapter を実装し、記事メタ（URL/タイトル/日時/要約）を取得
- 数日間 or 複数回実行し、取得件数とエラーを記録

### Step 2: 本文抽出（検証②）

- Medium: テンプレ抽出（BS L59）。**実測 2026-07-06**: 記事ページの直接 fetch は Cloudflare ボットチャレンジ（"Just a moment..."）でブロックされるため、著者 feed の `content:encoded`（本文全文を含むことを確認済み）から抽出する。タグ feed は snippet のみでメタ収集用
- Fowler: 個別抽出（BS L60）。**実測 2026-07-06**: 記事ページは UA 指定の curl で取得可能。本文コンテナは `<main>` 要素
- 各 5 記事以上で抽出結果を目視確認。崩れ方のパターンを記録

### Step 3: Embedding + スコアリング（検証③）

1. 関心軸シードを Embedding し 3 軸のベクトルを作る（第一候補モデル: `@cf/baai/bge-m3`、`docs/03_design.md` §4）
2. Step 1-2 の記事（タイトル + 要約 or 本文冒頭【暫定、BS L31 の「何を Embedding するか」検証を含む】）を Embedding
3. SimHash Dedup → cosine クラスタ化 → スコア式（暫定重み: w1=0.6 / w2=0.3 / w3=0.1【暫定】）で順位付け
4. 上位 10 件 + 下位 10 件を目視評価。ヒット軸の表示が納得感あるかも確認 (BS L47)

過剰に作り込まない。重み調整は 2〜3 回の試行まで (BS L95)。

### Step 4: Digest 生成 + コスト実測（検証④）

1. 上位 10 件で digest を LLM 生成（要約 + 選定理由 + 出典 URL）
2. 記録する実測値:
   - Embedding: 総入力トークン数と Workers AI ダッシュボードの Neurons 消費
   - Digest: LLM の入出力トークン数
3. 「1 日 1 回 × 30 日」の月額を換算し、無料枠（10,000 Neurons/日）内かを判定

## 5. 結果記録テンプレート

`docs/poc_results.md` に以下を記録する。

```markdown
# PoC 結果

## ① ソース疎通
| ソース | 取得件数 | エラー | 備考 |

## ② 本文抽出
| サイト | 試行数 | 成功数 | 崩れ方 |

## ③ スコア順の目視評価
- 使用モデル / Embedding 入力:
- 上位 10 件の内訳（読みたい/どちらでも/ゴミ）:
- ヒット軸表示の納得感:
- 判定: 合格 / 不合格（理由）

## ④ コスト実測
- Embedding: __ tokens → __ Neurons/日
- Digest LLM: 入力 __ / 出力 __ tokens
- 月額換算: __
- 無料枠内か: yes / no

## PoC 後の確定事項への反映 (BS L110-116)
- D1 スキーマ / 冪等キー / 重み・閾値 / Embedding 入力 / モデル選定:
```

## 6. PoC でやらないこと (BS L98-100)

- 提唱者ホワイトリストの本格運用
- リンクグラフ二次発見
- ソース種別ごとのスコア重み分岐
- 関連度精度の作り込み（実運用のフィードバックループで育てる、BS L32）
- Workers へのデプロイ・Cron・Queues・Cloudflare Access（実運用 v1 で着手、`docs/03_design.md` §6）

## 7. 出口判断

- 全項目合格 → `docs/03_design.md` §7 の未確定事項を確定し、実運用 v1 の実装へ
- ①② で不合格のソースがある → ソース差し替え or 抽出戦略の見直し（最大リスクなのでここに時間を使う、BS L96）
- ③ が不合格 → Embedding 入力（タイトルのみ/要約込み/本文冒頭/全文）とモデル（bge-m3 ↔ qwen3-embedding-0.6b。多言語モデル限定 — `docs/03_design.md` §4）の組み替えを試し、それでも改善しなければ設計に戻る
