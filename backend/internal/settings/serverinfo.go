package settings

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// ServerField is a resolved server-info value plus the human-readable source
// it was pulled from ("rustdesk-server", "env:DOMAIN", "stack default",
// "manual", ...). The UI renders auto-sources read-only.
type ServerField struct {
	Value  string `json:"value"`
	Source string `json:"source"`
}

// ServerInfo is the full set of connection details shown in the panel.
type ServerInfo struct {
	Address      ServerField `json:"address"`
	RelayAddress ServerField `json:"relay_address"`
	ApiServer    ServerField `json:"api_server"`
	IDPort       ServerField `json:"id_port"`
	RelayPort    ServerField `json:"relay_port"`
	WSPort       ServerField `json:"ws_port"`
	PublicKey    ServerField `json:"public_key"`
}

// GetServerInfo resolves every field with its source:
//   - address: manual override > env DOMAIN > request Host header
//   - relay address: manual override > env RELAY_ADDRESS > same as address
//   - api server: manual override > env RUSTDESK_API_SERVER > empty (unused)
//   - ports:   stored value, "stack default" when it matches the standard
//   - key:     read from the hbbs data dir (HBB_DB_PATH dir / id_ed25519.pub),
//     falls back to a manual override when the file is not readable.
func (s *Store) GetServerInfo(ctx context.Context, hbbDBPath, requestHost string) ServerInfo {
	var address ServerField
	var addressSource string
	if v, _ := s.Get(ctx, ServerDisplayAddressKey, ""); v != "" {
		address = ServerField{Value: v, Source: "manual"}
		addressSource = v
	} else if d := os.Getenv("DOMAIN"); d != "" {
		address = ServerField{Value: d, Source: "env:DOMAIN"}
		addressSource = d
	} else if requestHost != "" {
		address = ServerField{Value: requestHost, Source: "request host"}
		addressSource = requestHost
	}

	var relayAddr ServerField
	if v, _ := s.Get(ctx, ServerRelayAddressKey, ""); v != "" {
		relayAddr = ServerField{Value: v, Source: "manual"}
	} else if d := os.Getenv("RELAY_ADDRESS"); d != "" {
		relayAddr = ServerField{Value: d, Source: "env:RELAY_ADDRESS"}
	} else if addressSource != "" {
		relayAddr = ServerField{Value: addressSource, Source: "default (same as id server)"}
	}

	var apiServer ServerField
	if v, _ := s.Get(ctx, ServerApiKey, ""); v != "" {
		apiServer = ServerField{Value: v, Source: "manual"}
	} else if d := os.Getenv("RUSTDESK_API_SERVER"); d != "" {
		apiServer = ServerField{Value: d, Source: "env:RUSTDESK_API_SERVER"}
	}

	idPort := portField(s.fieldValue(ctx, ServerIDPortKey, DefaultIDPort), DefaultIDPort)
	relayPort := portField(s.fieldValue(ctx, ServerRelayPortKey, DefaultRelayPort), DefaultRelayPort)
	wsPort := portField(s.fieldValue(ctx, ServerWSPortKey, DefaultWSPort), DefaultWSPort)

	pubKey := ServerInfoKeyFromFile(hbbDBPath)
	if pubKey.Source != "" {
		// auto-read wins over any manual entry
		return ServerInfo{
			Address:      address,
			RelayAddress: relayAddr,
			ApiServer:    apiServer,
			IDPort:       idPort,
			RelayPort:    relayPort,
			WSPort:       wsPort,
			PublicKey:    pubKey,
		}
	}
	if v, _ := s.Get(ctx, ServerPublicKeyKey, ""); v != "" {
		return ServerInfo{
			Address:      address,
			RelayAddress: relayAddr,
			ApiServer:    apiServer,
			IDPort:       idPort,
			RelayPort:    relayPort,
			WSPort:       wsPort,
			PublicKey:    ServerField{Value: v, Source: "manual"},
		}
	}
	return ServerInfo{
		Address:      address,
		RelayAddress: relayAddr,
		ApiServer:    apiServer,
		IDPort:       idPort,
		RelayPort:    relayPort,
		WSPort:       wsPort,
		PublicKey:    ServerField{},
	}
}

func (s *Store) fieldValue(ctx context.Context, key, def string) string {
	v, _ := s.Get(ctx, key, def)
	return v
}

func portField(value, def string) ServerField {
	if value == "" {
		value = def
	}
	if value == def {
		return ServerField{Value: value, Source: "stack default"}
	}
	return ServerField{Value: value, Source: "manual"}
}

// ServerInfoKeyFromFile reads the RustDesk public key from the hbbs data dir.
// The file contains the base64 of the raw 32-byte Ed25519 public key.
func ServerInfoKeyFromFile(hbbDBPath string) ServerField {
	p := filepath.Join(filepath.Dir(hbbDBPath), "id_ed25519.pub")
	data, err := os.ReadFile(p)
	if err != nil {
		return ServerField{}
	}
	v := strings.TrimSpace(string(data))
	if !validServerKey(v) {
		return ServerField{}
	}
	return ServerField{Value: v, Source: "rustdesk-server"}
}

func validServerKey(v string) bool {
	decoded, err := base64.StdEncoding.DecodeString(v)
	return err == nil && len(decoded) == 32
}

// ConnectCode is the ready-to-distribute RustDesk client configuration.
// "json" is the console-compatible string (reversed base64url of the config
// JSON) that clients apply on import in Settings → Network; "raw" is the
// underlying JSON literal (also accepted by the import dialog); "comma" is the
// host=/key=/relay= short form used by the --config / renamed-executable path.
type ConnectCode struct {
	JSON   string `json:"json"`
	Raw    string `json:"raw"`
	Comma  string `json:"comma"`
	Host   string `json:"host"`
	Key    string `json:"key"`
	Relay  string `json:"relay"`
	API    string `json:"api"`
	Format string `json:"format"`
}

// rustdeskCustomServer mirrors what the client parses from the config string:
// host (id server), relay, api and key. Field order matches the official
// RustDesk Console so the generated string decodes identically on clients.
type rustdeskCustomServer struct {
	Host  string `json:"host"`
	Relay string `json:"relay"`
	API   string `json:"api"`
	Key   string `json:"key"`
}

// reverseString returns s reversed rune-wise, matching the RustDesk client
// "config string" transform (encode = reverse(base64url(json))).
func reverseString(s string) string {
	r := []rune(s)
	for i, j := 0, len(r)-1; i < j; i, j = i+1, j-1 {
		r[i], r[j] = r[j], r[i]
	}
	return string(r)
}

// BuildConnectCode renders the client connection codes from resolved server
// info. The unsigned JSON form is accepted by rustdesk clients when imported
// from Settings → Network: first the decoder tries the raw JSON, then falls
// back to reverse(base64url) — both are produced here. The signed form used by
// the hosted console can't be reproduced because the signing key is private.
// Non-default ports are embedded as host:port in the matching field.
func BuildConnectCode(info ServerInfo) (ConnectCode, error) {
	host := strings.TrimSpace(info.Address.Value)
	if host == "" {
		return ConnectCode{}, errors.New("server address is not configured")
	}
	key := strings.TrimSpace(info.PublicKey.Value)
	if key == "" || !validServerKey(key) {
		return ConnectCode{}, errors.New("server public key is not configured")
	}
	idHost := host
	if port := strings.TrimSpace(info.IDPort.Value); port != "" && port != DefaultIDPort {
		idHost = host + ":" + port
	}
	relayHost := strings.TrimSpace(info.RelayAddress.Value)
	if relayHost == "" {
		relayHost = host
	}
	if port := strings.TrimSpace(info.RelayPort.Value); port != "" && port != DefaultRelayPort {
		relayHost = relayHost + ":" + port
	}
	api := strings.TrimSpace(info.ApiServer.Value)

	cfg := rustdeskCustomServer{Host: idHost, Relay: relayHost, API: api, Key: key}
	payload, err := json.Marshal(cfg)
	if err != nil {
		return ConnectCode{}, err
	}
	comma := "host=" + idHost + ",key=" + key + ",relay=" + relayHost
	if api != "" {
		comma += ",api=" + api
	}
	return ConnectCode{
		JSON:   reverseString(base64.URLEncoding.EncodeToString(payload)),
		Raw:    string(payload),
		Comma:  comma,
		Host:   idHost,
		Key:    key,
		Relay:  relayHost,
		API:    api,
		Format: "unsigned",
	}, nil
}
