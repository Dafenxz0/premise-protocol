-- PREMiSE v2 runtime schema, migration 1.
CREATE TABLE IF NOT EXISTS premise_v2_schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS premise_v2_records (
  tenant_id TEXT NOT NULL CHECK (length(trim(tenant_id)) > 0),
  memory_id TEXT NOT NULL CHECK (length(trim(memory_id)) > 0),
  envelope_json JSONB NOT NULL CHECK (jsonb_typeof(envelope_json) = 'object'),
  content_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, memory_id)
);

CREATE TABLE IF NOT EXISTS premise_v2_events (
  sequence BIGSERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL CHECK (length(trim(tenant_id)) > 0),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
  event_id TEXT NOT NULL CHECK (length(trim(event_id)) > 0),
  event_json JSONB NOT NULL CHECK (jsonb_typeof(event_json) = 'object'),
  occurred_at TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, event_id)
);

CREATE INDEX IF NOT EXISTS premise_v2_events_tenant_sequence_idx
  ON premise_v2_events(tenant_id, sequence);
CREATE INDEX IF NOT EXISTS premise_v2_events_memory_idx
  ON premise_v2_events(tenant_id, ((event_json->>'memoryId')), sequence);

CREATE TABLE IF NOT EXISTS premise_v2_snapshots (
  tenant_id TEXT NOT NULL CHECK (length(trim(tenant_id)) > 0),
  snapshot_id TEXT NOT NULL CHECK (length(trim(snapshot_id)) > 0),
  captured_at TIMESTAMPTZ NOT NULL,
  snapshot_json JSONB NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, snapshot_id)
);

INSERT INTO premise_v2_schema_migrations(version) VALUES (1)
ON CONFLICT (version) DO NOTHING;
