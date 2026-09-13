-- Migration: 002_settings_table.up.sql
CREATE TABLE IF NOT EXISTS settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO settings (key, value)
VALUES ('device_status_refresh_interval', '30')
ON CONFLICT (key) DO NOTHING;
