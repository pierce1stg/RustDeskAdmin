package update

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

const (
	imageRepo  = "rustdesk/rustdesk-server"
	hubTagsURL = "https://hub.docker.com/v2/repositories/rustdesk/rustdesk-server/tags?page_size=100"
)

var versionTagRe = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)

// Component identifies which server binary a request targets.
type Component string

const (
	ComponentHbbs Component = "hbbs"
	ComponentHbbr Component = "hbbr"
)

type componentInfo struct {
	component   Component
	container   string
	presenceKey string
}

var components = []componentInfo{
	{component: ComponentHbbs, container: "rustdesk-hbbs", presenceKey: "hbbs_version"},
	{component: ComponentHbbr, container: "rustdesk-hbbr", presenceKey: "hbbr_version"},
}

func componentInfoFor(comp Component) (componentInfo, bool) {
	for _, c := range components {
		if c.component == comp {
			return c, true
		}
	}
	return componentInfo{}, false
}

type CheckedComponent struct {
	Component       Component `json:"component"`
	CurrentVersion  string    `json:"current"`
	LatestVersion   string    `json:"latest"`
	UpdateAvailable bool      `json:"update_available"`
	Unknown         bool      `json:"unknown,omitempty"`
}

type CheckResponse struct {
	CheckedAt  time.Time          `json:"checked_at"`
	Source     string             `json:"source"`
	Components []CheckedComponent `json:"components"`
}

// Updater checks for and applies hbbs/hbbr updates through the Docker engine.
type Updater struct {
	presencePath string
	cli          *dockerClient
	allowed      bool
	logger       *zap.Logger

	mu        sync.Mutex
	tagsCache []string
	tagsAt    time.Time
}

func NewUpdater(presencePath string, allowed bool, logger *zap.Logger) *Updater {
	return &Updater{
		presencePath: presencePath,
		cli:          newDockerClient("/var/run/docker.sock", ""),
		allowed:      allowed,
		logger:       logger,
	}
}

func (u *Updater) currentVersion(c componentInfo) string {
	if u.presencePath == "" {
		return ""
	}
	data, err := os.ReadFile(u.presencePath)
	if err != nil {
		return ""
	}
	var m map[string]interface{}
	if err := json.Unmarshal(data, &m); err != nil {
		return ""
	}
	v, _ := m[c.presenceKey].(string)
	return strings.TrimSpace(v)
}

func parseSemver(s string) []int {
	parts := strings.Split(s, ".")
	out := make([]int, 0, len(parts))
	for _, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			return nil
		}
		out = append(out, n)
	}
	return out
}

func greaterSemver(a, b string) bool {
	av, bv := parseSemver(a), parseSemver(b)
	if av == nil || bv == nil {
		return false
	}
	for i := 0; i < len(av) && i < len(bv); i++ {
		if av[i] != bv[i] {
			return av[i] > bv[i]
		}
	}
	return len(av) > len(bv)
}

// latestTag returns the newest stable semver tag published for the OSS image,
// cached for an hour so the status endpoint does not hammer Docker Hub.
func (u *Updater) latestTag(ctx context.Context) (string, error) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if len(u.tagsCache) > 0 && time.Since(u.tagsAt) < time.Hour {
		return u.tagsCache[0], nil
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, hubTagsURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "rustdesk-admin-updater")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("docker hub returned status %d", resp.StatusCode)
	}
	var body struct {
		Results []struct {
			Name string `json:"name"`
		} `json:"results"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", err
	}
	latest := ""
	for _, r := range body.Results {
		if versionTagRe.MatchString(r.Name) && (latest == "" || greaterSemver(r.Name, latest)) {
			latest = r.Name
		}
	}
	if latest != "" {
		u.tagsCache = []string{latest}
		u.tagsAt = time.Now()
	}
	if latest == "" {
		return "", fmt.Errorf("no stable version tags found for %s", imageRepo)
	}
	return latest, nil
}

func (u *Updater) Check(ctx context.Context) CheckResponse {
	latest, err := u.latestTag(ctx)
	if err != nil {
		u.logger.Warn("Failed to resolve latest server version", zap.Error(err))
		latest = ""
	}
	resp := CheckResponse{CheckedAt: time.Now(), Source: "Docker Hub (" + imageRepo + ")"}
	for _, c := range components {
		cur := u.currentVersion(c)
		item := CheckedComponent{
			Component:      c.component,
			CurrentVersion: cur,
			LatestVersion:  latest,
			Unknown:        cur == "",
		}
		if latest != "" && cur != "" && greaterSemver(latest, cur) {
			item.UpdateAvailable = true
		}
		resp.Components = append(resp.Components, item)
	}
	return resp
}

// Apply upgrades a component to the newest published version, cloning the
// container's current configuration. On any failure it rolls back to the
// previous image and container definition.
func (u *Updater) Apply(comp Component) (map[string]interface{}, error) {
	info, ok := componentInfoFor(comp)
	if !ok {
		return nil, fmt.Errorf("unknown component %q", comp)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
	defer cancel()

	cur := u.currentVersion(info)
	latest, err := u.latestTag(ctx)
	if err != nil {
		return nil, err
	}
	if cur != "" && !greaterSemver(latest, cur) {
		return nil, fmt.Errorf("%s already runs the latest version %s", info.component, cur)
	}
	if cur == "" {
		u.logger.Warn("Current version unknown, proceeding with upgrade anyway",
			zap.String("component", string(info.component)))
	}

	insp, err := u.cli.inspectContainer(ctx, info.container)
	if err != nil {
		return nil, fmt.Errorf("failed to read config for %s: %w", info.container, err)
	}

	cfg, ok := insp["Config"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("container %s returned an invalid config", info.container)
	}
	oldImage, _ := cfg["Image"].(string)

	newImage := imageRepo + ":" + latest
	newSpec, err := buildSpec(insp, newImage)
	if err != nil {
		return nil, err
	}
	oldSpec, err := buildSpec(insp, oldImage)
	if err != nil {
		return nil, err
	}

	u.logger.Info("Pulling new server image", zap.String("image", newImage))
	if err := u.cli.pullImage(ctx, imageRepo, latest); err != nil {
		return nil, fmt.Errorf("failed to pull image %s: %w", newImage, err)
	}

	u.logger.Info("Restarting server container", zap.String("container", info.container))
	if err := u.cli.stopContainer(ctx, info.container); err != nil {
		u.logger.Warn("stop failed (container may already be stopped)", zap.Error(err))
	}
	if err := u.cli.removeContainer(ctx, info.container); err != nil {
		return nil, fmt.Errorf("failed to remove old %s: %w", info.container, err)
	}

	rollback := func(reason error) error {
		u.logger.Warn("Upgrade failed, rolling back", zap.Error(reason))
		id, err := u.cli.createContainer(ctx, info.container, oldSpec)
		if err != nil {
			return fmt.Errorf("%v; rollback failed: %w", reason, err)
		}
		if err := u.cli.startContainer(ctx, id); err != nil {
			return fmt.Errorf("%v; rollback failed (start): %w", reason, err)
		}
		return fmt.Errorf("%v; rolled back to %s", reason, oldImage)
	}

	if _, err := u.cli.createContainer(ctx, info.container, newSpec); err != nil {
		return nil, rollback(err)
	}
	if err := u.cli.startContainer(ctx, info.container); err != nil {
		return nil, rollback(err)
	}

	result := map[string]interface{}{
		"component":  string(info.component),
		"container":  info.container,
		"previous":   oldImage,
		"now":        newImage,
		"applied_at": time.Now(),
	}
	u.logger.Info("Server updated", zap.String("container", info.container), zap.String("image", newImage))
	return result, nil
}

func cloneMap(m map[string]interface{}) (map[string]interface{}, error) {
	raw, err := json.Marshal(m)
	if err != nil {
		return nil, err
	}
	var out map[string]interface{}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// buildSpec turns the JSON of a running container into a create request that
// replicates its configuration while swapping the image to img (repo:tag).
func buildSpec(insp map[string]interface{}, img string) (map[string]interface{}, error) {
	cfgRaw, ok := insp["Config"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("container inspect is missing Config")
	}
	hcRaw, ok := insp["HostConfig"].(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("container inspect is missing HostConfig")
	}
	cfg, err := cloneMap(cfgRaw)
	if err != nil {
		return nil, err
	}
	hc, err := cloneMap(hcRaw)
	if err != nil {
		return nil, err
	}
	cfg["Image"] = img

	// Rebuild bind mounts from the resolved Mounts list (Source/Destination/RW).
	mounts, _ := insp["Mounts"].([]interface{})
	var binds []string
	for _, it := range mounts {
		m, _ := it.(map[string]interface{})
		if m == nil {
			continue
		}
		typ, _ := m["Type"].(string)
		dst, _ := m["Destination"].(string)
		if dst == "" {
			continue
		}
		var src string
		if typ == "volume" {
			src, _ = m["Name"].(string)
		} else {
			src, _ = m["Source"].(string)
		}
		if src == "" {
			continue
		}
		line := src + ":" + dst
		if rw, ok := m["RW"].(bool); ok && !rw {
			line += ":ro"
		}
		binds = append(binds, line)
	}
	hc["Binds"] = binds
	hc["Mounts"] = nil

	// Network: keep host networking as-is, otherwise attach to the same
	// user-defined networks by name (compose containers store the network ID
	// in NetworkMode, which is not portable to a fresh container).
	ns, _ := insp["NetworkSettings"].(map[string]interface{})
	networks, _ := ns["Networks"].(map[string]interface{})
	netMode, _ := hc["NetworkMode"].(string)
	hostMode := netMode == "host" || strings.HasPrefix(netMode, "container:")
	if hostMode {
		hc["NetworkMode"] = netMode
	} else {
		hc["NetworkMode"] = ""
	}

	endpoints := map[string]interface{}{}
	for name := range networks {
		if hostMode {
			break
		}
		endpoints[name] = map[string]interface{}{}
	}
	// Docker's ContainerCreate body takes the container config fields at the
	// top level (there is no "Config" wrapper besides HostConfig/NetworkingConfig).
	spec := map[string]interface{}{}
	for k, v := range cfg {
		spec[k] = v
	}
	spec["HostConfig"] = hc
	if len(endpoints) > 0 {
		spec["NetworkingConfig"] = map[string]interface{}{"EndpointsConfig": endpoints}
	}
	return spec, nil
}

func (u *Updater) HandleCheck(c *gin.Context) {
	c.JSON(200, u.Check(c.Request.Context()))
}

func (u *Updater) HandleApply(c *gin.Context) {
	if !u.allowed {
		c.JSON(403, gin.H{"error": "server updates are disabled (ALLOW_SERVER_UPDATE=false)"})
		return
	}
	var req struct {
		Component Component `json:"component"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Component == "" {
		c.JSON(400, gin.H{"error": "component (hbbs|hbbr) is required"})
		return
	}
	if _, ok := componentInfoFor(req.Component); !ok {
		c.JSON(400, gin.H{"error": "unknown component; expected hbbs or hbbr"})
		return
	}
	result, err := u.Apply(req.Component)
	if err != nil {
		u.logger.Warn("Server update failed", zap.String("component", string(req.Component)), zap.Error(err))
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, result)
}
