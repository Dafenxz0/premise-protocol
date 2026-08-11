-- PREMiSE v2 runtime schema, migration 7.
-- A digest is persisted instead of the raw signature. The primary key and
-- RLS policy make the claim atomic and tenant-scoped across API replicas.
CREATE TABLE IF NOT EXISTS premise_v2_signature_replays (
  tenant_id TEXT NOT NULL CHECK (length(trim(tenant_id)) > 0),
  replay_digest TEXT NOT NULL CHECK (replay_digest ~ '^[0-9a-f]{64}$'),
  signature_id TEXT NOT NULL CHECK (length(trim(signature_id)) > 0),
  key_id TEXT NOT NULL CHECK (length(trim(key_id)) > 0),
  signed_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL CHECK (expires_at > accepted_at),
  PRIMARY KEY (tenant_id, replay_digest)
);

CREATE INDEX IF NOT EXISTS premise_v2_signature_replays_expiry_idx
  ON premise_v2_signature_replays(tenant_id, expires_at);

ALTER TABLE premise_v2_signature_replays ENABLE ROW LEVEL SECURITY;
ALTER TABLE premise_v2_signature_replays FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS premise_v2_signature_replays_tenant_policy ON premise_v2_signature_replays;
CREATE POLICY premise_v2_signature_replays_tenant_policy ON premise_v2_signature_replays
  AS PERMISSIVE
  USING (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''));

INSERT INTO premise_v2_schema_migrations(version) VALUES (7)
ON CONFLICT (version) DO NOTHING;
