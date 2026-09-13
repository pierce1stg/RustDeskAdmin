package settings

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

// dartServerConfigDecode mirrors the RustDesk Flutter client
// (ServerConfig.decode): first raw JSON, then reverse + padded base64.
func dartServerConfigDecode(msg string) map[string]string {
	var m map[string]string
	if err := json.Unmarshal([]byte(msg), &m); err == nil {
		return m
	}
	reversed := reverseString(msg)
	reversed += strings.Repeat("=", (4-len(reversed)%4)%4)
	raw, err := base64.StdEncoding.DecodeString(reversed)
	if err != nil {
		return nil
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil
	}
	return m
}

func TestBuildConnectCode(t *testing.T) {
	info := ServerInfo{
		Address:      ServerField{Value: "example.com"},
		RelayAddress: ServerField{Value: "example.com", Source: "default (same as id server)"},
		IDPort:       ServerField{Value: DefaultIDPort, Source: "stack default"},
		RelayPort:    ServerField{Value: DefaultRelayPort, Source: "stack default"},
		PublicKey:    ServerField{Value: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", Source: "rustdesk-server"},
	}

	code, err := BuildConnectCode(info)
	if err != nil {
		t.Fatalf("BuildConnectCode: %v", err)
	}

	want := map[string]string{
		"host":  "example.com",
		"relay": "example.com",
		"api":   "",
		"key":   "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
	}

	parsed := dartServerConfigDecode(code.JSON)
	if parsed == nil {
		t.Fatalf("dart decode of json form failed: %q", code.JSON)
	}
	for k, v := range want {
		if parsed[k] != v {
			t.Errorf("json %s = %q, want %q", k, parsed[k], v)
		}
	}
	if !strings.HasPrefix(code.JSON, "=") {
		t.Errorf("json form should start with '=' (padded reverse base64url), got prefix %q", code.JSON[:4])
	}

	rawParsed := dartServerConfigDecode(code.Raw)
	if rawParsed == nil {
		t.Fatalf("raw json form did not decode: %q", code.Raw)
	}
	if rawParsed["host"] != want["host"] || rawParsed["key"] != want["key"] {
		t.Errorf("raw json mismatch: %v", rawParsed)
	}

	if !strings.Contains(code.Comma, "host=example.com,key=") {
		t.Errorf("comma form unexpected: %q", code.Comma)
	}
}

func TestBuildConnectCodeRelayAndAPISeparated(t *testing.T) {
	info := ServerInfo{
		Address:      ServerField{Value: "id.example.com", Source: "manual"},
		RelayAddress: ServerField{Value: "relay.example.com", Source: "manual"},
		ApiServer:    ServerField{Value: "https://api.example.com", Source: "manual"},
		IDPort:       ServerField{Value: "31116", Source: "manual"},
		RelayPort:    ServerField{Value: "21117", Source: "stack default"},
		PublicKey:    ServerField{Value: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", Source: "manual"},
	}

	code, err := BuildConnectCode(info)
	if err != nil {
		t.Fatalf("BuildConnectCode: %v", err)
	}
	want := map[string]string{
		"host":  "id.example.com:31116",
		"relay": "relay.example.com",
		"api":   "https://api.example.com",
		"key":   "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
	}
	parsed := dartServerConfigDecode(code.JSON)
	if parsed == nil {
		t.Fatalf("dart decode failed: %q", code.JSON)
	}
	for k, v := range want {
		if parsed[k] != v {
			t.Errorf("json %s = %q, want %q", k, parsed[k], v)
		}
	}
	if !strings.Contains(code.Comma, ",relay=relay.example.com,api=https://api.example.com") {
		t.Errorf("comma form missing relay/api: %q", code.Comma)
	}
}

func TestBuildConnectCodeErrors(t *testing.T) {
	if _, err := BuildConnectCode(ServerInfo{Address: ServerField{Value: "x"}}); err == nil {
		t.Error("expected error when public key missing")
	}
	info := ServerInfo{
		Address:   ServerField{Value: "x"},
		PublicKey: ServerField{Value: "abc"},
	}
	if _, err := BuildConnectCode(info); err == nil {
		t.Error("expected error when key invalid")
	}
}
