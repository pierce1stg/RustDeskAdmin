#!/usr/bin/env bash
# rustdesk-stack bootstrap
# - fills empty/changeme secrets in .env
# - prepares data/ (hbbs, postgres, certbot)
# - generates a self-signed placeholder cert so nginx always boots
# - builds & starts the stack
# - issues a real Let's Encrypt cert via webroot when possible
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE=".env"
if [ ! -f "$ENV_FILE" ]; then
    cp .env.example "$ENV_FILE"
    echo "[setup] Created $ENV_FILE from .env.example."
    echo "[setup] Edit it (DOMAIN, LETSENCRYPT_EMAIL) and run ./setup.sh again."
    exit 1
fi

gen_secret() {
    openssl rand -base64 32 | tr -d '=+/' | head -c 40
}

# Fill empty or placeholder secrets in .env
for KEY in POSTGRES_PASSWORD JWT_SECRET JWT_REFRESH_SECRET; do
    line=$(grep -E "^$KEY=" "$ENV_FILE" | head -1 || true)
    val=${line#*=}
    if [ -z "$val" ] || [ "$val" = "changeme" ]; then
        new=$(gen_secret)
        if [ -n "$line" ]; then
            sed -i "s|^$KEY=.*|$KEY=$new|" "$ENV_FILE"
        else
            echo "$KEY=$new" >> "$ENV_FILE"
        fi
        echo "[setup] $KEY generated"
    fi
done

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [ -z "${DOMAIN:-}" ] || [ "${DOMAIN:-}" = "app.example.com" ]; then
    echo "[setup] ERROR: DOMAIN is not set in .env" >&2
    exit 1
fi

echo "[setup] DOMAIN=$DOMAIN  EMAIL=${LETSENCRYPT_EMAIL:-<none>}"

mkdir -p data/hbbs data/postgres data/screenshots data/certbot/etc data/certbot/www status

# Self-signed placeholder so nginx can always receive a TLS certificate at boot.
# It is a plain directory holding a real self-signed cert - never a certbot lineage -
# so the path nginx reads (live/$DOMAIN/fullchain.pem) is always resolvable, while
# certbot gets a dedicated lineage name (<DOMAIN>-le) that cannot collide with any
# pre-existing directories on the first issuance attempt.
CERT_DIR="data/certbot/etc/live/$DOMAIN"
if [ ! -f "$CERT_DIR/fullchain.pem" ]; then
    rm -rf "$CERT_DIR"
    mkdir -p "$CERT_DIR"
    openssl req -x509 -nodes -newkey rsa:2048 -days 3660 \
        -keyout "$CERT_DIR/privkey.pem" -out "$CERT_DIR/fullchain.pem" \
        -subj "/CN=$DOMAIN" >/dev/null 2>&1
    echo "[setup] placeholder self-signed cert created for $DOMAIN"
fi

echo "[setup] starting stack (first build may take a while)..."
docker compose up -d --build

# hbbs creates ./data/hbbs/db_v2.sqlite3 on first start; backend needs it
for i in $(seq 1 60); do
    [ -f data/hbbs/db_v2.sqlite3 ] && break
    sleep 1
done
if [ ! -f data/hbbs/db_v2.sqlite3 ]; then
    echo "[setup] warning: hbbs db_v2.sqlite3 not created within 60s (check 'docker compose logs hbbs')"
fi

# Real Let's Encrypt certificate (webroot on port 80 of this host).
# Issued under a dedicated lineage (<DOMAIN>-le); once obtained, live/<DOMAIN> is
# switched to a symlink into that lineage, which nginx follows on the next reload.
# The placeholder live/<DOMAIN> stays resolvable for nginx the whole time, while
# certbot gets a fresh lineage name so even the very first attempt never collides.
ISSUED_FLAG="data/certbot/etc/.le-issued"
LE_NAME="$DOMAIN-le"

cert_is_placeholder() {
    # true when the cert currently served is still the self-signed placeholder
    [ -f "$CERT_DIR/fullchain.pem" ] || return 1
    openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -issuer 2>/dev/null \
        | grep -qE "CN *= *$DOMAIN"
}

if [ -n "${LETSENCRYPT_EMAIL:-}" ] && cert_is_placeholder; then
    if [ "${HTTP_PORT:-80}" = "80" ]; then
        echo "[setup] issuing Let's Encrypt certificate for $DOMAIN..."
        # Wait until nginx answers on port 80: the ACME webroot challenge must be
        # reachable, so issuing while nginx is (re)starting would only waste attempts.
        ready=0
        for i in $(seq 1 30); do
            code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
                "http://127.0.0.1/__health" 2>/dev/null || true)
            if [ "$code" = "200" ]; then ready=1; break; fi
            sleep 1
        done
        if [ "$ready" != 1 ]; then
            echo "[setup] WARNING: nginx not answering on port 80 yet; skipping issuance."
            echo "[setup] Check 'docker compose ps' and 'docker compose logs nginx'."
        else
            # Start from a clean dedicated lineage so any retry never collides with
            # leftovers from previous runs or accidental -0001 certificates.
            rm -rf "data/certbot/etc/archive/$LE_NAME" "data/certbot/etc/live/$LE_NAME"
            rm -f "data/certbot/etc/renewal/$LE_NAME.conf"
            rm -rf "data/certbot/etc/live/$DOMAIN"-[0-9]* "data/certbot/etc/archive/$DOMAIN"-[0-9]*
            rm -f "data/certbot/etc/renewal/$DOMAIN"-[0-9]*.conf
            issued=0
            attempt=0
            while [ "$attempt" -lt 3 ]; do
                attempt=$((attempt + 1))
                echo "[setup] certificate issuance attempt $attempt/3..."
                if docker compose run --rm --no-deps --entrypoint certbot certbot certonly \
                    --webroot -w /var/www/certbot -d "$DOMAIN" \
                    --cert-name "$LE_NAME" \
                    -m "$LETSENCRYPT_EMAIL" --agree-tos --no-eff-email; then
                    # Point the placeholder live/<DOMAIN> at the issued lineage; nginx
                    # picks the real chain up on the reload below.
                    rm -rf "$CERT_DIR"
                    ln -sfn "$LE_NAME" "$CERT_DIR"
                    touch "$ISSUED_FLAG" || true
                    docker exec rustdesk-admin-nginx nginx -s reload >/dev/null 2>&1 || true
                    echo "[setup] certificate issued"
                    issued=1
                    break
                fi
                echo "[setup] issuance attempt $attempt/3 failed"
                if [ "$attempt" -lt 3 ]; then
                    sleep 20
                fi
            done
            if [ "$issued" != 1 ]; then
                echo "[setup] WARNING: certificate issuance failed; running with placeholder cert."
                echo "[setup] Re-run ./setup.sh after checking DNS for $DOMAIN and that TCP port 80 is reachable."
            fi
        fi
    else
        echo "[setup] HTTP_PORT != 80, skipping automatic Let's Encrypt issuance."
    fi
fi

echo
echo "[setup] done. Summary:"
docker compose ps
echo
HTTPS_PORT_VAL="${HTTPS_PORT:-443}"
if [ "$HTTPS_PORT_VAL" = "443" ]; then
    echo "Admin console : https://$DOMAIN"
else
    echo "Admin console : https://$DOMAIN:$HTTPS_PORT_VAL"
fi
echo "RustDesk ID    : $DOMAIN:${ID_PORT:-21116}  / relay: ${RELAY_PORT:-21117}"
echo "Keys in        : $CERT_DIR"
echo "[setup] hint: pairwise admin credentials were seeded as ADMIN_USERNAME/ADMIN_PASSWORD; change them in the panel."

# Optional docker cleanup to keep the disk lean (see Block D in .env).
#   none - no cleanup
#   safe - dangling images + build cache only
#   all  - everything not used by a running container (default)
case "${DOCKER_PRUNE_ON_BUILD:-all}" in
    none)
        echo "[setup] docker cleanup skipped (DOCKER_PRUNE_ON_BUILD=none)"
        ;;
    safe)
        echo "[setup] pruning dangling images and build cache..."
        docker image prune -f >/dev/null 2>&1 || true
        docker builder prune -f >/dev/null 2>&1 || true
        ;;
    all)
        echo "[setup] pruning unused docker resources (DOCKER_PRUNE_ON_BUILD=all)..."
        docker image prune -a -f >/dev/null 2>&1 || true
        docker system prune -f >/dev/null 2>&1 || true
        ;;
    *)
        echo "[setup] WARNING: unknown DOCKER_PRUNE_ON_BUILD='$DOCKER_PRUNE_ON_BUILD' (use none|safe|all); skipping cleanup."
        ;;
esac