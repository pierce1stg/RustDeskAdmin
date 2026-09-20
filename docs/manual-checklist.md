# Web client manual checklist (per release)

Run against the test stand (your panel host) after `npm run build` passes.
Unit/integration coverage lives in `frontend/src/lib/rustdesk/__tests__/` (`npm test`).
Everything below needs human eyes / real devices.

## Matrix: viewer browser × host

| Viewer \ Host | PC (Linux/Win) | Phone (Android) |
|---|---|---|
| Chrome desktop | video all codecs, input, clipboard, 2FA, click-accept | rotation reinit, touch trackpad, cursor circle |
| Yandex desktop | engine-unsupported codec → auto fallback (~4-8s, nudge then escalate), banner Back-to-Auto | same as Chrome |
| Safari macOS | VP9 first (last-good), AV1 where probed | — |
| Safari iPhone | panel usable; remote control: no fullscreen on div, clipboard-read may deny | — |
| Firefox desktop | VP8/VP9/AV1 per probe | — |

## Scenarios
- [ ] Connect with password → first frame ≤ 5s, no `decode error` storm in console.
- [ ] Request access (empty + omitted variants) on click-mode host → dialog on host → Accept → in.
- [ ] Dismiss on host → friendly "host dismissed" + retry.
- [ ] Wrong password → password dialog back, typed value kept.
- [ ] 2FA host → code dialog; wrong code → retry in place.
- [ ] 2FA + reconnect: drop network → fresh-code dialog → auto-submit works.
- [ ] Second web session while native connected → picture appears (OptionUpdate path).
- [ ] Auto quality: throttle network → downshift in ~3-5s (`auto:` lines in `?debug=1` journal); recover → upshift, no flapping.
- [ ] Turbo on/off: preset applies, snapshot restores, knob exits silently.
- [ ] Pause: zero host-bound input, panel clickable above dim, resume snaps back.
- [ ] Render scale 144p→1440p/Original: backing changes, no crash.
- [ ] Manual codec on a failing engine → fatal banner (no silent switch), Back-to-Auto recovers.
- [ ] RU keyboard: Ctrl+C on RU layout, printable `ф`, keyup silence.
- [ ] Wayland host hotkeys (Ctrl+Alt+Del via toolbar).
- [ ] Phone host rotation → reinit without mosaic; multi-monitor switch + revert.
- [ ] Panel Settings web defaults (quality/fps/codec) apply to new sessions.
- [ ] Locales RU/EN/ZH/AR: dialogs fit, no overflow, RTL (AR) sane.

## Panel self-update card (Settings → Panel update)
- [ ] Open the card on a stale state → status/log/backups load without F5; window
      blur/focus re-pulls; Refresh button re-pulls all four (status/log/backups/preflight).
- [ ] Run apply or rollback → log streams live, no page reload needed; terminal toast appears.
- [ ] Clean manual rollback → green banner + success toast (no red); F5 keeps it green, not red.
- [ ] Failed update with auto-rollback → red banner with the kept cause; toast shows the cause.
- [ ] Terminal banner X → hides it; stays hidden across F5 until the next run or a reset.
- [ ] Backups section shows the `data/.panel-update-backups` path hint; dropping a foreign
      `pre-vX.Y.Z.tar.gz` there + Refresh lists it and rollback to it works.
- [ ] Create-backup button → `pre-vX.Y.Z-manual-<ts>.tar.gz` appears with date/time;
      rollback to it and deletion work like automatic copies.
- [ ] Reset button visible for any non-idle phase (incl. terminal ok/rolled_back/error);
      reset clears status + log and returns the card to a clean slate.

## Telemetry to attach to bug reports
Session journal (`Terminal` button) + `browser codecs:` line + stats row
(FPS/down/ping/decode/paint/queue) + browser version + host OS.
