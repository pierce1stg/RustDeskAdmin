# Web client acceptance guide

Session journal: levels Info / Warning / Error / Debug (the Debug chip flips the flag
in the live session, no reconnect needed), categories Connection / Codec / Video /
Decoder / Input / Clipboard / Cursor / System / Interface. Search with yellow
highlight; the collapsed journal shows only the count. The clear button empties
entries only — recording continues, the card stays.

## 1. Journal line map

### Connection (healthy if the whole chain takes ~3s)
| Line | Meaning |
|---|---|
| `hbbs: wss://…/ws/id`, `hbbs connected` | rendezvous, punch-hole request |
| `relay_response: relay=… uuid=…` | relay issued the session uuid |
| `hbbr: …/ws/relay`, `hbbr connected` | relay socket |
| `encrypted session established` | crypto up |
| `LoginRequest sent` → `login OK, video stream requested` | host admitted us |
| `SignedId IdPk at offset N` | any N (65/66/…) is fine — the extractor scans by design |
| `relay msg (unhandled fields=21:2)` | benign protocol chatter |
| `peer: user@host (OS) WxH` | who and with which screen |
| `cursor_data in / remote cursor applied` | host cursor |
| `── connect → PEER` / `── connection lost: …` | session boundaries (drops never wipe the journal) |

### Codecs
| Line | Meaning / action |
|---|---|
| `probe: caps gate on (N video mimes)` | engine capability gate active |
| `probe: X capped at 720p/1080p/4K` | engine ceiling; auto won't offer above it |
| `browser codecs: a,b,c` | probe verdict |
| `codec preference at login: auto -> X (last-good)` | proven-first start |
| `codec preference: X (prefer=N)` (debug) | manual pin / preset sent to host |
| `codec X during grace after pin Y` (debug) | transition, host applying (up to 10s) — normal |
| `host streams X despite manual Y` (warning) | host ignores the pin for 10s+ — check whether the host can do Y |
| `codec X excluded: WxH above proven decode cap` (warning) | ladder filtered it out — normal |
| `decoder picked X` (debug) | engine fact (the wire may lie mid-transition) |
| `codec steering A -> B` | auto moved on corrupt frames — normal |
| `codec fallback exhausted` | chain spent — bad, check network/host |
| Red banner | pin undecodable, nowhere to steer — use “back to Auto” |
| Blue banner | auto steered by itself — informational, nothing needed |

### Video & network
| Line | Meaning / action |
|---|---|
| `no frames 0.7s/6s after login, re-sending options` | early re-request — normal |
| `video stalled (N s) — sent refresh` | single — normal; in bursts — dig into the network |
| `auto: A/B -> C/D (kbps, ping, decode/paint)` | ladder decision; the reason is in brackets — read it |
| `E 0/3` in stats | 3 corrupt deltas = path loss |
| `(−N)` next to FPS | lagging frames dropped (catch-up) |

### Input, clipboard, chat
| Line | Meaning |
|---|---|
| `send key #N down Legacy Ctrl+a` (debug) | combos and symbols; Map mode — physical keys (`KeyA`), `raw:NN` without OS |
| `ui: hotkey …`, `ui: clipboard …`, `ui: switch display` | toolbar actions |
| `ui: codec/quality/fps/turbo/zoom/…` | audit of the rest |
| `ui: chat sent/greeting/close notice` | outgoing chat and system messages |

### Errors (red flags)
`decrypt failed`, `relay decode error + hex`, `SignedId unparseable`,
`connect timed out`, `host closed: …`, `manual codec X failed, no auto fallback`.

## 2. Acceptance matrix

Pauses of 20–30s between switches; clear the journal before each case.
| # | Action | PASS |
|---|---|---|
| 1–3 | Auto → VP8 / VP9 / AV1 | `ui:` + `decoder picked`, badge matches within ~10s, no banner |
| 4 | Manual AV1 on a host without AV1 | warning + red banner, badge shows the fact |
| 5 | “Back to Auto” from the banner | back without reconnecting |
| 6–7 | Turbo on / off | preset applied; exact restore (verify the selects) |
| 8 | Reconnect on Auto | `auto -> X (last-good)` at once, no hunting |
| 9 | Chat both ways | host chat window popped; badge; positions survive reload |
| 10 | 10–15s drop | `connection lost` marker, auto-reconnect, journal intact |
| 11 | Monitors (if any) | `display switched`, `decoder picked` for the new resolution |

## 3. Reading stats (a 1-second slice!)

- **Starvation:** Q in the hundreds of ms + growing drops + E>0 + kbps floored. Fix: Auto quality, scale down.
- **Idle:** low FPS but moderate Q, drops still, kbps flowing — just a static screen, all fine.
- **Ping** = RTT + queue on the shared relay socket: grows with heavy codecs (VP8/9) — that is bufferbloat, not “worse network”.
- **Norms:** decode < 40ms, paint < 25ms, Q < 120ms.
- **Ladder bands:** `kbps<1200 or ping>220` → 2/15 (floor); `<3200 or >110` → 3/30; else 4/60. Deep floor (1/10) — Q>300 for two ticks. Start from zero takes the fast path (~10s). Up takes 6 ticks + cooldown (anti-flap).

## 4. Stand geography (Netherlands ↔ Khabarovsk)

Normal: RTT 250–350ms, kbps swinging 0–1800, single stalls, ping up to 1600 on VP8/9 with a clogged queue.
Red flags: E in bursts, drops by the dozen, decode>40, Q>300 for minutes on the 1/10 floor.
The server stays idle (verified: LA ~0.15, hbbr CPU ~0%, zero interface errors) — the backbone drowns, not the VM.
