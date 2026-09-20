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
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
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
	panelLogFilename       = "panel-update.log"
	// Backups live outside the (read-only) status bind: a dedicated mount
	// ./data/.panel-update-backups -> /backups (see docker-compose.yml).
	panelBackupsDir = "/backups"
)

// backupNameRe allows only our own backup filenames (no paths, no traversal,
// no surprises): pre-vX.Y.Z.tar.gz, plus manual snapshots taken from the UI
// (pre-vX.Y.Z-manual-<unixts>.tar.gz).
var backupNameRe = regexp.MustCompile(`^pre-v[0-9]+\.[0-9]+\.[0-9]+(-manual-[0-9]+)?\.tar\.gz$`)

type PanelBackup struct {
	Name      string    `json:"name"`
	SizeBytes int64     `json:"size_bytes"`
	CreatedAt time.Time `json:"created_at"`
}

// backupsDir is the backups volume. Unlike the status file it cannot derive
// from statusDir (nesting a bind under the read-only status mount fails at
// container create time), hence the dedicated constant + compose mount.
// Tests override it via backupsDirOverride.
func (p *PanelUpdater) backupsDir() string {
	if p.backupsDirOverride != "" {
		return p.backupsDirOverride
	}
	return panelBackupsDir
}

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
	// backupsDirOverride reroutes backup storage in tests (production always
	// uses the /backups volume). Empty means the default.
	backupsDirOverride string

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
	if p.runnerRunning(ctx) {
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

// runnerRunning reports whether an update runner container exists right now
// (running or not yet reaped). While it exists, reset/refuse paths stay locked.
func (p *PanelUpdater) runnerRunning(ctx context.Context) bool {
	_, err := p.cli.inspectContainer(ctx, panelRunnerName)
	return err == nil
}

// HandleLog tails the runner progress log (written by the apply script via
// tee). Missing file (no run yet) is an empty list, not an error.
func (p *PanelUpdater) HandleLog(c *gin.Context) {
	n := 200
	if q := c.Query("tail"); q != "" {
		if v, err := strconv.Atoi(q); err == nil && v > 0 {
			n = v
		}
	}
	if n > 500 {
		n = 500
	}
	data, err := os.ReadFile(filepath.Join(p.statusDir, panelLogFilename))
	if err != nil {
		c.JSON(200, gin.H{"lines": []string{}})
		return
	}
	text := strings.TrimRight(string(data), "\n")
	if text == "" {
		c.JSON(200, gin.H{"lines": []string{}})
		return
	}
	c.JSON(200, gin.H{"lines": tailLines(strings.Split(text, "\n"), n)})
}

// tailLines returns the last n lines (n<=0 means none). Pure for tests.
func tailLines(lines []string, n int) []string {
	if n <= 0 || len(lines) == 0 {
		return []string{}
	}
	if len(lines) > n {
		return lines[len(lines)-n:]
	}
	return lines
}

// backupVersion derives the release tag (vX.Y.Z) from a validated backup
// name (pre-vX.Y.Z.tar.gz, manual suffix stripped). ok=false unless the full
// name matches.
func backupVersion(name string) (version string, ok bool) {
	if !backupNameRe.MatchString(name) {
		return "", false
	}
	v := strings.TrimSuffix(strings.TrimPrefix(name, "pre-"), ".tar.gz")
	if i := strings.Index(v, "-manual-"); i >= 0 {
		v = v[:i]
	}
	return v, true
}

// manualBackupName builds the server-side snapshot filename for the running
// version. Timestamped so repeated clicks never collide; the name always
// satisfies backupNameRe (no user input reaches the filesystem).
func manualBackupName(version string, unixTs int64) string {
	return fmt.Sprintf("pre-v%s-manual-%d.tar.gz", strings.TrimPrefix(version, "v"), unixTs)
}

// HandleBackups lists update backup trees (newest first). Missing dir (never
// updated) is an empty list, not an error.
func (p *PanelUpdater) HandleBackups(c *gin.Context) {
	entries, err := os.ReadDir(p.backupsDir())
	if err != nil {
		c.JSON(200, gin.H{"backups": []PanelBackup{}})
		return
	}
	out := []PanelBackup{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".tar.gz") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, PanelBackup{Name: e.Name(), SizeBytes: info.Size(), CreatedAt: info.ModTime()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	c.JSON(200, gin.H{"backups": out})
}

// HandleDeleteBackup removes one backup by exact name. Refused while a runner
// exists (it might be mid-rollback to exactly this file).
func (p *PanelUpdater) HandleDeleteBackup(c *gin.Context) {
	if !p.allowed {
		c.JSON(403, gin.H{"error": "panel updates are disabled (ALLOW_PANEL_UPDATE=false)"})
		return
	}
	name := c.Param("name")
	if !backupNameRe.MatchString(name) {
		c.JSON(400, gin.H{"error": "unknown backup"})
		return
	}
	if p.runnerRunning(c.Request.Context()) {
		c.JSON(409, gin.H{"error": "an update job is still running"})
		return
	}
	if err := os.Remove(filepath.Join(p.backupsDir(), name)); err != nil {
		if os.IsNotExist(err) {
			c.JSON(404, gin.H{"error": "unknown backup"})
			return
		}
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"status": "deleted"})
}

// CreateBackup snapshots the running tree through a throwaway runner (same
// pattern as Rollback: repo bind, shared log, async). The filename is built
// server-side (running version + unix time, no user input) and always
// satisfies backupNameRe, so the copy can be rolled back to and deleted like
// any automatic one. Refused while another runner exists.
func (p *PanelUpdater) CreateBackup() (map[string]interface{}, error) {
	if !p.allowed {
		return nil, fmt.Errorf("panel updates are disabled (ALLOW_PANEL_UPDATE=false)")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	if p.runnerRunning(ctx) {
		return nil, fmt.Errorf("an update job is still running (container %s exists)", panelRunnerName)
	}

	repoRoot, err := p.repoRoot(ctx)
	if err != nil {
		return nil, err
	}
	runnerImage, err := p.runnerImage(ctx)
	if err != nil {
		return nil, err
	}
	name := manualBackupName(appversion.Version, time.Now().Unix())

	spec := map[string]interface{}{
		"Image":      runnerImage,
		"Entrypoint": []string{"bash", "-lc", "eval \"$PANEL_BACKUP_SCRIPT\""},
		"Cmd":        []string{},
		"WorkingDir": repoRoot,
		"Env": []string{
			"PANEL_BACKUP_SCRIPT=" + panelBackupScript,
			"PANEL_BACKUP_NAME=" + name,
			"PANEL_UPDATE_ROOT=" + repoRoot,
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
		return nil, fmt.Errorf("failed to create backup runner: %w", err)
	}
	if err := p.cli.startContainer(ctx, panelRunnerName); err != nil {
		return nil, fmt.Errorf("failed to launch backup runner: %w", err)
	}
	p.logger.Info("Panel backup accepted",
		zap.String("backup", name),
		zap.String("container", panelRunnerName))
	return map[string]interface{}{
		"status":      "accepted",
		"backup":      name,
		"container":   panelRunnerName,
		"accepted_at": time.Now(),
	}, nil
}

func (p *PanelUpdater) HandleCreateBackup(c *gin.Context) {
	result, err := p.CreateBackup()
	if err != nil {
		p.logger.Warn("Panel backup failed", zap.Error(err))
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(202, result)
}

// HandleReset clears a stuck update state (frozen phase with no runner, e.g.
// a runner killed before writing its terminal state). Refused while a runner
// container exists — resetting mid-run would desync the UI from reality.
func (p *PanelUpdater) HandleReset(c *gin.Context) {
	if !p.allowed {
		c.JSON(403, gin.H{"error": "panel updates are disabled (ALLOW_PANEL_UPDATE=false)"})
		return
	}
	if p.runnerRunning(c.Request.Context()) {
		c.JSON(409, gin.H{"error": "an update job is still running"})
		return
	}
	// Removal errors used to be discarded, which made reset silently do
	// nothing (e.g. while the status bind was mounted read-only). Report.
	statusPath := filepath.Join(p.statusDir, panelStatusFilename)
	logPath := filepath.Join(p.statusDir, panelLogFilename)
	if err := os.Remove(statusPath); err != nil && !os.IsNotExist(err) {
		c.JSON(500, gin.H{"error": fmt.Sprintf("cannot clear update status: %v", err)})
		return
	}
	if err := os.Remove(logPath); err != nil && !os.IsNotExist(err) {
		c.JSON(500, gin.H{"error": fmt.Sprintf("cannot clear update log: %v", err)})
		return
	}
	c.JSON(200, gin.H{"status": "reset"})
}

// Rollback restores a chosen backup through a throwaway runner (same pattern
// as Apply: repo bind, shared status/log, async phases). The name is strictly
// validated here and re-checked by the script; the runner refuses a missing
// file before touching the tree.
func (p *PanelUpdater) Rollback(name string) (map[string]interface{}, error) {
	if !p.allowed {
		return nil, fmt.Errorf("panel updates are disabled (ALLOW_PANEL_UPDATE=false)")
	}
	version, ok := backupVersion(name)
	if !ok {
		return nil, fmt.Errorf("unknown backup")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	if p.runnerRunning(ctx) {
		return nil, fmt.Errorf("an update job is still running (container %s exists)", panelRunnerName)
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
		"Entrypoint": []string{"bash", "-lc", "eval \"$PANEL_ROLLBACK_SCRIPT\""},
		"Cmd":        []string{},
		"WorkingDir": repoRoot,
		"Env": []string{
			"PANEL_ROLLBACK_SCRIPT=" + panelRollbackScript,
			"PANEL_UPDATE_TAG=" + version,
			"PANEL_ROLLBACK_NAME=" + name,
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
		return nil, fmt.Errorf("failed to create rollback runner: %w", err)
	}
	if err := p.cli.startContainer(ctx, panelRunnerName); err != nil {
		return nil, fmt.Errorf("failed to launch rollback runner: %w", err)
	}
	p.logger.Info("Panel rollback accepted",
		zap.String("target", version),
		zap.String("backup", name),
		zap.String("container", panelRunnerName))
	return map[string]interface{}{
		"status":      "accepted",
		"target":      version,
		"backup":      name,
		"container":   panelRunnerName,
		"accepted_at": time.Now(),
	}, nil
}

func (p *PanelUpdater) HandleRollback(c *gin.Context) {
	var req struct {
		Name string `json:"name"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": "invalid request body"})
		return
	}
	result, err := p.Rollback(req.Name)
	if err != nil {
		p.logger.Warn("Panel rollback failed", zap.Error(err))
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(202, result)
}

type PanelPreflight struct {
	Tag            string `json:"tag"`
	AssetURL       string `json:"asset_url,omitempty"`
	AssetReachable bool   `json:"asset_reachable"`
	AssetBytes     int64  `json:"asset_bytes"`
	DiskFreeBytes  uint64 `json:"disk_free_bytes"`
	DiskOK         bool   `json:"disk_ok"`
	RunnerFree     bool   `json:"runner_free"`
}

// Preflight checks whether an update to tag can proceed: asset reachable,
// enough disk (bundle + extract + build workspace ≈ 3x bundle), no runner.
// Empty tag resolves the latest stable release first.
func (p *PanelUpdater) Preflight(tag string) PanelPreflight {
	out := PanelPreflight{Tag: tag}
	if tag == "" {
		latest, _, _, err := p.latestReleaseURLs(context.Background())
		if err != nil {
			return out
		}
		tag = "v" + latest
		out.Tag = tag
	}
	if m := panelTagRe.FindStringSubmatch(tag); m == nil {
		return out
	}
	out.AssetURL = panelReleaseDownload + "/" + tag + "/rustdesk-admin-" + tag + ".tar.gz"

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if req, err := http.NewRequestWithContext(ctx, http.MethodHead, out.AssetURL, nil); err == nil {
		req.Header.Set("User-Agent", "rustdesk-admin-updater")
		if resp, err := http.DefaultClient.Do(req); err == nil {
			out.AssetReachable = resp.StatusCode < 400
			out.AssetBytes = resp.ContentLength
			resp.Body.Close()
		}
	}
	var st syscall.Statfs_t
	if err := syscall.Statfs(p.statusDir, &st); err == nil && st.Bavail > 0 && st.Bsize > 0 {
		out.DiskFreeBytes = uint64(st.Bavail) * uint64(st.Bsize)
	}
	out.DiskOK = out.AssetReachable && out.AssetBytes > 0 &&
		out.DiskFreeBytes > uint64(out.AssetBytes)*3
	out.RunnerFree = !p.runnerRunning(ctx)
	return out
}

func (p *PanelUpdater) HandlePreflight(c *gin.Context) {
	c.JSON(200, p.Preflight(c.Query("tag")))
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

// panelRollbackScript restores a chosen backup from the UI. It mirrors the
// apply runner's conventions (log tee, ERR trap, state journal) but never
// downloads and never auto-restores: PREV_MARKER stays empty so fail() can
// only report, and the operator's explicit choice is the single source of
// truth for what gets restored.
var panelRollbackScript = `set -e

APP_ROOT="${PANEL_UPDATE_ROOT:-/workspace}"
STATUS_FILE="${PANEL_UPDATE_STATUS:-$APP_ROOT/status/panel-update.json}"
TAG="${PANEL_UPDATE_TAG:?}"
ROLLBACK_NAME="${PANEL_ROLLBACK_NAME:?}"

LOG_FILE="$APP_ROOT/status/panel-update.log"
mkdir -p "$(dirname "$STATUS_FILE")"
: > "$LOG_FILE" 2>/dev/null || true
exec > >(tee -a "$LOG_FILE") 2>&1 || true

TRAP_ON=1
on_err() {
  code="$1"
  line="$2"
  [ "$TRAP_ON" = "1" ] || exit "$code"
  TRAP_ON=0
  echo "PANEL ROLLBACK ERROR: unhandled failure at line $line (exit $code)"
  state error "unhandled failure at line $line (exit $code)"
  sleep 2
  exit "$code"
}
trap 'on_err $? $LINENO' ERR

BACKUP_DIR="$APP_ROOT/data/.panel-update-backups"

state() {
  phase="$1"
  err="${2:-}"
  mkdir -p "$(dirname "$STATUS_FILE")"
  python3 - "$STATUS_FILE" "$TAG" "$phase" "$err" <<'PY'
import json
import sys
import datetime
path, tag, phase, err = sys.argv[1:5]
try:
    with open(path) as f:
        d = json.load(f)
    if not isinstance(d, dict):
        d = {}
except Exception:
    d = {}
now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
d.update({"phase": phase, "latest": tag, "finished_at": now})
d.setdefault("started_at", now)
if err:
    d["error"] = err
else:
    d.pop("error", None)
with open(path, "w") as f:
    json.dump(d, f)
PY
}

fail() {
  code=$?
  [ "$code" = "0" ] && code=1
  msg="$1"
  TRAP_ON=0
  echo "PANEL ROLLBACK ERROR: $msg (exit $code)"
  state error "$msg (exit $code)"
  sleep 2
  exit "$code"
}

echo "panel rollback started to $ROLLBACK_NAME"
ROLLBACK_SRC="$BACKUP_DIR/$ROLLBACK_NAME"
[ -f "$ROLLBACK_SRC" ] || fail "backup $ROLLBACK_NAME not found"

# Same tooling gate as the apply runner (compose plugin + openssl for secret
# generation in setup.sh), before touching the tree.
if ! docker compose version >/dev/null 2>&1; then
  echo "installing docker compose plugin"
  apk add --no-cache docker-compose openssl || fail "could not install docker compose"
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "installing openssl"
  apk add --no-cache openssl || fail "could not install openssl"
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "installing curl"
  apk add --no-cache curl || fail "could not install curl"
fi

state rollback
tar xzf "$ROLLBACK_SRC" -C "$APP_ROOT" --exclude=./.env --exclude=./.env.example --exclude=./data --exclude=./status --exclude=./.git
state building

echo "running setup.sh"
if ! bash "$APP_ROOT/setup.sh"; then
  fail "setup.sh failed after restore (manual recovery required)"
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
  fail "health check did not pass after rollback"
fi

state rolled_back
echo "panel rollback finished to $ROLLBACK_NAME"
sleep 2
`

// panelApplyScript is injected into the runner as PANEL_UPDATE_SCRIPT. It is
// intentionally self-contained: download (with retries), checksum
// panelBackupScript snapshots the current tree into a timestamped manual
// backup. It only appends to the shared log and never touches
// panel-update.json, so a snapshot cannot clobber an update status; the UI
// learns the result by re-listing backups.
var panelBackupScript = `set -e

APP_ROOT="${PANEL_UPDATE_ROOT:-/workspace}"
BACKUP_NAME="${PANEL_BACKUP_NAME:?}"

BACKUP_DIR="$APP_ROOT/data/.panel-update-backups"
LOG_FILE="$APP_ROOT/status/panel-update.log"
mkdir -p "$BACKUP_DIR"

echo "creating manual backup $BACKUP_NAME" | tee -a "$LOG_FILE"
tar czf "$BACKUP_DIR/$BACKUP_NAME" -C "$APP_ROOT" --exclude=./.env --exclude=./data --exclude=./status --exclude=./.git . 2>&1 | tee -a "$LOG_FILE"
echo "backup $BACKUP_NAME finished ($(du -h "$BACKUP_DIR/$BACKUP_NAME" | cut -f1))" | tee -a "$LOG_FILE"
`

// verification, backup of the current tree, extraction, rebuild via setup.sh,
// health probe, and rollback.
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

LOG_FILE="$APP_ROOT/status/panel-update.log"
mkdir -p "$(dirname "$STATUS_FILE")"
: > "$LOG_FILE" 2>/dev/null || true
# Mirror everything below to the progress log the panel tails live.
exec > >(tee -a "$LOG_FILE") 2>&1 || true

# Any unhandled failure records state error instead of freezing the last
# phase forever (the "stuck on backup" class). Disabled inside fail().
TRAP_ON=1
on_err() {
  code="$1"
  line="$2"
  [ "$TRAP_ON" = "1" ] || exit "$code"
  TRAP_ON=0
  echo "PANEL UPDATE ERROR: unhandled failure at line $line (exit $code)"
  state error "unhandled failure at line $line (exit $code)"
  sleep 2
  exit "$code"
}
trap 'on_err $? $LINENO' ERR

state() {
  phase="$1"
  err="${2:-}"
  mkdir -p "$(dirname "$STATUS_FILE")"
  python3 - "$STATUS_FILE" "$TAG" "$phase" "$err" <<'PY'
import json
import sys
import datetime
path, tag, phase, err = sys.argv[1:5]
try:
    with open(path) as f:
        d = json.load(f)
    if not isinstance(d, dict):
        d = {}
except Exception:
    d = {}
now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
d.update({"phase": phase, "latest": tag, "finished_at": now})
d.setdefault("started_at", now)
if err:
    d["error"] = err
else:
    d.pop("error", None)
with open(path, "w") as f:
    json.dump(d, f)
PY
}

fail() {
  code=$?
  [ "$code" = "0" ] && code=1
  msg="$1"
  TRAP_ON=0
  echo "PANEL UPDATE ERROR: $msg (exit $code)"
  if [ -f "$PREV_MARKER" ]; then
    echo "rolling back to previous tree"
    state rollback "$msg (exit $code)"
    tar xzf "$PREV_MARKER" -C "$APP_ROOT"
    if bash "$APP_ROOT/setup.sh"; then
      state rolled_back "$msg (exit $code)"
    else
      state error "$msg (exit $code); rollback rebuild failed, manual recovery required"
    fi
  else
    state error "$msg (exit $code)"
  fi
  sleep 2
  exit "$code"
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
# setup.sh generates secrets with openssl when an old .env lacks newer keys
# (e.g. DEVICE_SECRET), and the runner image has none — ensure it always.
if ! command -v openssl >/dev/null 2>&1; then
  echo "installing openssl"
  apk add --no-cache openssl || fail "could not install openssl"
fi
# setup.sh needs curl for the nginx health gate before LE issuance.
if ! command -v curl >/dev/null 2>&1; then
  echo "installing curl"
  apk add --no-cache curl || fail "could not install curl"
fi

mkdir -p "$BACKUP_DIR"
echo "backing up current tree"
tar czf "$PREV_MARKER" -C "$APP_ROOT" --exclude=./.env --exclude=./data --exclude=./status --exclude=./.git .
state backup

# Download with retries: a single stalled transfer used to kill the whole run
# with no state update (frozen "backup"). Each attempt runs in an if
# condition so neither set -e nor the ERR trap fires mid-retry.
fetch() {
  url="$1"
  out="$2"
  attempts=0
  while [ "$attempts" -lt 3 ]; do
    attempts=$((attempts + 1))
    echo "downloading $url (attempt $attempts/3)"
    if python3 - "$url" "$out" <<'PY'
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
    then
      return 0
    fi
    echo "download attempt $attempts failed"
    sleep 10
  done
  return 1
}

fetch "$ASSET_URL" "$BUNDLE" || fail "bundle download failed after 3 attempts"
fetch "$SHA256_URL" "$SUMS" || fail "checksum download failed after 3 attempts"

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
  fail "setup.sh failed after extraction"
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
sleep 2
`
