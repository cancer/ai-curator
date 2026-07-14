-- 要約を独立テーブルへ切り出す。1 記事 1 行。「要約がある」= 行が存在する（nullable 列を作らない）
CREATE TABLE summaries (
  id          INTEGER PRIMARY KEY,
  article_id  INTEGER NOT NULL UNIQUE REFERENCES articles(id),
  text        TEXT NOT NULL,
  model       TEXT NOT NULL,            -- 生成モデル名。移行分は来歴不明のため 'unknown'
  created_at  TEXT DEFAULT (datetime('now'))
);

-- 既存 feed_entries.summary を移行。同一 article_id が複数日に載る場合は最新 date の要約を採用
INSERT INTO summaries (article_id, text, model)
SELECT fe.article_id, fe.summary, 'unknown'
FROM feed_entries fe
WHERE fe.summary IS NOT NULL
  AND fe.date = (
    SELECT MAX(fe2.date) FROM feed_entries fe2
    WHERE fe2.article_id = fe.article_id AND fe2.summary IS NOT NULL
  );

ALTER TABLE feed_entries DROP COLUMN summary;
