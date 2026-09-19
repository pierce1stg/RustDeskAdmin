-- Migration: 003_add_device_password.up.sql
ALTER TABLE devices ADD COLUMN IF NOT EXISTS password_enc TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS password_updated_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_devices_password ON devices (id) WHERE password_enc IS NOT NULL;