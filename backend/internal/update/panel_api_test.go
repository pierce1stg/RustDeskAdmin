package update

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

func testUpdater(t *testing.T, statusDir, backupsDir string) *PanelUpdater {
	t.Helper()
	return &PanelUpdater{
		cli:                newDockerClient("", ""),
		statusDir:          statusDir,
		backupsDirOverride: backupsDir,
		allowed:            true,
		logger:             zap.NewNop(),
	}
}

func serve(p *PanelUpdater, method, target string, params gin.Params) (int, []byte) {
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(method, target, nil)
	c.Params = params
	switch {
	case method == "GET" && target == "/backups":
		p.HandleBackups(c)
	case method == "DELETE":
		p.HandleDeleteBackup(c)
	case method == "POST" && target == "/reset":
		p.HandleReset(c)
	case method == "GET" && len(target) >= 4 && target[:4] == "/log":
		p.HandleLog(c)
	}
	return w.Code, w.Body.Bytes()
}

func TestHandleBackups(t *testing.T) {
	// Missing dir (never updated) is an empty list, not an error.
	p := testUpdater(t, t.TempDir(), filepath.Join(t.TempDir(), "nope"))
	code, body := serve(p, "GET", "/backups", nil)
	if code != 200 {
		t.Fatalf("code=%d", code)
	}
	var out struct {
		Backups []PanelBackup `json:"backups"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Backups) != 0 {
		t.Fatalf("expected empty, got %v", out.Backups)
	}

	// Only *.tar.gz files listed, newest first; junk and dirs ignored.
	dir := t.TempDir()
	old := filepath.Join(dir, "pre-v0.9.0.tar.gz")
	fresh := filepath.Join(dir, "pre-v1.0.0.tar.gz")
	os.WriteFile(old, []byte("old"), 0o644)
	os.WriteFile(fresh, []byte("fresh"), 0o644)
	os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("x"), 0o644)
	os.Mkdir(filepath.Join(dir, "pre-v2.0.0.tar.gz"), 0o755)
	past := time.Now().Add(-time.Hour)
	os.Chtimes(old, past, past)
	p2 := testUpdater(t, t.TempDir(), dir)
	_, body = serve(p2, "GET", "/backups", nil)
	out = struct {
		Backups []PanelBackup `json:"backups"`
	}{}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Backups) != 2 || out.Backups[0].Name != "pre-v1.0.0.tar.gz" || out.Backups[1].Name != "pre-v0.9.0.tar.gz" {
		t.Fatalf("unexpected list: %+v", out.Backups)
	}
	if out.Backups[0].SizeBytes != 5 {
		t.Errorf("size not reported: %+v", out.Backups[0])
	}
}

func TestHandleDeleteBackup(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "pre-v1.0.0.tar.gz"), []byte("x"), 0o644)
	p := testUpdater(t, t.TempDir(), dir)

	for _, bad := range []string{"../x", "/abs/pre-v1.0.0.tar.gz", "nope", "pre-v1.0.tar.gz"} {
		code, _ := serve(p, "DELETE", "/backups", gin.Params{{Key: "name", Value: bad}})
		if code != 400 {
			t.Errorf("%q: code=%d, want 400", bad, code)
		}
	}
	if code, _ := serve(p, "DELETE", "/backups", gin.Params{{Key: "name", Value: "pre-v9.9.9.tar.gz"}}); code != 404 {
		t.Errorf("missing: code=%d, want 404", code)
	}
	if code, _ := serve(p, "DELETE", "/backups", gin.Params{{Key: "name", Value: "pre-v1.0.0.tar.gz"}}); code != 200 {
		t.Fatalf("delete: code=%d, want 200", code)
	}
	if _, err := os.Stat(filepath.Join(dir, "pre-v1.0.0.tar.gz")); !os.IsNotExist(err) {
		t.Error("file still on disk after delete")
	}
}

func TestHandleReset(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "panel-update.json"), []byte(`{"phase":"error"}`), 0o644)
	os.WriteFile(filepath.Join(dir, "panel-update.log"), []byte("boom\n"), 0o644)
	p := testUpdater(t, dir, t.TempDir())
	// No docker socket in tests: runner check fails open (not running).
	if code, _ := serve(p, "POST", "/reset", nil); code != 200 {
		t.Fatalf("code=%d, want 200", code)
	}
	for _, f := range []string{"panel-update.json", "panel-update.log"} {
		if _, err := os.Stat(filepath.Join(dir, f)); !os.IsNotExist(err) {
			t.Errorf("%s not removed", f)
		}
	}
}

func TestHandleLog(t *testing.T) {
	dir := t.TempDir()
	p := testUpdater(t, dir, t.TempDir())
	if code, body := serve(p, "GET", "/log", nil); code != 200 || string(body) != `{"lines":[]}` {
		t.Fatalf("missing log: code=%d body=%s", code, body)
	}
	lines := ""
	for i := 0; i < 10; i++ {
		lines += "line\n"
	}
	os.WriteFile(filepath.Join(dir, "panel-update.log"), []byte(lines), 0o644)
	_, body := serve(p, "GET", "/log?tail=3", nil)
	var out struct {
		Lines []string `json:"lines"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Lines) != 3 || out.Lines[2] != "line" {
		t.Fatalf("tail wrong: %v", out.Lines)
	}
}

func TestHandleRollbackGuards(t *testing.T) {
	p := testUpdater(t, t.TempDir(), t.TempDir())
	// Invalid name rejected before any docker touch.
	if _, ok := backupVersion("../pre-v1.0.0.tar.gz"); ok {
		t.Fatal("traversal must not resolve")
	}
	// Valid name, no docker socket here: fails at repoRoot lookup, never
	// touches the tree (no side effects by construction).
	if _, err := p.Rollback("pre-v1.0.0.tar.gz"); err == nil {
		t.Fatal("expected error without docker")
	}
}
