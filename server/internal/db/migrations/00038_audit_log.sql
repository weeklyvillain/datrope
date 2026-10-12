-- +goose Up
-- The audit log: what moderators and admins changed, and who did it.
-- id is a Snowflake, so it orders the log and dates each entry.
-- details snapshots names (channels, roles) that may be renamed or deleted later.
CREATE TABLE audit_log (
    id        BIGINT PRIMARY KEY,
    actor_id  BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    action    TEXT NOT NULL,
    target_id BIGINT,
    details   JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_actor_id ON audit_log (actor_id);

-- +goose Down
DROP TABLE audit_log;
