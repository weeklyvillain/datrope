-- +goose Up
ALTER TABLE invites ADD COLUMN guest_ttl_seconds INT
    CHECK (guest_ttl_seconds BETWEEN 3600 AND 2592000);
ALTER TABLE users ADD COLUMN guest_expires_at TIMESTAMPTZ;
CREATE INDEX users_guest_expiry_idx ON users (guest_expires_at)
    WHERE guest_expires_at IS NOT NULL AND NOT disabled;
ALTER TABLE roles ADD COLUMN is_guest BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX roles_one_guest ON roles (community_id) WHERE is_guest;

-- +goose Down
DROP INDEX roles_one_guest;
ALTER TABLE roles DROP COLUMN is_guest;
DROP INDEX users_guest_expiry_idx;
ALTER TABLE users DROP COLUMN guest_expires_at;
ALTER TABLE invites DROP COLUMN guest_ttl_seconds;
