-- +goose Up
ALTER TABLE users
    ADD COLUMN links               TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN banner_sha256       TEXT,
    ADD COLUMN banner_content_type TEXT;
CREATE INDEX users_banner_sha_idx ON users (banner_sha256) WHERE banner_sha256 IS NOT NULL;

-- +goose Down
DROP INDEX users_banner_sha_idx;
ALTER TABLE users DROP COLUMN banner_content_type, DROP COLUMN banner_sha256, DROP COLUMN links;
