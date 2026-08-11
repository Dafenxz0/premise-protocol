-- PREMiSE v2 runtime schema, migration 2.
-- The application connection must use the dedicated NOSUPERUSER,
-- NOBYPASSRLS role provisioned by the deployment. The API repeats that check
-- at startup; migration DDL may run under the bootstrap/owner role.

ALTER TABLE premise_v2_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE premise_v2_records FORCE ROW LEVEL SECURITY;
REVOKE ALL ON premise_v2_records FROM PUBLIC;
DROP POLICY IF EXISTS premise_v2_records_tenant_policy ON premise_v2_records;
CREATE POLICY premise_v2_records_tenant_policy ON premise_v2_records
  AS RESTRICTIVE
  USING (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''));

ALTER TABLE premise_v2_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE premise_v2_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON premise_v2_events FROM PUBLIC;
DROP POLICY IF EXISTS premise_v2_events_tenant_policy ON premise_v2_events;
CREATE POLICY premise_v2_events_tenant_policy ON premise_v2_events
  AS RESTRICTIVE
  USING (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''));

ALTER TABLE premise_v2_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE premise_v2_snapshots FORCE ROW LEVEL SECURITY;
REVOKE ALL ON premise_v2_snapshots FROM PUBLIC;
DROP POLICY IF EXISTS premise_v2_snapshots_tenant_policy ON premise_v2_snapshots;
CREATE POLICY premise_v2_snapshots_tenant_policy ON premise_v2_snapshots
  AS RESTRICTIVE
  USING (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''));

INSERT INTO premise_v2_schema_migrations(version) VALUES (2)
ON CONFLICT (version) DO NOTHING;
