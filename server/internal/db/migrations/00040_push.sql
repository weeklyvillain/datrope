-- +goose Up
-- Web Push: one row per browser that asked for notifications. A subscription
-- belongs to the auth session that made it, so signing out stops pushes.
CREATE TABLE push_subscriptions (
    id           BIGINT PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    session_id   BIGINT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    endpoint     TEXT NOT NULL UNIQUE,
    p256dh       TEXT NOT NULL,
    auth         TEXT NOT NULL,
    level        TEXT NOT NULL CHECK (level IN ('all', 'mentions', 'nothing')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

-- The instance's VAPID keypair, made on first use. Deleting it invalidates every subscription.
CREATE TABLE vapid_keys (
    id          BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    public_key  TEXT NOT NULL,
    private_key TEXT NOT NULL
);

-- +goose Down
DROP TABLE vapid_keys;
DROP TABLE push_subscriptions;
