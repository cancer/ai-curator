CREATE TABLE articles (
  id            INTEGER PRIMARY KEY,
  url           TEXT NOT NULL UNIQUE,   -- 冪等キー = 正規化済み URL
  title         TEXT NOT NULL,
  source        TEXT NOT NULL,          -- 例: github:owner/repo, hn, medium:@author, medium:tag/x, fowler
  published_at  TEXT NOT NULL,          -- ISO 8601
  -- feed_summary 列は持たない（原文由来のため非永続。2026-07-09 改定）
  content_hash  TEXT,                   -- SimHash（16進文字列。title+フィード提供テキストから算出）
  embedding     TEXT,                   -- JSON 数値配列。日次パスが書く
  embedding_model TEXT,                 -- ベクトル生成モデル名。embedding とセットで必須
  score         REAL,
  hit_axis      TEXT,                   -- max cosine を与えた関心軸 id
  created_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_articles_created ON articles(created_at);

CREATE TABLE interest_axes (
  id         INTEGER PRIMARY KEY,
  axis_id    TEXT NOT NULL UNIQUE,      -- 例: web-fw, ai, agentic-coding, software-design
  label      TEXT NOT NULL,
  seed_hash  TEXT NOT NULL,             -- seedText の SHA-256。設定変更の検知用
  embedding  TEXT NOT NULL,             -- JSON 数値配列
  embedding_model TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- フィードバック（v1 は収集のみ。学習での利用は v2）
CREATE TABLE feedback (
  id          INTEGER PRIMARY KEY,
  article_id  INTEGER NOT NULL REFERENCES articles(id),
  kind        TEXT NOT NULL CHECK (kind IN ('click', 'up', 'down')),
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_feedback_article ON feedback(article_id);

CREATE TABLE feed_entries (
  id          INTEGER PRIMARY KEY,
  date        TEXT NOT NULL,            -- YYYY-MM-DD（フィード生成日）
  article_id  INTEGER NOT NULL REFERENCES articles(id),
  rank        INTEGER NOT NULL,         -- スコア降順 1 始まり
  summary     TEXT,                     -- LLM 要約（全件生成。本文取得失敗時のみ NULL）
  UNIQUE(date, article_id)
);
CREATE INDEX idx_feed_date_rank ON feed_entries(date, rank);

CREATE TABLE feed_trends (
  id         INTEGER PRIMARY KEY,
  date       TEXT NOT NULL,
  axis_id    TEXT NOT NULL,
  hit_count  INTEGER NOT NULL,
  narrative  TEXT,                      -- LLM による軸別の傾向叙述
  UNIQUE(date, axis_id)
);
