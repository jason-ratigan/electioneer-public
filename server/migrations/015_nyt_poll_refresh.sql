-- A refresh job is queued before the remote bytes exist. Once downloaded it
-- follows the same checksummed preview and publication path as an upload.
ALTER TABLE admin_imports ALTER COLUMN sha256 DROP NOT NULL;
ALTER TABLE admin_imports ALTER COLUMN byte_size DROP NOT NULL;
ALTER TABLE admin_imports ADD COLUMN auto_publish BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE admin_imports ADD COLUMN refresh_batch_id UUID;
ALTER TABLE admin_imports ADD CONSTRAINT admin_import_download_bytes_check
  CHECK (phase = 'download' OR (sha256 IS NOT NULL AND byte_size IS NOT NULL));
CREATE INDEX admin_import_refresh_batch_idx ON admin_imports(refresh_batch_id)
  WHERE refresh_batch_id IS NOT NULL;
