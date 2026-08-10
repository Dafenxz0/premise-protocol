-- PREMiSE v2 runtime schema, migration 6.
-- Keep lexical retrieval bounded to PostgreSQL top-k; the expression matches
-- PostgresRuntimeStore.search() and is maintained automatically on writes.
CREATE INDEX IF NOT EXISTS premise_v2_records_content_fts_idx
  ON premise_v2_records USING GIN (to_tsvector('simple', content_json::text));

INSERT INTO premise_v2_schema_migrations(version) VALUES (6)
ON CONFLICT (version) DO NOTHING;
