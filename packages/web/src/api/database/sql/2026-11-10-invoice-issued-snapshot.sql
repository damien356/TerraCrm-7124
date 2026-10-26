-- Invoice billing summary (Damien, 26 Oct): what an invoice says, saved at its first email so a re-send never pulls revised scope or figures. Add a column only. Existing rows stay null.
ALTER TABLE invoices ADD COLUMN issued_snapshot text;
