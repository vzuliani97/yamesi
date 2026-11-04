-- Binary files for STORAGE_DRIVER=postgres (the free public demo, which has no object store).
-- Local and AWS deployments keep using S3; there this table stays empty.
CREATE TABLE stored_files (
  key          TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  body         BYTEA NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
