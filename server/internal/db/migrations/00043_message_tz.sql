-- +goose Up
-- The sender's IANA time zone, so readers can see "9pm" in their own zone. Null for old, webhook and system messages.
ALTER TABLE messages ADD COLUMN tz text;

-- +goose Down
ALTER TABLE messages DROP COLUMN tz;
