# Changelog

## v1.0.2 — 2026-09-20

- Device search that works: decimal IDs match hex-encoded peer_id; field
  picker popover (no modal) with per-field contains/exact/starts conditions,
  persisted locally.
- Pinned devices use a high-contrast amber/white style in both themes;
  codec-fatal dialog buttons are flat.
- Activity column renamed to last activity (devices + dashboard).
- Server conn rows attribute distinct peers deterministically (no more
  first-match lottery or flapping); ghost badge removed, dimmed rows with
  tooltip stay.
- Presence verdict from hbbs itself: the backend asks the rendezvous server
  (OnlineRequest on :21115, same as native clients) for the authoritative
  per-peer online bitmask (30s heartbeat window), ending all shared-NAT
  misattribution. Socket detection remains only as a fallback.
- Server card honesty: silent sockets and rows whose peer is offline per hbbs
  are dimmed with a tooltip; device counts cover only sockets with recent
  traffic.
- Presence honesty: sockets prove alive only with recent traffic (ss lastrcv,
  5-min window) — silent leftovers of powered-off PCs no longer mark anyone
  online; shared-NAT picks are flagged `shared:<ip>` instead of silently
  winning forever; log-based peer→IP mappings expire.
- Devices table shows why a peer is online (live socket IP / shared socket /
  grace hold) and flags peers online long past the maximum grace as stale.

## v1.0.1 — 2026-09-20

- Panel update card is live: status/log/backups poll while work runs (and on
  window focus), manual Refresh button, no page reload needed.
- Manual rollback success shows a green banner + success toast; red is reserved
  for real failures. Terminal banners are dismissible (remembered per run).
- Backups section shows the `data/.panel-update-backups` storage path so a
  foreign `pre-vX.Y.Z.tar.gz` can be dropped in and rolled back to; each copy
  shows its date/time; a Create-backup button snapshots the running tree on
  demand (`pre-vX.Y.Z-manual-<ts>.tar.gz`, same rollback/delete rules).
- SPA fallback (`/settings`, …) now serves `index.html` with `no-cache` so a
  fresh bundle is picked up after every deploy without a hard reload.
- `setup.sh` checks host tools (docker, Compose v2 plugin, daemon, openssl,
  curl) with install hints; shellcheck-clean; dry-run verified on Ubuntu
  22.04/24.04 (all local branches incl. LE retry/success paths).
- Panel self-update robustness: download retries, no more silent deaths (every
  exit records a terminal state), honest exit codes, live runner log in the
  panel, stuck-state reset button, backup list with one-click rollback and
  deletion, pre-update checks (bundle reachability, disk space, runner state).
- `.env` validation in `setup.sh` (clear error for unquoted values with spaces).

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
