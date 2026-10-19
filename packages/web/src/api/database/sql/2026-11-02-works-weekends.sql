-- Weekends off by default (notes 18.61). Sat (6) and Sun (0) count as days off
-- unless they are listed here. One new column, nothing existing is changed.
ALTER TABLE installers ADD COLUMN works_weekend_days text NOT NULL DEFAULT '[]';
