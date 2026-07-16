-- 関心軸にカテゴリ(グループ)を持たせる。NULL 許容（既定 NULL = 未分類）。
-- カテゴリは軸の属性でしかなく独立した実体を持たないため、専用テーブル/FK は作らず
-- interest_axes の源泉列（/settings が書く）として 1 列足すだけにする。
ALTER TABLE interest_axes ADD COLUMN category TEXT;
