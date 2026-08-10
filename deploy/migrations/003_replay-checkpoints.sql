-- PREMiSE v2 runtime schema, migration 3.
CREATE TABLE IF NOT EXISTS premise_v2_replay_checkpoints (
  tenant_id TEXT NOT NULL CHECK (length(trim(tenant_id)) > 0),
  consumer_id TEXT NOT NULL CHECK (length(trim(consumer_id)) > 0),
  event_sequence BIGINT NOT NULL CHECK (event_sequence >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, consumer_id)
);

ALTER TABLE premise_v2_replay_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE premise_v2_replay_checkpoints FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS premise_v2_replay_checkpoints_tenant_policy ON premise_v2_replay_checkpoints;
CREATE POLICY premise_v2_replay_checkpoints_tenant_policy ON premise_v2_replay_checkpoints
  USING (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''));

INSERT INTO premise_v2_schema_migrations(version) VALUES (3)
ON CONFLICT (version) DO NOTHING;
