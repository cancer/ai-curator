-- 掲載記事が hit_axis に実質該当するかの LLM ゲート判定結果。
-- NULL = 未判定（fail-open= 掲載扱い） / 1 = 該当 / 0 = 非該当。
-- feed_entries ではなく articles に置く理由: feed_entries は当日分を delete→insert で
-- 消えるが、この判定は記事そのものに紐づき、日をまたいでも永続されるべきため。
ALTER TABLE articles ADD COLUMN axis_relevant INTEGER;
