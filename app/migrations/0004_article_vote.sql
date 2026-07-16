-- 記事ごとの投票状態（👍/👎）。「記事ごとに現在値が 1 つ」という不変条件を
-- article_id の PRIMARY KEY で表す（追記ログではなく現在値を持つ）。再投票は上書き、
-- 同じ投票の再押下はトグル解除＝行削除で表現する。
-- click（読了イベントログ）は別概念のため feedback 側に据え置く。
CREATE TABLE article_vote (
  article_id  INTEGER PRIMARY KEY REFERENCES articles(id),
  vote        TEXT NOT NULL CHECK (vote IN ('up', 'down')),
  created_at  TEXT DEFAULT (datetime('now'))
);
