# Changelog

## v1.0.0 — first public release

Panel (React SPA + Go API, Docker Compose) for a self-hosted RustDesk server
(hbbs/hbbr 1.1.16, Postgres, nginx + Let's Encrypt, presence poller).

- Devices: live presence (SSE push), PeerInfo columns, search/pin/alias,
  encrypted saved passwords, in-panel self-update from GitHub releases.
- Browser remote control: VP8/VP9/AV1 software decode, proven-first auto with
  last-good memory, manual pins with overrule grace, auto-quality ladder with
  deep floor, turbo preset, render-scale caps, multi-monitor, clipboard,
  hotkeys, touch trackpad.
- Session journal v2: levels/categories/search/highlight, record gating,
  drop markers, collapse with count, full `ui:` audit trail.
- Session chat: floating window + dockable bubble, unread badge, emoji picker,
  configurable greeting/close notice, configurable client display name.
- Settings: collapsible sections, web-client defaults (quality/fps/codec/
  render-scale/cursor/input-mode), chat texts, JWT TTLs.
- Public download page with per-locale texts and screenshot uploads.
