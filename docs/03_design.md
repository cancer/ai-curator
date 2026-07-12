# AI curator — 設計ドキュメント

`docs/02_specification.md` の仕様を Cloudflare スタック上のコンポーネントに割り当てる。

根拠の出典表記: `(BS L*)` は `docs/ai_curator_brainstorm.md` の行番号、URL は公式ドキュメントを指す。
ブレスト結論で「技術構成の具体化は PoC 後」(BS L116) と確定しているため、本書はアーキテクチャレベルの決定事項と、`【たたき台】` と明記した仮案を区別して記す。たたき台は PoC の結果で見直す。

## 1. 全体構成

既存スタック（Cloudflare Workers + Cron Triggers + Queues + D1 + Workers AI）を流用する (BS L19)。

```
┌─ 日次パス（Cron 1本・1日1回）───────────────────┐
│  Daily Worker                                   │
│    Source Adapter (汎用フィード / GitHub / HN)   │
│      当日分を全件取得（ページング）              │
│    → Normalize → SimHash Dedup → D1 (articles メタ) │
│    → 関心軸同期（ラベル→LLM 記述文→Embedding）  │
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

ソースごとに `fetch() → RawItem[]` を実装する共通インターフェース。仕様 §2 のとおり、汎用フィードを主軸に構造化 API を専用ソースとして併用する（2026-07-09 改定）。

- `FeedAdapter`（汎用・主軸）: 任意の RSS/Atom フィード URL を共通の XML パーサで取得する。本文は item/entry の `content:encoded` → `content` → `description` の優先順で取り、いずれも無ければリンク先を取得して粗いタグ除去（root/exclude なしの HTML→テキスト）で本文化する。取得失敗時はスニペット→タイトルにフォールバック。Medium・martinfowler.com もフィード URL の一例として本アダプタで扱う（専用実装は持たない）
  - 改訂前はソース個別の抽出（Medium=著者 feed の `content:encoded` / Fowler=記事ページ `<main>`）を `TemplateExtractor`・`CustomExtractor` に分けていた (BS L62) が、要件 FR-2 のとおりノイズは Embedding 時に埋もれるため、汎用フィードには粗いタグ除去で足りる。個別抽出は廃止した
- `GitHubAdapter`・`HNAdapter`（構造化・専用）: フィードでは代替できない値（GitHub の draft/prerelease・タグ・release note、HN の points 等）を使うため専用のまま維持。API が構造化済みのため本文抽出は不要（HN のみリンク先を粗抽出）

### 2.2 Normalizer

RawItem を仕様 §3 の共通スキーマに変換する。URL 正規化（トラッキングパラメータ除去）と `content_hash` 算出を含む。

### 2.3 Dedup

- 機械的 Dedup: SimHash を Fetch Worker 内で計算し、既存レコードとの近接ハッシュを保存前に棄却 (BS L23)
- 意味的 Dedup: Feed Builder Worker 内で Embedding 後に cosine 閾値クラスタリング (BS L25)。件数は 1 日分に絞られているため全ペア比較で足りる【たたき台】

### 2.4 Scorer

仕様 §6 のスコア式を実装。関心軸ベクトルは D1 に保存し、`max(cosine)` とヒット軸を記録する (BS L42-47)。関心軸ベクトルは日次パス前半の軸同期でユーザーのラベルから生成する（ラベル → LLM で関心記述文を生成 → Embedding。§4）。ユーザーはラベルしか与えない（2026-07-09 改定）。

### 2.5 Feed Builder（日次パスの後半）

1 日 1 回、同一パス内でフィード（仕様 §8）を組む:

1. **当日傾向サマリ**（§8.1）: Scorer が出したヒット軸分布・意味的 Dedup のクラスタを軸ごとに集計し、LLM で軸別に叙述する。集計は既存のスコアリング成果物を再利用するため追加の Embedding は不要
2. **ランク付き記事リスト**（§8.2）: 当日母集団をスコア降順で全件保持。hard cut しない
3. **全件要約**: フィードに載る全記事の本文を取得（汎用フィード=`content:encoded`/`content`/`description`、無ければリンク先を粗抽出 / GitHub=release note / HN=リンク先を粗抽出）して LLM 要約を生成し、summaries テーブル（1 記事 1 行）に保存する。取得失敗はスニペット→タイトルにフォールバックし、1 件の失敗で全体を止めない。本文は要約後に破棄する

LLM は Workers AI を使用（確定 2026-07-06）。PoC 実測（`docs/poc_results.md` ④）で llama-3.2-3b の日本語品質が不十分と判明したため、実運用前に日本語品質の高い生成モデルへ再選定する。**LLM 要約は全件生成に確定**（2026-07-09。コストが制約でないため体験優先）。

### 2.6 Viewer

ランク付きフィードを表示する非公開ページ（fetch ハンドラ）。Cloudflare Access で認証 (BS L78)。スコア順に並べ「もっと見る」で下位をページング読み込みする。要約は日次パスで全件生成済み（summaries テーブル）なので、Viewer は保存済み要約を表示するだけ（本文再 fetch はしない）。配信フォーマット細部は未確定 (BS L115)。

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
  name       TEXT NOT NULL,             -- ユーザー入力のトピックラベル（日本語可。例: Web フレームワーク）
  embedding  TEXT NOT NULL,             -- JSON 配列（ラベル→LLM 記述文→Embedding で生成 — §4）
  embedding_model TEXT NOT NULL,        -- ベクトル生成モデル名（記事側と一致する空間でのみ比較可 — §4）
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 日次フィード（ランク付き）。当日母集団を全件スコア順に保持する
CREATE TABLE feed_entries (
  id          INTEGER PRIMARY KEY,
  date        TEXT NOT NULL,            -- フィード生成日
  article_id  INTEGER NOT NULL REFERENCES articles(id),
  rank        INTEGER NOT NULL,         -- スコア降順の順位（もっと見る式ページングの並び）
  UNIQUE(date, article_id)
);

-- 自前生成の要約（保存可 BS L75）。1 記事 1 行で、「要約がある」= 行が存在する（0002 で feed_entries から分離）
CREATE TABLE summaries (
  id          INTEGER PRIMARY KEY,
  article_id  INTEGER NOT NULL UNIQUE REFERENCES articles(id),
  text        TEXT NOT NULL,
  model       TEXT NOT NULL,            -- 生成モデル名
  created_at  TEXT DEFAULT (datetime('now'))
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

**関心軸ベクトルの生成と再生成**（2026-07-09 改定）: 関心軸ベクトルはユーザーのラベルから生成する（ラベル → LLM で関心記述文を生成 → 記事と同一の Embedding モデルでベクトル化）。記事ベクトルと違い、軸ベクトルは KV に保存したラベルからいつでも再生成でき、再 fetch を伴わない（軸の再 Embedding は軽い）。日次パスの軸同期は、(a) 未登録 (b) ラベルのハッシュ不一致（設定画面での変更検知） (c) `embedding_model` 不一致（モデル入替）のいずれかで軸を再生成する。**留意**: ラベルのハッシュは記述文生成に使う LLM（モデル/プロンプト）の変更までは検知しない — 記述文生成の仕様を変えたときは軸の明示的な再生成（ラベル変更または軸テーブルのクリア）が要る。

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

- 設定は 2 層に分ける。**KV に置くのは可変データ（関心軸のラベル・監視対象＝フィード URL/リポジトリ/HN 閾値）のみ**（UserConfig）。system パラメータ（scoring / embedding / digest）は v1 ではコード内固定（`SYSTEM_CONFIG`）で、UI 非公開・変更はコード編集
- KV `config:v1` の UserConfig の形（2026-07-09 改定。関心軸は `{ id, label }` のみ・シード文は撤廃、ソースは汎用フィード URL リスト＋構造化 API の設定）:

```jsonc
{
  "interestAxes": [ { "id": "web-fw", "label": "Web フレームワーク" } ],
  "sources": {
    "feeds": ["https://martinfowler.com/feed.atom", "https://medium.com/feed/@author"],
    "githubRepos": ["owner/repo"],
    "hnMinPoints": 50
  }
}
```
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
