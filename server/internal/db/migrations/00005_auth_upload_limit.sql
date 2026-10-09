-- +goose Up
ALTER TABLE instance_settings
    ADD COLUMN max_upload_bytes BIGINT NOT NULL DEFAULT 52428800
    CHECK (max_upload_bytes BETWEEN 1048576 AND 10737418240);

-- +goose Down
ALTER TABLE instance_settings DROP COLUMN max_upload_bytes;
