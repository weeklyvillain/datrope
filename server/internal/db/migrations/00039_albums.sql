-- +goose Up
-- Albums: personal collections of files, from channels or uploaded into the album.
CREATE TABLE albums (
    id         BIGINT PRIMARY KEY, -- snowflake; created_at is its time
    owner_id   BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'server')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX albums_owner_idx ON albums (owner_id);

-- Collaborators; the owner is not listed.
CREATE TABLE album_members (
    album_id BIGINT NOT NULL REFERENCES albums (id) ON DELETE CASCADE,
    user_id  BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    PRIMARY KEY (album_id, user_id)
);
CREATE INDEX album_members_user_idx ON album_members (user_id);

-- An attachment lives in a channel or, uploaded straight into one, in an album.
ALTER TABLE attachments
    ALTER COLUMN channel_id DROP NOT NULL,
    ADD COLUMN album_id BIGINT REFERENCES albums (id) ON DELETE CASCADE,
    ADD CONSTRAINT attachments_home_check CHECK ((channel_id IS NULL) <> (album_id IS NULL));
CREATE INDEX attachments_album_idx ON attachments (album_id) WHERE album_id IS NOT NULL;

CREATE TABLE album_items (
    album_id      BIGINT NOT NULL REFERENCES albums (id) ON DELETE CASCADE,
    attachment_id BIGINT NOT NULL REFERENCES attachments (id) ON DELETE CASCADE,
    added_by      BIGINT REFERENCES users (id) ON DELETE SET NULL,
    added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (album_id, attachment_id)
);
CREATE INDEX album_items_attachment_idx ON album_items (attachment_id);

-- +goose Down
DROP TABLE album_items;
DELETE FROM attachments WHERE album_id IS NOT NULL;
ALTER TABLE attachments
    DROP CONSTRAINT attachments_home_check,
    DROP COLUMN album_id,
    ALTER COLUMN channel_id SET NOT NULL;
DROP TABLE album_members;
DROP TABLE albums;
