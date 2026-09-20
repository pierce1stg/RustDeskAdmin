#!/bin/bash
# RustDesk admin - live presence snapshot taken from the hbbs/hbbr server itself.
# hbbs/hbbr run inside docker containers on a bridge network, so socket info is
# read from inside their network namespaces via nsenter.
# This script runs INSIDE the presence container (privileged, pid:host, docker.sock).

OUT_DIR="${PRESENCE_OUT_DIR:-/status}"
FINAL="$OUT_DIR/presence.json"
PEER_STATE="$OUT_DIR/.peer_ips.json"
HBS_CONNS="$OUT_DIR/.hbbs.conns"
HBR_CONNS="$OUT_DIR/.hbbr.conns"

TS=$(date +%s)
STATE_WINDOW=300

HBBS_PID=$(docker inspect -f '{{.State.Pid}}' rustdesk-hbbs 2>/dev/null)
HBBR_PID=$(docker inspect -f '{{.State.Pid}}' rustdesk-hbbr 2>/dev/null)

# Server versions: prefer the image tag, fall back to the binary --version.
get_version() {
  local img ver
  img=$(docker inspect -f '{{.Config.Image}}' "$1" 2>/dev/null)
  ver=$(printf '%s' "$img" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)
  if [ -z "$ver" ]; then
    ver=$(docker exec "$1" "$2" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)
  fi
  printf '%s' "$ver"
}
HBBS_VER=$(get_version rustdesk-hbbs hbbs)
HBBR_VER=$(get_version rustdesk-hbbr hbbr)

# Live connections managed by the server itself (local sport = server port).
# Two captures per server: plain (-tnH, one line per socket, feeds the
# compat ip lists) and with TCP info (-tniH, socket + "lastrcv:<ms>" info
# line, feeds per-conn liveness). -i output is paired in extract_conns_i.
if [ -n "$HBBS_PID" ]; then
  nsenter -t "$HBBS_PID" -n ss -tnH state established '( sport = :21115 or sport = :21116 or sport = :21118 )' 2>/dev/null > "$HBS_CONNS"
  nsenter -t "$HBBS_PID" -n ss -tniH state established '( sport = :21115 or sport = :21116 or sport = :21118 )' 2>/dev/null > "$HBS_CONNS.i"
else
  : > "$HBS_CONNS"
  : > "$HBS_CONNS.i"
fi
if [ -n "$HBBR_PID" ]; then
  nsenter -t "$HBBR_PID" -n ss -tnH state established '( sport = :21117 or sport = :21119 )' 2>/dev/null > "$HBR_CONNS"
  nsenter -t "$HBBR_PID" -n ss -tniH state established '( sport = :21117 or sport = :21119 )' 2>/dev/null > "$HBR_CONNS.i"
else
  : > "$HBR_CONNS"
  : > "$HBR_CONNS.i"
fi

extract_ips() {
  awk '{ip=$NF;
        if (ip ~ /^\[/) { sub(/^\[/,"",ip); sub(/\]:.*/,"",ip) } else { sub(/:[0-9]+$/,"",ip) }
        sub(/^::ffff:/,"",ip);
        print ip
       }' "$1" | sort -u
}

extract_ips_and_counts() {
  awk '{ip=$NF;
        if (ip ~ /^\[/) { sub(/^\[/,"",ip); sub(/\]:.*/,"",ip) } else { sub(/:[0-9]+$/,"",ip) }
        sub(/^::ffff:/,"",ip);
        print ip
       }' "$1" | sort | uniq -c | awk '{print $2, $1}'
}

extract_conns() {
  awk '{
        sp=$(NF-1); if (sp ~ /^\[/) { sub(/^\[/,"",sp) }
        sub(/.*:/,"",sp)
        ip=$NF; if (ip ~ /^\[/) { sub(/^\[/,"",ip); sub(/\]:.*/,"",ip) } else { sub(/:[0-9]+$/,"",ip) }
        sub(/^::ffff:/,"",ip);
        print ip, sp
       }' "$1" | sort -u
}

# Same endpoints as extract_conns plus per-socket "ms since data was last
# received" (lastrcv) from the -i info line paired with each socket line.
# Output "ip sport lastrcv" (lastrcv empty when the kernel did not report it).
extract_conns_i() {
  awk 'function flush() { if (cur != "") print cur, cursp, lastrcv }
       /^[^ \t]/ {
         flush()
         sp=$(NF-1); if (sp ~ /^\[/) { sub(/^\[/,"",sp) }
         sub(/.*:/,"",sp)
         ip=$NF; if (ip ~ /^\[/) { sub(/^\[/,"",ip); sub(/\]:.*/,"",ip) } else { sub(/:[0-9]+$/,"",ip) }
         sub(/^::ffff:/,"",ip);
         cur=ip; cursp=sp; lastrcv=""
         next
       }
       /lastrcv:/ {
         if (match($0, /lastrcv:[0-9]+/)) { lastrcv=substr($0, RSTART+8, RLENGTH-8) }
       }
       END { flush() }' "$1" | sort -u
}

if [ -n "$HBBS_PID" ]; then
  nsenter -t "$HBBS_PID" -n ss -tlnH '( sport = :21116 or sport = :21118 )' 2>/dev/null | grep -q .
  HBBS_LISTEN=$?
else
  HBBS_LISTEN=1
fi
if [ -n "$HBBR_PID" ]; then
  nsenter -t "$HBBR_PID" -n ss -tlnH '( sport = :21117 or sport = :21119 )' 2>/dev/null | grep -q .
  HBBR_LISTEN=$?
else
  HBBR_LISTEN=1
fi

# Peer<->IP bindings observed by hbbs (update_pk on registration, auth attempts).
HBB_LOG=$(docker logs rustdesk-hbbs --since 2m 2>/dev/null || true)
PEER_IP_LINES=$(echo "$HBB_LOG" \
  | grep -oE 'update_pk [0-9]+ \[::ffff:[0-9.]+' \
  | awk '{ip=$3; sub(/^\[/,"",ip); print $2, ip}')
PEER_IP_LINES="$PEER_IP_LINES
$(echo "$HBB_LOG" | grep -oE '\[::ffff:[0-9.]+\]:[0-9]+ for peer [0-9]+' | awk '{ip=$1; sub(/^\[/,"",ip); sub(/:.*/,"",ip); print $4, ip}')"

python3 - "$FINAL" "$PEER_STATE" "$TS" "$STATE_WINDOW" "$(extract_ips "$HBS_CONNS")" "$(extract_ips "$HBR_CONNS")" "$(extract_ips_and_counts "$HBS_CONNS")" "$(extract_ips_and_counts "$HBR_CONNS")" "$(extract_conns "$HBS_CONNS")" "$(extract_conns "$HBR_CONNS")" "$HBBS_LISTEN" "$HBBR_LISTEN" "$PEER_IP_LINES" "$HBBS_VER" "$HBBR_VER" "$(extract_conns_i "$HBS_CONNS.i")" "$(extract_conns_i "$HBR_CONNS.i")" <<'PYEOF'
import json, os, sys
out = sys.argv[1]
peer_state = sys.argv[2]
ts = int(sys.argv[3])
window = int(sys.argv[4])
hbbs = sys.argv[5].split()
hbbr = sys.argv[6].split()
hbbs_counts = {}
hbbr_counts = {}
for line in sys.argv[7].splitlines():
    parts = line.split()
    if len(parts) >= 2:
        hbbs_counts[parts[0]] = int(parts[1])
for line in sys.argv[8].splitlines():
    parts = line.split()
    if len(parts) >= 2:
        hbbr_counts[parts[0]] = int(parts[1])
hbbs_conns = []
hbbr_conns = []
# Per-conn liveness (lastrcv ms) comes from the -i capture; when it is empty
# but plain endpoints exist (parse miss), fall back to endpoints with unknown
# liveness (null = treated as active downstream).
for target, plain, lively in (
    (hbbs_conns, sys.argv[9], sys.argv[16]),
    (hbbr_conns, sys.argv[10], sys.argv[17]),
):
    seen = set()
    for line in lively.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[1].isdigit():
            ms = int(parts[2]) if len(parts) >= 3 and parts[2].isdigit() else None
            target.append({"ip": parts[0], "port": int(parts[1]), "lastrcv_ms": ms})
            seen.add((parts[0], parts[1]))
    if not target:
        for line in plain.splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[1].isdigit() and (parts[0], parts[1]) not in seen:
                target.append({"ip": parts[0], "port": int(parts[1]), "lastrcv_ms": None})
hbl = sys.argv[11] == '0'
hrl = sys.argv[12] == '0'

# Rolling per-peer IP map persisted between runs so a device that connected
# minutes ago is still attributable even if it has been quiet since.
state = {}
if os.path.exists(peer_state):
    try:
        with open(peer_state) as f:
            state = json.load(f)
    except Exception:
        state = {}
for line in sys.argv[13].splitlines():
    p = line.split()
    if len(p) >= 2:
        state[p[0]] = {"ip": p[1], "ts": ts}
state = {k: v for k, v in state.items() if ts - int(v.get("ts", 0)) <= window}

peer_ips = {}
for uid, meta in sorted(state.items()):
    peer_ips[uid] = [meta["ip"]]

data = {"ts": ts, "hbbs": hbbs, "hbbr": hbbr,
        "hbbs_listening": hbl, "hbbr_listening": hrl,
        "peer_ips": peer_ips,
        "hbbs_counts": hbbs_counts, "hbbr_counts": hbbr_counts,
        "hbbs_version": sys.argv[14], "hbbr_version": sys.argv[15],
        "hbbs_conns": hbbs_conns, "hbbr_conns": hbbr_conns}

with open(peer_state, "w") as f:
    json.dump(state, f)
with open(out, "w") as f:
    json.dump(data, f)
PYEOF

rm -f "$HBS_CONNS" "$HBR_CONNS" "$HBS_CONNS.i" "$HBR_CONNS.i"