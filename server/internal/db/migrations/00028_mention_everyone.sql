-- +goose Up
-- The message pinged @everyone (its author held MENTION_EVERYONE).
ALTER TABLE messages ADD COLUMN mention_everyone BOOLEAN NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE messages DROP COLUMN mention_everyone;
