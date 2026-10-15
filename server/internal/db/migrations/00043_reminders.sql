-- +goose Up
-- The System account sends reminders. It cannot log in ('!' matches no bcrypt hash),
-- and disabled keeps it out of the server's owner and member queries.
ALTER TABLE users ADD COLUMN is_system BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX users_one_system ON users (is_system) WHERE is_system;
-- A real user may already be called "system": System sits outside the username index.
DROP INDEX users_username_key;
CREATE UNIQUE INDEX users_username_key ON users (lower(username)) WHERE NOT is_system;
INSERT INTO users (id, username, display_name, password_hash, disabled, is_system)
VALUES (4194303, 'system', 'System', '!', TRUE, TRUE);

CREATE TABLE reminders (
    id         BIGINT PRIMARY KEY,
    user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    due_at     TIMESTAMPTZ NOT NULL,
    note       TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 500),
    channel_id BIGINT, -- the message reminded about; no FK: it may be deleted later
    message_id BIGINT,
    fired_at   TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((channel_id IS NULL) = (message_id IS NULL))
);
CREATE INDEX reminders_due_idx ON reminders (due_at) WHERE fired_at IS NULL;
CREATE INDEX reminders_user_idx ON reminders (user_id) WHERE fired_at IS NULL;

-- Set on kind = 'reminder' messages: the reminder they delivered.
ALTER TABLE messages ADD COLUMN reminder_id BIGINT;

-- +goose Down
ALTER TABLE messages DROP COLUMN reminder_id;
DROP TABLE reminders;
DELETE FROM channels WHERE id IN (SELECT channel_id FROM dm_participants WHERE user_id = 4194303);
DELETE FROM users WHERE is_system;
DROP INDEX users_username_key;
CREATE UNIQUE INDEX users_username_key ON users (lower(username));
DROP INDEX users_one_system;
ALTER TABLE users DROP COLUMN is_system;
