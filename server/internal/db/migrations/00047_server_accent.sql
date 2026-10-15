-- +goose Up
-- Servers pick any accent colour, not one of six palettes (spec: custom colors §2).
-- palette stays for now: the previous release still reads it while the update switches slots
-- (README.md). A later release drops it in a -- datrope:contract migration.
ALTER TABLE communities ADD COLUMN accent_color TEXT NOT NULL DEFAULT '#2ecc71'
    CHECK (accent_color ~ '^#[0-9a-f]{6}$');
UPDATE communities SET accent_color = CASE palette
    WHEN 'ocean' THEN '#4aa3ff' WHEN 'violet' THEN '#a78bfa' WHEN 'amber' THEN '#f5a524'
    WHEN 'rose' THEN '#fb7185' WHEN 'mint' THEN '#2dd4bf' ELSE '#2ecc71' END;

-- +goose Down
UPDATE communities SET palette = CASE accent_color
    WHEN '#4aa3ff' THEN 'ocean' WHEN '#a78bfa' THEN 'violet' WHEN '#f5a524' THEN 'amber'
    WHEN '#fb7185' THEN 'rose' WHEN '#2dd4bf' THEN 'mint' ELSE 'emerald' END;
ALTER TABLE communities DROP COLUMN accent_color;
