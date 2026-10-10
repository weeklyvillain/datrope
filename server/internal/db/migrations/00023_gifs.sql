-- +goose Up
ALTER TABLE instance_settings
    -- Klipy (GIF search) API key; NULL turns /gif off. Write-only through the API.
    ADD COLUMN klipy_api_key   TEXT,
    -- Keys HMACs of user IDs sent to third parties (Klipy's customer_id), so
    -- real IDs never leave the instance. gen_random_uuid() is built in since
    -- Postgres 13 and uses the strong random source; the default is evaluated
    -- for the existing row, so every instance gets its own secret here.
    ADD COLUMN instance_secret BYTEA NOT NULL
        DEFAULT (uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()));

-- Set on attachments posted with /gif: clients play them like images.
ALTER TABLE attachments ADD COLUMN gif BOOLEAN NOT NULL DEFAULT FALSE;

-- +goose Down
ALTER TABLE attachments DROP COLUMN gif;
ALTER TABLE instance_settings DROP COLUMN instance_secret, DROP COLUMN klipy_api_key;
