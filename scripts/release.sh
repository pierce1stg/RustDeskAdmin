#!/usr/bin/env bash
#
# Release helper. Builds the versioned bundle, tags the repo, pushes it and
# publishes a GitHub release with the binary assets.
#
# Usage:
#   scripts/release.sh v1.0.1 [--prerelease]
#
# Requirements:
#   - clean git tree on branch "main" in sync with origin/main
#   - GITHUB_TOKEN (or GH_TOKEN): classic PAT with "repo" scope for the
#     public GitHub API (pull access is public, but creating releases and
#     uploading assets requires authentication)
#   - docker to run the backend/frontend checks in throwaway containers
#
set -euo pipefail

REPO="pierce1stg/RustDeskAdmin"
REMOTE="https://github.com/$REPO.git"
VERSION_FILE="backend/internal/appversion/version.go"
PRE_RELEASE=0

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  sed -n '1,16p' "$0"
  exit 0
fi

VERSION="${1:?usage: scripts/release.sh vX.Y.Z [--prerelease]}"
if [[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  :
else
  echo "error: version must look like v1.2.3 (got: $VERSION)" >&2
  exit 1
fi

for arg in "$@"; do
  [ "$arg" = "--prerelease" ] && PRE_RELEASE=1
done

TAG="$VERSION"
SEMVER="${VERSION#v}"
GITHUB_TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"

echo "==> preflight"
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "error: not on main" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "error: worktree is not clean" >&2; exit 1; }
git fetch origin main >/dev/null 2>&1 || true
if [ -n "$(git rev-parse --verify -q origin/main)" ] && [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "error: local main is out of sync with origin/main (run git pull)" >&2
  exit 1
fi
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "error: tag $TAG already exists" >&2
  exit 1
fi

echo "==> setting version $SEMVER"
sed -i "s/const Version = \"[^\"]*\"/const Version = \"$SEMVER\"/" "$VERSION_FILE"
grep -n 'const Version' "$VERSION_FILE"

echo "==> backend checks (gofmt, go vet, go test)"
docker run --rm -v "$PWD/backend:/app" -w /app golang:1.25-alpine \
  sh -c 'gofmt -w $(find . -name "*.go" -not -path "./vendor/*") && go vet ./... && go test ./...'

echo "==> frontend checks (eslint, tsc)"
docker run --rm -v "$PWD/frontend:/app" -w /app node:24-trixie-slim \
  sh -c 'npm ci --no-audit --no-fund && npx eslint src --max-warnings 0 && npx tsc --noEmit'

echo "==> commit and tag"
if [ -z "$(git status --porcelain)" ]; then
  echo "no working-tree changes"
else
  git add -A
  git commit -m "release: $TAG"
fi
git tag -a "$TAG" -m "RustDesk Admin $TAG"

echo "==> building bundle"
mkdir -p .release
git archive --format=tar.gz -o ".release/rustdesk-admin-$TAG.tar.gz" "$TAG"
(
  cd .release
  sha256sum "rustdesk-admin-$TAG.tar.gz" > SHA256SUMS
)
ls -lh .release/

echo "==> pushing"
if [ -n "$GITHUB_TOKEN" ]; then
  PUSH_URL="https://x-access-token:$GITHUB_TOKEN@github.com/$REPO.git"
else
  echo "warning: GITHUB_TOKEN not set, pushing over the configured remote" >&2
  PUSH_URL="$REMOTE"
fi
git push "$PUSH_URL" main
git push "$PUSH_URL" "$TAG"

if [ -z "$GITHUB_TOKEN" ]; then
  echo "warning: GITHUB_TOKEN not set, skipping release creation and asset upload" >&2
  echo "create it manually at https://github.com/$REPO/releases/new?tag=$TAG" >&2
  exit 0
fi

echo "==> creating release"
if [ "$PRE_RELEASE" = 1 ]; then
  BODY="Pre-release of RustDesk Admin $TAG. Not for production use unless you know what you are doing."
else
  BODY="RustDesk Admin $TAG — see the repository README for install and update instructions."
fi
RELEASE_JSON=$(curl -sS -f \
  -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$REPO/releases" \
  -d "$(python3 -c '
import json, sys
print(json.dumps({
  "tag_name": sys.argv[1],
  "name": sys.argv[1],
  "body": sys.argv[2],
  "draft": False,
  "prerelease": sys.argv[3] == "1",
}))
' "$TAG" "$BODY" "$PRE_RELEASE")")
RELEASE_ID=$(printf '%s' "$RELEASE_JSON" | python3 -c 'import json, sys; print(json.load(sys.stdin)["id"])')
echo "release id: $RELEASE_ID"

echo "==> uploading assets"
upload() {
  local file="$1"
  local ctype="$2"
  local name
  name=$(basename "$file")
  curl -sS -f \
    -X POST \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "Content-Type: $ctype" \
    --data-binary "@$file" \
    "https://uploads.github.com/repos/$REPO/releases/$RELEASE_ID/assets?name=$name" >/dev/null
  echo "uploaded $name"
}
upload ".release/rustdesk-admin-$TAG.tar.gz" "application/gzip"
upload ".release/SHA256SUMS" "text/plain"

echo
echo "release ready: https://github.com/$REPO/releases/tag/$TAG (id $RELEASE_ID)"