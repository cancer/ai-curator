# PoC 結果

実施日: 2026-07-06（Step 1-2）/ 2026-07-07（Step 3-4）
PoC 完了。検証①〜④すべて実施・合格。

実施環境: ローカル TypeScript（bun）+ 実データ live fetch。スクリプトは `poc/scripts/step1_sources.ts` / `poc/scripts/step2_extract.ts`、設定値は `poc/config.ts`。

## ① ソース疎通

3 回連続実行し、全 7 fetch（GitHub 3 リポジトリ / HN / Medium 著者・タグ / Fowler）が毎回成功。エラー 0。

| ソース | 取得件数 | エラー | 備考 |
|---|---|---|---|
| github:sveltejs/svelte | 10 | なし | REST `releases?per_page=10`。draft/prerelease 除外後の件数 |
| github:withastro/astro | 10 | なし | 同上 |
| github:anthropics/claude-code | 10 | なし | 同上 |
| hn | 30 | なし | Algolia `search_by_date` tags=story, points>50, hitsPerPage=30 |
| medium:@kentbeck_7670 | 10 | なし | 著者 feed。全 10 件が content:encoded に本文全文を持つ |
| medium:tag/software-architecture | 9 | なし | タグ feed。snippet（description）のみ。メタ収集用 |
| fowler | 30 | なし | Atom feed。UA 指定不要で取得可 |

- 取得メタ（body 除外）を `poc/out/step1_articles.json` に保存（計 109 件）。保存フィールドは url / title / source / publishedAt のみで、body は含まない（NFR-2 準拠。GitHub の release note も body 扱いで保存しない）。
- HN はキーワード事前フィルタなし。ノイズ（例: サポート論・企業 PR）を含むが、絞り込みは Scorer に委ねる方針どおり（docs/04_poc_plan.md §3-2）。
- **判定: 合格**（合格基準「4 ソース全てから記事メタが取得でき、連続実行でエラーが頻発しない」を満たす。3 回連続で全ソース成功・エラー 0）。

## ② 本文抽出

両極の抽出方式を実データで検証。閾値の 5 記事以上を両方式で満たす。

| サイト | 試行数 | 成功数 | 崩れ方 |
|---|---|---|---|
| Medium（テンプレ抽出: content:encoded） | 10 | 10 | 本文本体は崩れなし。画像キャプションの短語が地の文に混入する箇所あり（例: 見出し直下）。可読性への影響は軽微 |
| Fowler（個別抽出: `<main>`） | 6 | 6 | 本文本体は崩れなし。ボイラープレート除去後はヘッダ文言が消え本文本体のみになる（下記）。本文長は 8k〜52k 字とページにより大きく変動 |

- Medium: 各記事 1.7k〜10k 字で本文全文を取得。冒頭 200 字を目視し、文が自然につながり HTML タグ残渣もない。
- Fowler: feed 先頭 6 件（記事ページ）を 1 秒間隔で fetch し、全件 `<main>` から本文抽出成功。UA `ai-curator-poc` で取得可（Cloudflare ボットチャレンジには当たらない）。
- **本文抽出を cheerio から HTMLRewriter へ移行**（実運用の Cloudflare Workers と同一 API。cheerio 依存を除去）。あわせて Fowler のボイラープレート除去を実装:
  - 除外セレクタ: `h1`（タイトル。NormalizedArticle.title に別途保持）/ `.date` / `.author-list` / `.author` / `.tags` / `.contents`（目次）
  - 論文テンプレート（fixtures/fowler_article.html、テストで固定）: `<main>` 素朴抽出 52,984 字 → 除去後 51,765 字（△1,219 字。タイトル・著者略歴・目次・日付を除去）
  - Fragments テンプレート（live 検証）: `<h1>` タイトルと `<div class='author'>Martin Fowler: DD Mon YYYY</div>` の日付行を除去。冒頭が本文本体から始まることを確認
- HTMLRewriter の癖への対処（bun 1.1.22 で実測）: (1) `remove()` しても他ハンドラの text は除去済み要素でも発火 → skipDepth カウンタで収集をスキップ (2) ブロック要素間に空白が入らない（"Titlebody" 問題）→ ブロック開始で区切り空白を挿入 (3) text ノードのエンティティは未デコード（"&amp;" が残る）→ 収集後にデコード（数値参照＋代表的な名前付き）
- **判定: 合格**（合格基準「各 5 記事以上で本文テキストが崩れなく取れる」を満たす。Medium 10/10・Fowler 6/6。ボイラープレート除去で本文本体のみを抽出できることを論文テンプレートはテストで、Fragments テンプレートは live で確認）。

## ③ スコア順の目視評価

Step 3 実行済み（2026-07-07、記事 100 件 = 機械的 Dedup 後）。ランキングは `poc/out/step3_ranking.md`。
アクセス経路は wrangler dev の AI バインディング経由ローカルプロキシ（`poc/ai-proxy/`）。

### 客観データ（実測）

- **多言語チェック**: 同一関心軸（Software Designing）の英語シード vs 日本語シードの cosine — bge-m3: **0.8505** / qwen3: **0.8019**。両モデルとも日英を近い位置に埋め込めており、多言語運用が可能
- **組み合わせ間の上位 10 件の重なり**（既定 = bge-m3 × title-summary 比）:
  - bge-m3 内の入力違い（title-bodyhead / fulltext）: **8/10** — 入力バリエーションの影響は小さい
  - qwen3（title-summary / title-bodyhead）: **3/10 / 4/10** — モデル間の差が支配的。**入力の選び方よりモデルの選定が効く**
- 意味的 Dedup（cosine ≥ 0.9）: 組み合わせにより 100 → 90〜97 件（3〜10 件をクラスタ統合）
- 定性的な傾向（記録者所見）: 既定組み合わせの上位 10 はアーキテクチャ解説・Agentic ツール・Fowler 記事等で軸との対応が明瞭。下位 10 は Kent Beck の人生論・講演術など技術外トピックに収束しており、関連度の分離は機能している

### 目視判定（ユーザー、2026-07-07）

- 使用モデル / Embedding 入力: 既定（bge-m3 × title-summary）を目視
- 所感: 「内容的にはちゃんと分類されてそう」。上位はタイトルとヒット軸の対応が妥当、下位は技術外トピック（人生論・講演術等）に沈んでおり分離が機能している。※ユーザーは英語を読めないため、タイトル + ヒット軸の対応関係ベースでの評価
- **判定: 合格**（合格基準「上位がゴミだらけでない」を満たす。関連度の分離が上位/下位で明瞭）
- 運用メモ: ユーザーは日本語話者のため、digest の LLM 要約は日本語出力が望ましい（英語記事でも日本語要約で読める）。多言語 cosine 0.85（§③）により、英語で書いた関心軸シードのまま日本語ソースを追加拡張できる

## ④ コスト実測

Embedding 分は実測済み（2026-07-07、プロキシ応答 meta の実測値）。LLM 分は Step 4 実行待ち。

### Embedding（実測）

- **A/B 実験全体**（5 組み合わせ × 100 記事 + シード + 多言語チェック）: **225.9 neurons**（無料枠 10,000/日の 2.3%）
- **1 日 1 回運用相当の 1 パス**（bge-m3 × title-summary、100 記事 + 4 軸シード）: 26,086 tokens → **28.0 neurons/日**
- 全文入力（fulltext）でも 110,372 tokens → 118.6 neurons と、入力を 4 倍にしてもコストは誤差レベル
- 月額換算（Embedding のみ、1 パス/日 × 30 日）: 約 840 neurons/月 = **無料枠内（1 日あたり 0.3%）**。$0.011/1k neurons 換算で約 1.4 円/月

### Digest LLM（実測、2026-07-07）

- 使用モデル: `@cf/meta/llama-3.2-3b-instruct`（config.ts digestModel）
- 10 件生成: input 2,202 / output 1,270 tokens → **48.9 neurons**（要約生成失敗 0 件）
- **本文再取得の内訳**（(a) 方式の実測。「失敗率」より重要な発見）:
  - 再取得成功: **1/10**（Fowler のみ。本文全文で要約）
  - フィード要約フォールバック: **9/10**（HN 4 件 = 設計上本文を持たない / Medium タグ feed 5 件 = snippet のみで本文なし）
  - 明示的な失敗（例外）: 0 件
- 月額換算（Embedding 28 + LLM 49 = **77 neurons/日** × 30）: 約 2,310 neurons/月。$0.011/1k 換算で約 3.8 円/月。**無料枠内（1 日あたり 0.8%）**

### 検証④の重要な発見

1. **(a) 方式（上位のみ本文再取得 → LLM 要約）は、上位が「本文を持たないソース」に偏ると機能しない**。今回の上位 10 は Medium タグ feed 5 + HN 4 + Fowler 1 で、本文全文で要約できたのは 1 件のみ。残り 9 件は snippet/story_text からの要約になり、digest の質はフィード要約の質に律速される。本文全文を持つソース（Medium 著者 feed / GitHub）が上位に入らなかったのは、title-summary 入力ではスコアに本文有無が効かないため。実運用では「上位のうち本文を持つものだけ再取得」の割り切りか、本文取得可能性をスコアに加味するかの判断が要る
2. **llama-3.2-3b-instruct の日本語生成品質が不十分**。生成要約に言語混在・誤変換が散見（「可靠性」=中国語、「アグエント」、「Some は」「Quietly 侵食」等の未翻訳残り）。意味は概ね通るが配信品質としては弱い。実運用では日本語品質の高い生成モデルへの差し替え、または要約対象言語の統一を検討する。コストは十分安い（月 3.8 円）ため、上位モデルへの引き上げ余地は大きい
3. コスト面は Embedding・LLM とも無料枠に対し誤差レベル。**コストは実運用の制約にならない**ことが実測で確定

## PoC 後の確定事項への反映 (BS L110-116)

- **モデル選定（Embedding）**: ③で「モデル間差 ≫ 入力バリエーション差」が判明（上位 10 の重なり: bge-m3 内の入力違い 8/10 に対し、qwen3 は 3〜4/10）。bge-m3 を第一候補として確定してよい。多言語 cosine も bge-m3 0.85 > qwen3 0.80 で bge-m3 優位
- **Embedding 入力**: ③で入力バリエーション（要約/本文冒頭/全文）の影響が小さいと判明。コストも誤差のため、title-summary（最軽量）で始めてよい。Fowler の肥大化への文字数上限は fulltext を使う場合のみ問題で、title-summary なら不要
- **重み・閾値**: 暫定重み（0.6/0.3/0.1）・意味的 Dedup 閾値 0.9 で上位/下位の分離は機能した（③合格）。実運用のフィードバックで調整（BS L32）
- **D1 スキーマ / 冪等キー**: 正規化 URL で重複なく識別できた（①②③通じて衝突なし）。§4 で追加した embedding_model カラムは必須（モデル選定を変えると再 Embedding が要るため）
- **digest モデル（LLM）**: ④で llama-3.2-3b の日本語品質が不十分と判明。コストは無料枠に対し誤差のため、日本語品質の高い生成モデルへ引き上げる余地大。実運用前に再選定する
- **digest の本文取得方式**: ④で (a) 方式は「上位が本文を持たないソースに偏ると機能しない」と判明。本文取得可能性の扱い（スコア加味 or 割り切り）を実運用設計で決める

## 実装メモ（想定外の対処）

- fast-xml-parser の既定 DoS ガード `maxTotalExpansions=1000` が、全文 HTML を含むフィード（Fowler atom の content = 予約済みエンティティ 3071 個）で parse を失敗させた。予約済み・数値エンティティは再帰展開しないため、フラットな展開回数上限のみを引き上げて対処（`poc/src/xml.ts`。再帰による billion-laughs は `maxExpansionDepth` を厳しいまま残して防止）。Medium 著者 feed も同じフィード種別で live では本文 5 記事以上を含み 1000 を超えうるため同一設定を適用。
- `htmlToText`（`poc/src/html.ts`）の `root` / `exclude` に渡すセレクタは終了タグを持つ要素にのみ有効。収集範囲を onEndTag でカウンタ管理するため、void 要素（img / br / hr 等）に一致させるとカウンタが戻らず以降のテキストが黙って欠落する（bun 1.1.22 で実測）。現行の除外セレクタは全て非 void のため問題ないが、将来 `img` / `figure` 等を除外対象に加える場合は void 要素対応が必要。実運用の Workers 移行時は Workers 実装でも同一挙動か再検証する。
