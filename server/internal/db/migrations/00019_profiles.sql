-- +goose Up
ALTER TABLE users
    ADD COLUMN pronouns            TEXT NOT NULL DEFAULT '',
    ADD COLUMN about_me            TEXT NOT NULL DEFAULT '',
    ADD COLUMN avatar_sha256       TEXT,
    ADD COLUMN avatar_content_type TEXT;
CREATE INDEX users_avatar_sha_idx ON users (avatar_sha256) WHERE avatar_sha256 IS NOT NULL;

-- +goose Down
DROP INDEX users_avatar_sha_idx;
ALTER TABLE users DROP COLUMN avatar_content_type, DROP COLUMN avatar_sha256, DROP COLUMN about_me, DROP COLUMN pronouns;
