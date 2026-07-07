# AI curator — 設計ドキュメント

`docs/02_specification.md` の仕様を Cloudflare スタック上のコンポーネントに割り当てる。

根拠の出典表記: `(BS L*)` は `docs/ai_curator_brainstorm.md` の行番号、URL は公式ドキュメントを指す。
ブレスト結論で「技術構成の具体化は PoC 後」(BS L116) と確定しているため、本書はアーキテクチャレベルの決定事項と、`【たたき台】` と明記した仮案を区別して記す。たたき台は PoC の結果で見直す。

## 1. 全体構成

既存スタック（Cloudflare Workers + Cron Triggers + Queues + D1 + Workers AI）を流用する (BS L19)。

```
┌─ Cron A（高頻度）──────────────────────────────┐
│  Fetch Worker                                   │
│    Source Adapter (GitHub/HN/Medium/Fowler)     │
│    → Normalize → SimHash Dedup → D1 (articles)  │
└─────────────────────────────────────────────────┘
┌─ Cron B（1日1回）──────────────────────────────┐
│  Feed Builder Worker                            │
│    D1 未処理記事 → Workers AI Embedding         │
│    → 意味的 Dedup → Score（全件をスコア順に保持）│
│    → 傾向サマリ + LLM 要約 → D1 (feed)          │
└─────────────────────────────────────────────────┘
┌─ 閲覧 ─────────────────────────────────────────┐
│  Viewer（Cloudflare Access で保護）             │
│    ランク付きフィード表示・もっと見る → D1      │
└─────────────────────────────────────────────────┘
```

- Cron 2 系統分離は確定事項 (BS L106)
- Queues は Fetch のソース間分散・リトライに使う【たたき台】。PoC では不要（後述 §6）

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

### 2.5 Feed Builder

1 日 1 回 (BS L106) フィード（仕様 §8）を組む:

1. **当日傾向サマリ**（§8.1）: Scorer が出したヒット軸分布・意味的 Dedup のクラスタを軸ごとに集計し、LLM で軸別に叙述する。集計は既存のスコアリング成果物を再利用するため追加の Embedding は不要
2. **ランク付き記事リスト**（§8.2）: 当日母集団をスコア降順で全件保持。hard cut しない

LLM は Workers AI を使用（確定 2026-07-06）。PoC 実測（`docs/poc_results.md` ④）で llama-3.2-3b の日本語品質が不十分と判明したため、実運用前に日本語品質の高い生成モデルへ再選定する。LLM 要約の生成範囲（上位先行 / 全件 / 開いた時のみ）は未確定（FR-7 の論点）。「開いた時のみ」を採る場合、本文非保存 (NFR-2) のため Viewer から本文再 fetch する経路が要る。

### 2.6 Viewer

ランク付きフィードを表示する非公開ページ。Cloudflare Access で認証 (BS L78)。スコア順に並べ「もっと見る」で下位をページング読み込みする。LLM 要約を「開いた時のみ生成」する場合は、記事を開いた時点で本文を再 fetch → 要約する処理を持つ（本文は保存しない）。配信フォーマット細部は未確定 (BS L115)。

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
  feed_summary  TEXT,
  content_hash  TEXT,                   -- SimHash
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
  summary     TEXT,                     -- 自前生成の要約（保存可 BS L75）。生成範囲は FR-7 論点、未生成は NULL
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

- 段階絞り込みが原則: SimHash（無料）→ Embedding（安価）→ LLM（1 日 1 回・少数のみ）(BS L17-18)
- Workers AI は無料枠 10,000 Neurons/日。`bge-m3` は 1,075 neurons/M input tokens のため、Embedding は無料枠内に収まる見込み
  （https://developers.cloudflare.com/workers-ai/platform/pricing/）
- 実測は PoC の検証項目④ (BS L92)

## 6. 段階導入方針

| フェーズ | 構成 |
|---|---|
| PoC | ローカルスクリプト + Workers AI API。Workers/Queues/Cron は使わない（`docs/04_poc_plan.md`） |
| 実運用 v1 | Workers + Cron 2 系統 + D1。Queues なしの直列 fetch から開始【たたき台】 |
| 実運用 v2 | Queues によるソース分散、Vectorize 移行、フィードバック還流・明示ルール (BS L38-39, L112) |

### 6.1 設定データの扱い（確定 2026-07-07 ユーザー方針）

- 関心軸のシード文・監視対象（リポジトリ/著者/タグ）は**個人データであり、リポジトリにコミットしない**。実運用では KV 等の外部ストアに置き、コードから分離する
- 理由: これらはユーザー個人の関心そのもので、リポジトリ可視性（特に公開時）の露出リスクになる。また関心プロファイルは実運用で頻繁に更新される（フィードバック還流 BS L38）ため、コード変更を伴わず差し替えられるべき
- PoC では簡便のため `poc/config.ts` に直書き（現状）。実運用 v1 で KV へ移す

## 7. 未確定事項の一覧（PoC 後に確定）(BS L110-116)

| 項目 | 本書での扱い |
|---|---|
| D1 スキーマ | §3 のたたき台を PoC で使用し、結果で見直す |
| 冪等キー | 暫定: 正規化 URL の unique 制約 |
| スコア重み・閾値 | 暫定値のみ。実運用のフィードバックで調整 (BS L32) |
| フィルターバブル対策の混合比率 | 未着手 |
| 配信フォーマット細部 | 未着手 |
| LLM モデル選定 | 基盤は Workers AI に確定（2026-07-06）。モデルは PoC のコスト実測で判断 |
