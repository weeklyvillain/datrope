-- +goose Up
-- Personal notes: private rich-text notes, visible only to their owner (spec: personal notes).
CREATE TABLE notes (
    id         BIGINT PRIMARY KEY, -- snowflake; created_at is its time
    user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title      TEXT NOT NULL DEFAULT '',
    content    JSONB NOT NULL,     -- Tiptap/ProseMirror doc
    text       TEXT NOT NULL DEFAULT '', -- plain text of content, sent by the client, for previews and search
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notes_user_idx ON notes (user_id, updated_at DESC);

-- +goose Down
DROP TABLE notes;
