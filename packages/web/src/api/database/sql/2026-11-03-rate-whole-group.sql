-- A rate item for every skill in its group (notes 18.62). One new column,
-- default 0, so every existing item behaves exactly as before.
ALTER TABLE labour_rate_items ADD COLUMN whole_group integer DEFAULT 0 NOT NULL;
