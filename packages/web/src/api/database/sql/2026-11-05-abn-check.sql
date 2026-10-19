-- Notes 18.64: ABN Lookup check on installer cards. Add columns only.
ALTER TABLE installers ADD COLUMN abn_legal_name text;
ALTER TABLE installers ADD COLUMN abn_business_names text;
ALTER TABLE installers ADD COLUMN abn_status text;
ALTER TABLE installers ADD COLUMN abn_status_from text;
ALTER TABLE installers ADD COLUMN abn_entity_type text;
ALTER TABLE installers ADD COLUMN abn_gst_from text;
ALTER TABLE installers ADD COLUMN abn_gst_to text;
ALTER TABLE installers ADD COLUMN abn_state text;
ALTER TABLE installers ADD COLUMN abn_postcode text;
ALTER TABLE installers ADD COLUMN abn_checked_at integer;
ALTER TABLE installers ADD COLUMN abn_check_error text;
ALTER TABLE installer_invoices ADD COLUMN legal_name text;
