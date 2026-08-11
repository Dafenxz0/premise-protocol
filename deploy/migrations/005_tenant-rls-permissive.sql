-- PREMiSE v2 runtime schema, migration 5.
-- Repair the v2 RLS policies without changing the checksums of migrations that
-- may already be recorded by the deployment migrator. PostgreSQL combines
-- permissive policies with OR; a restrictive-only policy denies every row.

DROP POLICY IF EXISTS premise_v2_records_tenant_policy ON premise_v2_records;
CREATE POLICY premise_v2_records_tenant_policy ON premise_v2_records
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''));

DROP POLICY IF EXISTS premise_v2_events_tenant_policy ON premise_v2_events;
CREATE POLICY premise_v2_events_tenant_policy ON premise_v2_events
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''));

DROP POLICY IF EXISTS premise_v2_snapshots_tenant_policy ON premise_v2_snapshots;
CREATE POLICY premise_v2_snapshots_tenant_policy ON premise_v2_snapshots
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''));

DROP POLICY IF EXISTS premise_v2_replay_checkpoints_tenant_policy ON premise_v2_replay_checkpoints;
CREATE POLICY premise_v2_replay_checkpoints_tenant_policy ON premise_v2_replay_checkpoints
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''));

DROP POLICY IF EXISTS premise_v2_http_idempotency_tenant_policy ON premise_v2_http_idempotency;
CREATE POLICY premise_v2_http_idempotency_tenant_policy ON premise_v2_http_idempotency
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''));

INSERT INTO premise_v2_schema_migrations(version) VALUES (5)
ON CONFLICT (version) DO NOTHING;
