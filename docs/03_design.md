# AI curator — 設計ドキュメント

`docs/02_specification.md` の仕様を Cloudflare スタック上のコンポーネントに割り当てる。

根拠の出典表記: `(BS L*)` は `docs/ai_curator_brainstorm.md` の行番号、URL は公式ドキュメントを指す。
ブレスト結論で「技術構成の具体化は PoC 後」(BS L116) と確定しているため、本書はアーキテクチャレベルの決定事項と、`【たたき台】` と明記した仮案を区別して記す。たたき台は PoC の結果で見直す。

## 1. 全体構成

既存スタック（Cloudflare Workers + Cron Triggers + Queues + D1 + Workers AI）を流用する (BS L19)。

```
┌─ 日次パス（Cron 1本・1日1回）───────────────────┐
│  Daily Worker                                   │
│    Source Adapter (GitHub/HN/Medium/Fowler)     │
│      当日分を全件取得（ページング）              │
│    → Normalize → SimHash Dedup → D1 (articles メタ) │
│    → Workers AI Embedding（title+フィード提供テキスト）│
│    → 意味的 Dedup → Score（全件をスコア順に保持）│
│    → 全件本文取得 → 全件 LLM 要約 + 傾向サマリ   │
│    → D1 (feed)。原文テキストは破棄、派生物のみ保存 │
└─────────────────────────────────────────────────┘
┌─ 閲覧 ─────────────────────────────────────────┐
│  Viewer（Cloudflare Access で保護、fetch ハンドラ）│
│    ランク付きフィード表示・もっと見る → D1      │
└─────────────────────────────────────────────────┘
```

- **単一 Worker・Cron 1本（1日1回）に統合**（2026-07-09 改定。従来の Cron 2 系統分離 (BS L106) は廃止）。取得〜要約を 1 パスで行い、原文テキストを保存しないため中間状態を持たずメモリで使い回す
- Queues は使わない（直列 fetch）。将来のソース分散は v2 で判断（後述 §6）

## 2. コンポーネント設計

### 2.1 Source Adapter

ソースごとに `fetch() → RawItem[]` を実装する共通インターフェース。仕様 §2 の 4 ソースが初期実装 (BS L55-60)。

- 本文抽出は 2 戦略を分ける (BS L62):
  - `TemplateExtractor`: PF 向け（Medium）。実測 2026-07-06 により、記事ページ HTML ではなく著者 feed の `content:encoded` から抽出する（記事ページはボットチャレンジでブロック）
  - `CustomExtractor`: サイト個別実装（martinfowler.com）。記事ページの `<main>` 要素から抽出（実測 2026-07-06）
- GitHub Releases・HN はフィード/API が構造化済みのため抽出不要

### 2.2 Normalizer

RawItem を仕様 §3 の共通スキーマに変換する。URL 正規化（トラッキングパラメータ除去）と `content_hash` 算出を含む。

### 2.3 Dedup

- 機械的 Dedup: SimHash を Fetch Worker 内で計算し、既存レコードとの近接ハッシュを保存前に棄却 (BS L23)
- 意味的 Dedup: Feed Builder Worker 内で Embedding 後に cosine 閾値クラスタリング (BS L25)。件数は 1 日分に絞られているため全ペア比較で足りる【たたき台】

### 2.4 Scorer

仕様 §6 のスコア式を実装。関心軸ベクトルは D1 に保存し、`max(cosine)` とヒット軸を記録する (BS L42-47)。

### 2.5 Feed Builder（日次パスの後半）

1 日 1 回、同一パス内でフィード（仕様 §8）を組む:

1. **当日傾向サマリ**（§8.1）: Scorer が出したヒット軸分布・意味的 Dedup のクラスタを軸ごとに集計し、LLM で軸別に叙述する。集計は既存のスコアリング成果物を再利用するため追加の Embedding は不要
2. **ランク付き記事リスト**（§8.2）: 当日母集団をスコア降順で全件保持。hard cut しない
3. **全件要約**: フィードに載る全記事の本文を取得（Medium=content:encoded / GitHub=release note / Fowler=記事ページ `<main>` / HN=リンク先を粗抽出）して LLM 要約を生成し、feed_entries.summary に保存する。取得失敗はスニペット→タイトルにフォールバックし、1 件の失敗で全体を止めない。本文は要約後に破棄する

LLM は Workers AI を使用（確定 2026-07-06）。PoC 実測（`docs/poc_results.md` ④）で llama-3.2-3b の日本語品質が不十分と判明したため、実運用前に日本語品質の高い生成モデルへ再選定する。**LLM 要約は全件生成に確定**（2026-07-09。コストが制約でないため体験優先）。

### 2.6 Viewer

ランク付きフィードを表示する非公開ページ（fetch ハンドラ）。Cloudflare Access で認証 (BS L78)。スコア順に並べ「もっと見る」で下位をページング読み込みする。要約は日次パスで全件生成済み（feed_entries.summary）なので、Viewer は保存済み要約を表示するだけ（本文再 fetch はしない）。配信フォーマット細部は未確定 (BS L115)。

## 3. データ設計【たたき台】

D1 スキーマの確定は PoC 後 (BS L112)。以下は PoC でそのまま使える最小案。

```sql
-- 収集記事（メタのみ。本文カラムは持たない — 法務方針 BS L74-76）
CREATE TABLE articles (
  id            INTEGER PRIMARY KEY,
  url           TEXT NOT NULL UNIQUE,   -- 冪等キー【暫定: 正規化URL、BS L113】
  title         TEXT NOT NULL,
  source        TEXT NOT NULL,
  published_at  TEXT NOT NULL,
  -- feed_summary は持たない（原文由来のため非永続。2026-07-09 改定）
  content_hash  TEXT,                   -- SimHash（title+フィード提供テキスト）
  embedding     TEXT,                   -- JSON 配列【暫定。実運用で Vectorize 移行、BS L112】
  embedding_model TEXT,                 -- ベクトル生成モデル名（異モデル間は比較不能のため必須併記 — §4）
  score         REAL,
  hit_axis      TEXT,                   -- ヒットした関心軸
  created_at    TEXT DEFAULT (datetime('now'))
);

-- 関心軸（複数ベクトル方式 — BS L42）
CREATE TABLE interest_axes (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,             -- 例: Web FW / AI / Agentic Coding / Software Designing
  embedding  TEXT NOT NULL,             -- JSON 配列
  embedding_model TEXT NOT NULL,        -- ベクトル生成モデル名（記事側と一致する空間でのみ比較可 — §4）
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 日次フィード（ランク付き）。当日母集団を全件スコア順に保持する
CREATE TABLE feed_entries (
  id          INTEGER PRIMARY KEY,
  date        TEXT NOT NULL,            -- フィード生成日
  article_id  INTEGER NOT NULL REFERENCES articles(id),
  rank        INTEGER NOT NULL,         -- スコア降順の順位（もっと見る式ページングの並び）
  summary     TEXT,                     -- 自前生成の要約（保存可 BS L75）。全件生成（2026-07-09 確定）。取得失敗時のみ NULL
  UNIQUE(date, article_id)
);

-- 当日傾向サマリ（軸ごと。自前生成物のみ）
CREATE TABLE feed_trends (
  id         INTEGER PRIMARY KEY,
  date       TEXT NOT NULL,
  axis       TEXT NOT NULL,             -- 関心軸（ジャンル）
  hit_count  INTEGER NOT NULL,          -- その軸のヒット件数
  narrative  TEXT,                      -- LLM による軸別の叙述（保存可 BS L75）
  UNIQUE(date, axis)
);
```

- ベクトル検索は当面 D1 から全件ロードして Worker 内で cosine 計算【たたき台】。1 日分×少数ソースなら件数は小さく、ANN 基盤（Vectorize）への移行は実運用の規模を見て判断 (BS L112)

## 4. Embedding モデル選定【たたき台】

候補は**多言語モデルに限定**する（確定 2026-07-06 ユーザー判断）。異なるモデルのベクトルは cosine 比較不能なため、英語特化モデルを選ぶと日本語ソース導入時に「言語別の空間分裂」か「全件再 Embedding」を強制される。本文非保存のため再 Embedding は再 fetch 頼みで、消えた記事は復元不可 (BS L83) — この一方向性がモデル選定を重い決定にしている。

| 候補 | 特性 | 単価 |
|---|---|---|
| `@cf/baai/bge-m3`（第一候補） | 多言語・context window 60,000 トークン | $0.012/M input tokens |
| `@cf/qwen/qwen3-embedding-0.6b`（代替） | 多言語（提供元説明。要検証③確認）・context window 8,192 トークン・1,024 次元 | $0.012/M input tokens |

（各モデルページ: https://developers.cloudflare.com/workers-ai/models/）

PoC の検証項目③（スコア順の目視評価）で両者を A/B 比較して確定する。

言語別のモデル分割（例: 日本語のみ `@cf/pfnet/plamo-embedding-1b`）は**デフォルト不採用**（2026-07-06 判断）。空間分裂により言語横断の意味的 Dedup (BS L25) とプロファイル一元管理が失われるため。実運用で日本語記事の順位品質に明確な問題が出た場合に限り、日本語専用の第二空間として再検討する。この将来分岐に備え、ベクトルには生成モデル名（`embedding_model`）を必ず併記する。

## 5. コスト設計

- 段階絞り込み: SimHash（無料・保存前）→ Embedding（安価・全件）→ LLM 要約（1 日 1 回・全件）(BS L17-18)。要約を全件に広げてもコストは無料枠の 1% 未満（実測）で制約にならない
- Workers AI は無料枠 10,000 Neurons/日。`bge-m3` は 1,075 neurons/M input tokens のため、Embedding は無料枠内に収まる見込み
  （https://developers.cloudflare.com/workers-ai/platform/pricing/）
- 実測は PoC の検証項目④ (BS L92)

## 6. 段階導入方針

| フェーズ | 構成 |
|---|---|
| PoC | ローカルスクリプト + Workers AI API。Workers/Queues/Cron は使わない（`docs/04_poc_plan.md`） |
| 実運用 v1 | Workers + Cron 1 本（日次単一パス）+ D1。Queues なしの直列 fetch（2026-07-09 改定：2 系統分離を廃止） |
| 実運用 v2 | Queues によるソース分散、Vectorize 移行、フィードバック還流・明示ルール (BS L38-39, L112) |

### 6.1 設定データの扱い（確定 2026-07-07 ユーザー方針）

- 設定は 2 層に分ける。**KV に置くのは可変データ（関心軸のシード文・監視対象＝リポジトリ/著者/タグ）のみ**（UserConfig）。system パラメータ（scoring / embedding / digest）は v1 ではコード内固定（`SYSTEM_CONFIG`）で、UI 非公開・変更はコード編集
- KV へは設定画面（`/settings`）から投入・編集する。コードやファイル（`config.json` 等）には手書きしない。初回は既定値が入った状態でフォームが開き、保存で KV キー `config:v1` に `interestAxes` / `sources` のみ書き込む
- 可変データを KV に分離する理由は運用面（秘匿ではない）: 関心プロファイルは実運用で頻繁に更新される（フィードバック還流 BS L38）ため、コード変更を伴わず差し替えられるべき可変データである。一方 system パラメータは v1 では頻繁に変わらないため、コード定数に固定して誤操作を防ぐ
- PoC では簡便のため `poc/config.ts` に直書き（現状）。実運用 v1 で可変データを KV へ移す

## 7. 未確定事項の一覧（PoC 後に確定）(BS L110-116)

| 項目 | 本書での扱い |
|---|---|
| D1 スキーマ | §3 のたたき台を PoC で使用し、結果で見直す |
| 冪等キー | 暫定: 正規化 URL の unique 制約 |
| スコア重み・閾値 | 暫定値のみ。実運用のフィードバックで調整 (BS L32) |
| フィルターバブル対策の混合比率 | 未着手 |
| 配信フォーマット細部 | 未着手 |
| LLM モデル選定 | 基盤は Workers AI に確定（2026-07-06）。モデルは PoC のコスト実測で判断 |
