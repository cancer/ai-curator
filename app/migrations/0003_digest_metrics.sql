-- digest 生成（記事要約・傾向叙述）の観測メトリクス。1 試行 1 行で、リトライ各回・
-- 失敗も記録する。推論モデル（Gemma）は生成量が run 間で大きくぶれるため、実運用ログ
-- から max_tokens の適値と暴走（推論だけで打ち切られ可視回答が空になる）頻度を判断する。
-- 本文・生成テキストそのものは保存しない（一時データのため）。
CREATE TABLE digest_metrics (
  id                INTEGER PRIMARY KEY,
  created_at        TEXT DEFAULT (datetime('now')),
  label             TEXT NOT NULL,          -- 'article' / 'trend'
  model             TEXT NOT NULL,          -- 生成モデル名
  attempt           INTEGER NOT NULL,       -- 0 起点の試行番号（リトライで増える）
  ms                INTEGER NOT NULL,       -- その試行の所要ミリ秒
  finish_reason     TEXT,                   -- 'stop' / 'length' など。エラー時は NULL
  completion_tokens INTEGER,                -- 推論＋回答の合計トークン（取得できた場合）
  max_tokens        INTEGER NOT NULL,       -- その時の上限設定
  content_len       INTEGER NOT NULL,       -- 可視回答の文字数（0 = 空）
  empty             INTEGER NOT NULL,       -- 0/1: 可視回答が空だったか
  error             TEXT                    -- 例外時のメッセージ（先頭 200 字）
);

CREATE INDEX idx_digest_metrics_created ON digest_metrics(created_at);
