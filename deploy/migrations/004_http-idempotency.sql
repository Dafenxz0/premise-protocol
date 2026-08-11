-- PREMiSE v2 runtime schema, migration 4.
-- HTTP idempotency claims are scoped by tenant, operation and key. A short
-- lease makes an abandoned claim recoverable after a process or host failure.
CREATE TABLE IF NOT EXISTS premise_v2_http_idempotency (
  tenant_id TEXT NOT NULL CHECK (length(trim(tenant_id)) > 0),
  operation TEXT NOT NULL CHECK (length(trim(operation)) > 0),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
  request_hash TEXT NOT NULL CHECK (length(trim(request_hash)) > 0),
  state TEXT NOT NULL CHECK (state IN ('IN_PROGRESS', 'COMPLETED')),
  lease_token TEXT NOT NULL CHECK (length(trim(lease_token)) > 0),
  status_code INTEGER,
  response_json JSONB,
  response_headers JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(response_headers) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, operation, idempotency_key),
  CHECK ((state = 'IN_PROGRESS' AND status_code IS NULL AND response_json IS NULL) OR
         (state = 'COMPLETED' AND status_code BETWEEN 100 AND 599 AND response_json IS NOT NULL))
);

ALTER TABLE premise_v2_http_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE premise_v2_http_idempotency FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS premise_v2_http_idempotency_tenant_policy ON premise_v2_http_idempotency;
CREATE POLICY premise_v2_http_idempotency_tenant_policy ON premise_v2_http_idempotency
  USING (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''))
  WITH CHECK (tenant_id = NULLIF(current_setting('premise.tenant_id', true), ''));

INSERT INTO premise_v2_schema_migrations(version) VALUES (4)
ON CONFLICT (version) DO NOTHING;
