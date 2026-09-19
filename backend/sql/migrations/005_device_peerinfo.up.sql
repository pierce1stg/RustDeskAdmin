-- Migration: 005_device_peerinfo.up.sql
-- Last-known PeerInfo snapshot per device, written by the web client on
-- session login (PeerInfo only exists inside a live encrypted session).
-- NULL until the first panel connect; refreshed when values change.
ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS hostname TEXT,
    ADD COLUMN IF NOT EXISTS username TEXT,
    ADD COLUMN IF NOT EXISTS platform TEXT,
    ADD COLUMN IF NOT EXISTS host_version TEXT,
    ADD COLUMN IF NOT EXISTS displays JSONB,
    ADD COLUMN IF NOT EXISTS peerinfo_updated_at TIMESTAMPTZ;
