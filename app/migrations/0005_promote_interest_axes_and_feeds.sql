-- interest_axes を「派生キャッシュ」から「源泉(source of truth)」へ昇格する。
-- 源泉列 = axis_id/label（/settings が書く）。派生列 = seed_hash/embedding/embedding_model
--（cron が後で埋める）。源泉行を先に作れるよう派生列を NULL 許容にする。
CREATE TABLE interest_axes_new (
  id              INTEGER PRIMARY KEY,
  axis_id         TEXT NOT NULL UNIQUE,
  label           TEXT NOT NULL,
  seed_hash       TEXT,
  embedding       TEXT,
  embedding_model TEXT,
  updated_at      TEXT DEFAULT (datetime('now'))
);
INSERT INTO interest_axes_new (id, axis_id, label, seed_hash, embedding, embedding_model, updated_at)
  SELECT id, axis_id, label, seed_hash, embedding, embedding_model, updated_at FROM interest_axes;
DROP TABLE interest_axes;
ALTER TABLE interest_axes_new RENAME TO interest_axes;

-- フィード(ソース)を 1 本 1 行で正規化する。
CREATE TABLE feed_source (
  id         INTEGER PRIMARY KEY,
  url        TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT (datetime('now'))
);
