package device

import (
	"strings"
	"testing"
)

func TestSearchClausesDecimalID(t *testing.T) {
	clause, args := searchClauses("176902107", "", "")
	if !strings.Contains(clause, "peer_id ILIKE") {
		t.Fatalf("no peer_id clause: %s", clause)
	}
	found := false
	for _, a := range args {
		if s, ok := a.(string); ok && strings.Contains(s, "313736393032313037") {
			found = true
		}
	}
	if !found {
		t.Fatalf("decimal id not hex-encoded in args: %v", args)
	}
}

func TestSearchClausesFieldsWhitelist(t *testing.T) {
	clause, args := searchClauses("x", "alias,peer_id,bogus', '/platform", "")
	if strings.Contains(clause, "bogus") {
		t.Fatalf("unwhitelisted field leaked: %s", clause)
	}
	if !strings.Contains(clause, "alias ILIKE") || !strings.Contains(clause, "peer_id ILIKE") {
		t.Fatalf("wanted fields missing: %s", clause)
	}
	// Empty fields = all six columns.
	clauseAll, _ := searchClauses("x", "", "")
	for _, col := range []string{"alias", "peer_id", "hostname", "username", "platform", "host_version"} {
		if !strings.Contains(clauseAll, col+" ILIKE") {
			t.Fatalf("default set misses %s: %s", col, clauseAll)
		}
	}
	_ = args
}

func TestSearchClausesOps(t *testing.T) {
	clause, args := searchClauses("ab", "alias,hostname", "alias:exact,hostname:starts,bogus:exact")
	if !strings.Contains(clause, "alias ILIKE") || !strings.Contains(clause, "hostname ILIKE") {
		t.Fatalf("clauses broken: %s", clause)
	}
	got := map[string]bool{}
	for _, a := range args {
		if s, ok := a.(string); ok {
			got[s] = true
		}
	}
	if !got["ab"] {
		t.Fatalf("exact op broken: %v", args)
	}
	if !got["ab%"] {
		t.Fatalf("starts op broken: %v", args)
	}
}
