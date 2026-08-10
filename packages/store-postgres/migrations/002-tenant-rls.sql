-- PREMiSE v2 runtime schema, migration 2.
-- The application sets premise.tenant_id with set_config(..., true) per transaction.
ALTER TABLE premise_v2_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE premise_v2_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS premise_v2_records_tenant_policy ON premise_v2_records;
CREATE POLICY premise_v2_records_tenant_policy ON premise_v2_records
  USING (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''));

ALTER TABLE premise_v2_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE premise_v2_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS premise_v2_events_tenant_policy ON premise_v2_events;
CREATE POLICY premise_v2_events_tenant_policy ON premise_v2_events
  USING (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''));

ALTER TABLE premise_v2_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE premise_v2_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS premise_v2_snapshots_tenant_policy ON premise_v2_snapshots;
CREATE POLICY premise_v2_snapshots_tenant_policy ON premise_v2_snapshots
  USING (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''));
