-- +goose Up
-- Size tiers after which sent files are deleted ([{min_bytes, ttl_hours}]; empty: never), and each file's
-- expiry: when it goes (stamped at send), whether someone chose to keep it, and when it went.
ALTER TABLE instance_settings ADD COLUMN upload_ttl_rules JSONB NOT NULL DEFAULT '[]';
ALTER TABLE attachments
  ADD COLUMN expires_at TIMESTAMPTZ,
  ADD COLUMN keep BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN expired_at TIMESTAMPTZ;
CREATE INDEX attachments_expiry_idx ON attachments (expires_at) WHERE expired_at IS NULL AND NOT keep AND expires_at IS NOT NULL;

-- +goose Down
DROP INDEX attachments_expiry_idx;
ALTER TABLE attachments DROP COLUMN expired_at, DROP COLUMN keep, DROP COLUMN expires_at;
ALTER TABLE instance_settings DROP COLUMN upload_ttl_rules;
