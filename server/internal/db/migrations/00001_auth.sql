-- +goose Up
CREATE TABLE users (
    id            BIGINT PRIMARY KEY,
    username      TEXT NOT NULL,
    email         TEXT,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
    disabled      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_key ON users (lower(username));
CREATE UNIQUE INDEX users_email_key ON users (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE sessions (
    id           BIGINT PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash   BYTEA NOT NULL UNIQUE,
    device_name  TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- A single row of instance-wide settings.
CREATE TABLE instance_settings (
    id                       BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    registration_mode        TEXT NOT NULL DEFAULT 'invite_only'
                             CHECK (registration_mode IN ('invite_only', 'open', 'admin_only')),
    allow_community_creation BOOLEAN NOT NULL DEFAULT TRUE
);
INSERT INTO instance_settings DEFAULT VALUES;

-- +goose Down
DROP TABLE instance_settings;
DROP TABLE sessions;
DROP TABLE users;
