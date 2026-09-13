package update

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"rustdesk-admin/internal/appversion"
)

const (
	panelRepo            = "pierce1stg/RustDeskAdmin"
	panelLatestRelease   = "https://api.github.com/repos/" + panelRepo + "/releases/latest"
	panelReleaseDownload = "https://github.com/" + panelRepo + "/releases/download"

	panelBackendContainer  = "rustdesk-admin-backend"
	panelPresenceContainer = "rustdesk-stack-presence"
	panelRunnerName        = "rustdesk-panel-update"
	panelLabelWorkingDir   = "com.docker.compose.project.working_dir"
	panelStatusFilename    = "panel-update.json"
)

var panelTagRe = regexp.MustCompile(`^v([0-9]+\.[0-9]+\.[0-9]+)$`)

type githubRelease struct {
	TagName string `json:"tag_name"`
}

type PanelCheckResponse struct {
	CheckedAt       time.Time `json:"checked_at"`
	Source          string    `json:"source"`
	Current         string    `json:"current"`
	Latest          string    `json:"latest,omitempty"`
	UpdateAvailable bool      `json:"update_available"`
	Enabled         bool      `json:"enabled"`
	AssetURL        string    `json:"asset_url,omitempty"`
}

type PanelStatusResponse struct {
	Phase      string `json:"phase"`
	Current    string `json:"current,omitempty"`
	Latest     string `json:"latest,omitempty"`
	StartedAt  string `json:"started_at,omitempty"`
	FinishedAt string `json:"finished_at,omitempty"`
	Error      string `json:"error,omitempty"`
}

// PanelUpdater self-updates the panel: it resolves the newest GitHub release,
// verifies the bundle checksum and runs the apply pipeline inside a throwaway
// container started from the current presence image (which already ships bash,
// docker-cli and python3). Full control stays with the runner, so the backend
// only ever needs read access to the shared status directory.
type PanelUpdater struct {
	cli       *dockerClient
	statusDir string
	allowed   bool
	logger    *zap.Logger

	mu     sync.Mutex
	active bool
}

func NewPanelUpdater(presencePath string, allowed bool, logger *zap.Logger) *PanelUpdater {
	statusDir := "/var/run/rustdesk"
	if presencePath != "" {
		statusDir = filepath.Dir(presencePath)
	}
	return &PanelUpdater{
		cli:       newDockerClient("/var/run/docker.sock", ""),
		statusDir: statusDir,
		allowed:   allowed,
		logger:    logger,
	}
}

func (p *PanelUpdater) Check(ctx context.Context) PanelCheckResponse {
	resp := PanelCheckResponse{
		CheckedAt: time.Now(),
		Source:    "GitHub (" + panelRepo + ")",
		Current:   appversion.Version,
		Enabled:   p.allowed,
	}
	latest, bundleURL, _, err := p.latestReleaseURLs(ctx)
	if err != nil {
		p.logger.Warn("Failed to resolve latest panel release", zap.Error(err))
		return resp
	}
	resp.Latest = latest
	resp.AssetURL = bundleURL
	resp.UpdateAvailable = greaterSemver(latest, appversion.Version)
	return resp
}

// latestReleaseURLs returns the newest stable tag (as "1.2.3" without the "v")
// together with the download URLs of its bundle and checksum assets.
func (p *PanelUpdater) latestReleaseURLs(ctx context.Context) (string, string, string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, panelLatestRelease, nil)
	if err != nil {
		return "", "", "", err
	}
	req.Header.Set("User-Agent", "rustdesk-admin-updater")
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return "", "", "", fmt.Errorf("github returned status %d: %s", resp.StatusCode, string(body))
	}
	var rel githubRelease
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return "", "", "", err
	}
	m := panelTagRe.FindStringSubmatch(rel.TagName)
	if m == nil {
		return "", "", "", fmt.Errorf("latest release tag %q is not a semver", rel.TagName)
	}
	bundleName := fmt.Sprintf("rustdesk-admin-%s.tar.gz", rel.TagName)
	base := panelReleaseDownload + "/" + rel.TagName
	return m[1], base + "/" + bundleName, base + "/SHA256SUMS", nil
}

// Status returns the persisted apply state (idle when no update ran yet).
func (p *PanelUpdater) Status() PanelStatusResponse {
	out := PanelStatusResponse{Phase: "idle", Current: appversion.Version}
	data, err := os.ReadFile(filepath.Join(p.statusDir, panelStatusFilename))
	if err != nil {
		return out
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return out
	}
	out.Current = appversion.Version
	return out
}

// Apply resolves the newest release and launches the update runner. Work is
// performed asynchronously by the runner container; the phases are reported
// through the shared status file on disk.
func (p *PanelUpdater) Apply() (map[string]interface{}, error) {
	if !p.allowed {
		return nil, fmt.Errorf("panel updates are disabled (ALLOW_PANEL_UPDATE=false)")
	}
	p.mu.Lock()
	if p.active {
		p.mu.Unlock()
		return nil, fmt.Errorf("a panel update is already running")
	}
	p.active = true
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		p.active = false
		p.mu.Unlock()
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	// A runner may still be executing from a previously accepted apply (for
	// example when the process restarted in between). Refuse to start another.
	if _, err := p.cli.inspectContainer(ctx, panelRunnerName); err == nil {
		return nil, fmt.Errorf("an update job is still running (container %s exists)", panelRunnerName)
	}

	latest, bundleURL, sumsURL, err := p.latestReleaseURLs(ctx)
	if err != nil {
		return nil, err
	}
	if !greaterSemver(latest, appversion.Version) {
		return nil, fmt.Errorf("panel already runs the latest version %s", appversion.Version)
	}

	repoRoot, err := p.repoRoot(ctx)
	if err != nil {
		return nil, err
	}
	runnerImage, err := p.runnerImage(ctx)
	if err != nil {
		return nil, err
	}

	spec := map[string]interface{}{
		"Image":      runnerImage,
		"Entrypoint": []string{"bash", "-lc", "eval \"$PANEL_UPDATE_SCRIPT\""},
		"Cmd":        []string{},
		// The repo is mounted at its real host path and used as the working
		// directory so that `docker compose` inside the runner resolves
		// ./data, ./status etc. against exactly the host paths the stack uses,
		// and setup.sh re-creates the real stack rather than a shadow copy.
		"WorkingDir": repoRoot,
		"Env": []string{
			"PANEL_UPDATE_SCRIPT=" + panelApplyScript,
			"PANEL_UPDATE_TAG=v" + latest,
			"PANEL_UPDATE_ASSET_URL=" + bundleURL,
			"PANEL_UPDATE_SHA256_URL=" + sumsURL,
			"PANEL_UPDATE_ROOT=" + repoRoot,
			"PANEL_UPDATE_STATUS=" + filepath.Join(repoRoot, "status", panelStatusFilename),
		},
		"HostConfig": map[string]interface{}{
			"Binds": []string{
				repoRoot + ":" + repoRoot + ":rw",
				"/var/run/docker.sock:/var/run/docker.sock:rw",
			},
			"NetworkMode": "host",
			"AutoRemove":  true,
		},
	}
	if _, err := p.cli.createContainer(ctx, panelRunnerName, spec); err != nil {
		return nil, fmt.Errorf("failed to create update runner: %w", err)
	}
	if err := p.cli.startContainer(ctx, panelRunnerName); err != nil {
		return nil, fmt.Errorf("failed to launch update runner: %w", err)
	}
	p.logger.Info("Panel update accepted",
		zap.String("target", latest),
		zap.String("container", panelRunnerName))
	return map[string]interface{}{
		"status":      "accepted",
		"target":      latest,
		"container":   panelRunnerName,
		"accepted_at": time.Now(),
	}, nil
}

// repoRoot resolves the compose project working directory from the backend
// container's labels, which is exactly the host path of the checkout.
func (p *PanelUpdater) repoRoot(ctx context.Context) (string, error) {
	insp, err := p.cli.inspectContainer(ctx, panelBackendContainer)
	if err != nil {
		return "", fmt.Errorf("cannot inspect backend container: %w", err)
	}
	cfg, _ := insp["Config"].(map[string]interface{})
	labels, _ := cfg["Labels"].(map[string]interface{})
	root, _ := labels[panelLabelWorkingDir].(string)
	root = strings.TrimSpace(root)
	if root == "" || !strings.HasPrefix(root, "/") {
		return "", fmt.Errorf("backend container has no %s label (not started by docker compose?)", panelLabelWorkingDir)
	}
	return root, nil
}

// runnerImage returns the image currently used by the presence container. The
// runner is started from the *current* (old) image so the apply script always
// ships with the code that is actually running.
func (p *PanelUpdater) runnerImage(ctx context.Context) (string, error) {
	insp, err := p.cli.inspectContainer(ctx, panelPresenceContainer)
	if err != nil {
		return "", fmt.Errorf("cannot inspect presence container: %w", err)
	}
	cfg, _ := insp["Config"].(map[string]interface{})
	img, _ := cfg["Image"].(string)
	if img == "" {
		return "", fmt.Errorf("presence container has no image")
	}
	return img, nil
}

func (p *PanelUpdater) HandleCheck(c *gin.Context) {
	c.JSON(200, p.Check(c.Request.Context()))
}

func (p *PanelUpdater) HandleStatus(c *gin.Context) {
	c.JSON(200, p.Status())
}

func (p *PanelUpdater) HandleApply(c *gin.Context) {
	if !p.allowed {
		c.JSON(403, gin.H{"error": "panel updates are disabled (ALLOW_PANEL_UPDATE=false)"})
		return
	}
	result, err := p.Apply()
	if err != nil {
		p.logger.Warn("Panel update failed", zap.Error(err))
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(202, result)
}

// panelApplyScript is injected into the runner as PANEL_UPDATE_SCRIPT. It is
// intentionally self-contained: download, checksum verification, backup of the
// current tree, extraction, rebuild via setup.sh, health probe, and rollback.
//
// Runtime state is written to $PANEL_UPDATE_STATUS (the shared status file in
// ./status) and every exit through failure first restores the previous tree.
var panelApplyScript = `set -e

APP_ROOT="${PANEL_UPDATE_ROOT:-/workspace}"
STATUS_FILE="${PANEL_UPDATE_STATUS:-$APP_ROOT/status/panel-update.json}"
TAG="${PANEL_UPDATE_TAG:?}"
ASSET_URL="${PANEL_UPDATE_ASSET_URL:?}"
SHA256_URL="${PANEL_UPDATE_SHA256_URL:?}"

BUNDLE=/tmp/panel-update-bundle.tar.gz
SUMS=/tmp/panel-update-SHA256SUMS
BACKUP_DIR="$APP_ROOT/data/.panel-update-backups"
PREV_MARKER="$BACKUP_DIR/pre-$TAG.tar.gz"

EXCLUDES=(--exclude=./.env --exclude=./.env.example --exclude=./data --exclude=./status --exclude=./.git)

state() {
  phase="$1"
  err="${2:-}"
  mkdir -p "$(dirname "$STATUS_FILE")"
  python3 - "$STATUS_FILE" "$TAG" "$phase" "$err" <<'PY'
import json
import sys
path, tag, phase, err = sys.argv[1:5]
d = {"phase": phase, "latest": tag}
if err:
    d["error"] = err
with open(path, "w") as f:
    json.dump(d, f)
PY
}

fail() {
  msg="$1"
  echo "PANEL UPDATE ERROR: $msg"
  if [ -f "$PREV_MARKER" ]; then
    echo "rolling back to previous tree"
    state rollback "$msg"
    tar xzf "$PREV_MARKER" -C "$APP_ROOT"
    if bash "$APP_ROOT/setup.sh"; then
      state rolled_back "$msg"
    else
      state error "$msg; rollback rebuild failed, manual recovery required"
    fi
  else
    state error "$msg"
  fi
  exit 1
}

echo "panel update started for tag $TAG"
state verifying

# setup.sh relies on the docker compose command, which may be absent from
# the base image the runner uses. Install it (Alpine) if missing so the
# build step can run. Failure here aborts before any tree modification.
if ! docker compose version >/dev/null 2>&1; then
  echo "installing docker compose plugin"
  apk add --no-cache docker-compose || fail "could not install docker compose"
fi

mkdir -p "$BACKUP_DIR"
echo "backing up current tree"
tar czf "$PREV_MARKER" -C "$APP_ROOT" --exclude=./.env --exclude=./data --exclude=./status --exclude=./.git .
state backup

echo "downloading $ASSET_URL"
python3 - "$ASSET_URL" "$BUNDLE" <<'PY'
import sys
import urllib.request
url, out = sys.argv[1], sys.argv[2]
req = urllib.request.Request(url, headers={"User-Agent": "rustdesk-admin-updater"})
with urllib.request.urlopen(req, timeout=180) as r, open(out, "wb") as f:
    while True:
        chunk = r.read(65536)
        if not chunk:
            break
        f.write(chunk)
PY

echo "downloading $SHA256_URL"
python3 - "$SHA256_URL" "$SUMS" <<'PY'
import sys
import urllib.request
url, out = sys.argv[1], sys.argv[2]
req = urllib.request.Request(url, headers={"User-Agent": "rustdesk-admin-updater"})
with urllib.request.urlopen(req, timeout=60) as r, open(out, "wb") as f:
    f.write(r.read())
PY

EXPECTED=$(python3 - "$SUMS" "$TAG" <<'PY'
import sys
sums_path, tag = sys.argv[1], sys.argv[2]
wanted = "rustdesk-admin-%s.tar.gz" % tag
with open(sums_path) as f:
    for line in f:
        parts = line.split()
        if len(parts) == 2 and parts[1] == wanted:
            print(parts[0])
            break
PY
)
if [ -z "$EXPECTED" ]; then
  fail "no checksum entry for $TAG in SHA256SUMS"
fi

ACTUAL=$(python3 - "$BUNDLE" <<'PY'
import hashlib
import sys
h = hashlib.sha256()
with open(sys.argv[1], "rb") as f:
    for chunk in iter(lambda: f.read(65536), b""):
        h.update(chunk)
print(h.hexdigest())
PY
)
if [ "$ACTUAL" != "$EXPECTED" ]; then
  fail "SHA-256 mismatch (expected $EXPECTED, got $ACTUAL)"
fi
echo "checksum ok"

state extracting
tar xzf "$BUNDLE" -C "$APP_ROOT" "${EXCLUDES[@]}"
state building

echo "running setup.sh"
if ! bash "$APP_ROOT/setup.sh"; then
  fail "setup.sh exited with code $? after extraction"
fi

echo "waiting for health"
state health
ok=""
i=0
while [ "$i" -lt 40 ]; do
  if python3 - <<'PY'
import urllib.request
urllib.request.urlopen("http://localhost/__health", timeout=3)
PY
  then
    ok=1
    break
  fi
  sleep 3
  i=$((i + 1))
done
if [ -z "$ok" ]; then
  fail "health check did not pass after upgrade"
fi

state ok
echo "panel update finished successfully for tag $TAG"
`
