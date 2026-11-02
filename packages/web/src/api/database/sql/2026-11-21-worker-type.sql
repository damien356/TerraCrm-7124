-- Worker type on staff and installer cards (Damien, 2 Nov).
-- employee or subcontractor. Left empty (unclassified) for everyone, so each
-- person is reviewed by hand. Nothing is set from whether they have an ABN.
-- Nothing is deleted and no history changes.
ALTER TABLE installers ADD COLUMN worker_type text;
