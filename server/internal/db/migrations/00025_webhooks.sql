-- +goose Up
ALTER TABLE channels DROP CONSTRAINT channels_type_check;
ALTER TABLE channels ADD CONSTRAINT channels_type_check CHECK (type IN ('text', 'voice', 'welcome', 'dm', 'thread', 'webhook'));

-- Incoming webhooks. Only the token's SHA-256 is stored, like sessions.
CREATE TABLE webhooks (
    id                  BIGINT PRIMARY KEY,
    channel_id          BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    avatar_sha256       TEXT,
    avatar_content_type TEXT,
    token_hash          BYTEA NOT NULL,
    created_by          BIGINT REFERENCES users (id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhooks_channel_idx ON webhooks (channel_id);
CREATE INDEX webhooks_avatar_sha_idx ON webhooks (avatar_sha256) WHERE avatar_sha256 IS NOT NULL;

-- A webhook message has no author: it keeps the name and avatar it was posted
-- with, so renaming or deleting the webhook does not change it.
ALTER TABLE messages
    ALTER COLUMN author_id DROP NOT NULL,
    ADD COLUMN webhook_id           BIGINT REFERENCES webhooks (id) ON DELETE SET NULL,
    ADD COLUMN author_name          TEXT NOT NULL DEFAULT '',
    ADD COLUMN author_avatar_sha256 TEXT,
    ADD COLUMN embeds               JSONB,
    ADD CONSTRAINT messages_has_author CHECK (author_id IS NOT NULL OR author_name <> '');
CREATE INDEX messages_webhook_idx ON messages (webhook_id) WHERE webhook_id IS NOT NULL;

-- Every image a message shows that is not an attachment: a webhook message's
-- avatar and embed images. Its rows keep their blobs alive and say who may
-- fetch them (readers of the message's channel).
CREATE TABLE message_images (
    message_id   BIGINT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    sha256       TEXT NOT NULL,
    content_type TEXT NOT NULL,
    PRIMARY KEY (message_id, sha256)
);
CREATE INDEX message_images_sha_idx ON message_images (sha256);

-- +goose Down
DROP TABLE message_images;
DELETE FROM messages WHERE author_id IS NULL;
DROP INDEX messages_webhook_idx;
ALTER TABLE messages
    DROP CONSTRAINT messages_has_author,
    DROP COLUMN embeds,
    DROP COLUMN author_avatar_sha256,
    DROP COLUMN author_name,
    DROP COLUMN webhook_id,
    ALTER COLUMN author_id SET NOT NULL;
DROP TABLE webhooks;
DELETE FROM channels WHERE type = 'webhook';
ALTER TABLE channels DROP CONSTRAINT channels_type_check;
ALTER TABLE channels ADD CONSTRAINT channels_type_check CHECK (type IN ('text', 'voice', 'welcome', 'dm', 'thread'));
