package update

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"
)

// dockerClient is a minimal Docker Engine API client over a unix socket using
// only the standard library. It covers the small surface needed to recreate a
// container from its own configuration (hbbs / hbbr upgrades).
type dockerClient struct {
	sock    string
	client  *http.Client
	version string
}

func newDockerClient(sock, apiVersion string) *dockerClient {
	if apiVersion == "" {
		apiVersion = "v1.44"
	}
	tr := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return net.Dial("unix", sock)
		},
	}
	return &dockerClient{
		sock:    sock,
		client:  &http.Client{Transport: tr, Timeout: 180 * time.Second},
		version: apiVersion,
	}
}

func (d *dockerClient) do(ctx context.Context, method, path string, body io.Reader) ([]byte, error) {
	var q string
	if qIdx := bytes.IndexByte([]byte(path), '?'); qIdx >= 0 {
		q = path[qIdx:]
		path = path[:qIdx]
	}
	u := "http://unix/" + d.version + path + q
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := d.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("docker request %s %s failed: %w", method, path, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode >= 400 {
		var errResp struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(data, &errResp) == nil && errResp.Message != "" {
			return nil, fmt.Errorf("docker %s %s: %s", method, path, errResp.Message)
		}
		return nil, fmt.Errorf("docker %s %s: status %d", method, path, resp.StatusCode)
	}
	return data, nil
}

// inspectContainer returns the full JSON of GET /containers/{name}/json unmodified.
func (d *dockerClient) inspectContainer(ctx context.Context, name string) (map[string]interface{}, error) {
	data, err := d.do(ctx, http.MethodGet, "/containers/"+url.PathEscape(name)+"/json", nil)
	if err != nil {
		return nil, err
	}
	var out map[string]interface{}
	if err := json.Unmarshal(data, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (d *dockerClient) pullImage(ctx context.Context, image, tag string) error {
	v := url.Values{}
	v.Set("fromImage", image)
	v.Set("tag", tag)
	_, err := d.do(ctx, http.MethodPost, "/images/create?"+v.Encode(), nil)
	return err
}

func (d *dockerClient) stopContainer(ctx context.Context, name string) error {
	_, err := d.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(name)+"/stop", nil)
	return err
}

func (d *dockerClient) removeContainer(ctx context.Context, name string) error {
	v := url.Values{}
	v.Set("force", "true")
	v.Set("v", "false")
	_, err := d.do(ctx, http.MethodDelete, "/containers/"+url.PathEscape(name)+"?"+v.Encode(), nil)
	return err
}

func (d *dockerClient) createContainer(ctx context.Context, name string, spec map[string]interface{}) (string, error) {
	body, err := json.Marshal(spec)
	if err != nil {
		return "", err
	}
	data, err := d.do(ctx, http.MethodPost, "/containers/create?name="+url.QueryEscape(name), bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	var out struct {
		ID string `json:"Id"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return "", fmt.Errorf("create returned an unparseable response: %v", string(data))
	}
	return out.ID, nil
}

func (d *dockerClient) startContainer(ctx context.Context, idOrName string) error {
	_, err := d.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(idOrName)+"/start", nil)
	return err
}
