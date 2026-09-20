package update

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestBackupNameRe(t *testing.T) {
	valid := []string{"pre-v1.0.0.tar.gz", "pre-v10.20.30.tar.gz", "pre-v1.0.0-manual-1758412345.tar.gz"}
	for _, n := range valid {
		if !backupNameRe.MatchString(n) {
			t.Errorf("expected valid backup name %q", n)
		}
	}
	invalid := []string{
		"",
		"pre-v1.0.0.zip",
		"v1.0.0.tar.gz",
		"pre-v1.0.tar.gz",
		"pre-v1.0.0.tar.gz ",
		" pre-v1.0.0.tar.gz",
		"../pre-v1.0.0.tar.gz",
		"pre-v1.0.0.tar.gz/../x",
		"/abs/pre-v1.0.0.tar.gz",
		"pre-v1.0.0.tar.gz\nB",
		"pre-latest.tar.gz",
		"pre-v1.0.0-manual-.tar.gz",
		"pre-v1.0.0-manual-abc.tar.gz",
		"pre-v1.0.0-manual-123.tar.gz/../x",
		"pre-v1.0.0-auto-123.tar.gz",
	}
	for _, n := range invalid {
		if backupNameRe.MatchString(n) {
			t.Errorf("expected invalid backup name %q", n)
		}
	}
}

func TestBackupVersion(t *testing.T) {
	v, ok := backupVersion("pre-v1.0.0.tar.gz")
	if !ok || v != "v1.0.0" {
		t.Errorf("got %q,%v want v1.0.0,true", v, ok)
	}
	v, ok = backupVersion("pre-v1.0.0-manual-1758412345.tar.gz")
	if !ok || v != "v1.0.0" {
		t.Errorf("manual: got %q,%v want v1.0.0,true", v, ok)
	}
	if _, ok := backupVersion("../pre-v1.0.0.tar.gz"); ok {
		t.Error("traversal name must not resolve")
	}
	if _, ok := backupVersion("nope"); ok {
		t.Error("garbage must not resolve")
	}
}

func TestManualBackupName(t *testing.T) {
	for _, n := range []string{
		manualBackupName("1.0.0", 1758412345),
		manualBackupName("v1.0.0", 1758412345),
	} {
		if n != "pre-v1.0.0-manual-1758412345.tar.gz" {
			t.Errorf("got %q", n)
		}
		if !backupNameRe.MatchString(n) {
			t.Errorf("generated name %q must satisfy backupNameRe", n)
		}
		if v, ok := backupVersion(n); !ok || v != "v1.0.0" {
			t.Errorf("generated name %q must resolve to v1.0.0", n)
		}
	}
}

func TestTailLines(t *testing.T) {
	lines := []string{"a", "b", "c", "d"}
	if got := tailLines(lines, 2); !reflect.DeepEqual(got, []string{"c", "d"}) {
		t.Errorf("tail 2 = %v", got)
	}
	if got := tailLines(lines, 99); !reflect.DeepEqual(got, lines) {
		t.Errorf("tail all = %v", got)
	}
	if got := tailLines(lines, 0); len(got) != 0 {
		t.Errorf("tail 0 = %v", got)
	}
	if got := tailLines(nil, 5); len(got) != 0 {
		t.Errorf("tail nil = %v", got)
	}
}

func TestStatusSnakeCaseContract(t *testing.T) {
	// Payload as written by the runner's state() python: snake_case keys.
	// Guards the Go<->python field contract (encoding/json needs the tags).
	var st PanelStatusResponse
	if err := json.Unmarshal([]byte(
		`{"phase":"ok","latest":"v1.0.0","started_at":"2026-01-01T00:00:00+00:00",`+
			`"finished_at":"2026-01-01T00:01:00+00:00"}`,
	), &st); err != nil {
		t.Fatal(err)
	}
	if st.Phase != "ok" || st.StartedAt == "" || st.FinishedAt == "" || st.Latest != "v1.0.0" {
		t.Errorf("contract broken: %+v", st)
	}
}
