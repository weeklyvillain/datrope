-- +goose Up
CREATE TABLE attachments (
    id           BIGINT PRIMARY KEY,
    channel_id   BIGINT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    uploader_id  BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    message_id   BIGINT REFERENCES messages (id) ON DELETE CASCADE, -- NULL until sent with a message
    filename     TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size         BIGINT NOT NULL,
    sha256       TEXT NOT NULL,
    width        INT,
    height       INT,
    thumb_sha256 TEXT,
    inline       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX attachments_message_idx ON attachments (message_id);
CREATE INDEX attachments_unsent_idx ON attachments (created_at) WHERE message_id IS NULL;
CREATE INDEX attachments_sha_idx ON attachments (sha256);
CREATE INDEX attachments_thumb_idx ON attachments (thumb_sha256) WHERE thumb_sha256 IS NOT NULL;

-- +goose Down
DROP TABLE attachments;
