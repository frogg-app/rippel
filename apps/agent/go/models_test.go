package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type modelRoundTrip func(*http.Request) (*http.Response, error)

func (f modelRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func modelTest(t *testing.T) (*Config, *Task, string) {
	t.Helper()
	cfg := testConfig(t)
	root := filepath.Join(cfg.ComfyPath, "models")
	if err := os.MkdirAll(filepath.Join(root, "checkpoints"), 0755); err != nil {
		t.Fatal(err)
	}
	return cfg, NewTasks().Create("model-files"), root
}
func modelBody(content string) ModelDownload {
	hash := sha256.Sum256([]byte(content))
	return ModelDownload{URL: "https://huggingface.co/owner/repo/resolve/main/model.safetensors",
		Path: "vae/model.safetensors", SHA256: hex.EncodeToString(hash[:]), SizeBytes: int64(len(content))}
}
func bytesClient(content string) *http.Client {
	return modelHTTPClient(modelRoundTrip(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(content)), ContentLength: int64(len(content)), Header: make(http.Header)}, nil
	}))
}

func TestModelMoveAndNoOverwrite(t *testing.T) {
	cfg, task, root := modelTest(t)
	source := filepath.Join(root, "checkpoints", "model.safetensors")
	if err := os.WriteFile(source, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := moveModel(cfg, task, ModelMove{From: "checkpoints/model.safetensors", To: "diffusion_models/model.safetensors"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(source); !os.IsNotExist(err) {
		t.Fatal("source still exists")
	}
	if err := os.WriteFile(source, []byte("second"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := moveModel(cfg, task, ModelMove{From: "checkpoints/model.safetensors", To: "diffusion_models/model.safetensors"}); err == nil {
		t.Fatal("overwrote destination")
	}
	data, _ := os.ReadFile(source)
	if string(data) != "second" {
		t.Fatal("lost source")
	}
	data, _ = os.ReadFile(filepath.Join(root, "diffusion_models", "model.safetensors"))
	if string(data) != "original" {
		t.Fatal("lost destination")
	}
}

func TestModelPathsRefuseEscape(t *testing.T) {
	cfg, task, root := modelTest(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "file"), []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Skip("symlinks unavailable", err)
	}
	paths := []string{"../file", "checkpoints/../../file", "/tmp/file", `C:\file`, `\\server\file`, "escape/file", "escape/new/file"}
	for _, path := range paths {
		t.Run(path, func(t *testing.T) {
			body := modelBody("weights")
			body.Path = path
			if err := downloadModel(cfg, task, body, bytesClient("weights")); err == nil {
				t.Fatal("download escaped")
			}
			if err := moveModel(cfg, task, ModelMove{From: path, To: "checkpoints/destination"}); err == nil {
				t.Fatal("move source escaped")
			}
		})
	}
	body := modelBody("weights")
	body.Path = "checkpoints/weights"
	if err := downloadModel(cfg, task, body, bytesClient("weights")); err != nil {
		t.Fatal(err)
	}
	if err := moveModel(cfg, task, ModelMove{From: "checkpoints/weights", To: "escape/destination"}); err == nil {
		t.Fatal("move destination escaped")
	}
}

func TestModelDownloadsVerifyAndCleanUp(t *testing.T) {
	for _, failure := range []string{"none", "hash", "missing-hash", "size", "network", "exists"} {
		t.Run(failure, func(t *testing.T) {
			cfg, task, root := modelTest(t)
			body := modelBody("weights")
			client := bytesClient("weights")
			switch failure {
			case "hash":
				body.SHA256 = strings.Repeat("0", 64)
			case "missing-hash":
				body.SHA256 = ""
			case "size":
				body.SizeBytes++
			case "network":
				client = modelHTTPClient(modelRoundTrip(func(*http.Request) (*http.Response, error) { return nil, fmt.Errorf("network failed") }))
			case "exists":
				if err := os.MkdirAll(filepath.Join(root, "vae"), 0755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(root, "vae/model.safetensors"), []byte("keep"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			err := downloadModel(cfg, task, body, client)
			if failure == "none" && err != nil {
				t.Fatal(err)
			}
			if failure != "none" && err == nil {
				t.Fatal("expected refusal")
			}
			matches, _ := filepath.Glob(filepath.Join(root, "vae", ".rippel-*.part"))
			if len(matches) != 0 {
				t.Fatal("left temporary files", matches)
			}
			data, readErr := os.ReadFile(filepath.Join(root, "vae/model.safetensors"))
			if failure == "none" && string(data) != "weights" {
				t.Fatal("wrong bytes")
			}
			if failure == "exists" && string(data) != "keep" {
				t.Fatal("replaced existing file")
			}
			if failure != "none" && failure != "exists" && !os.IsNotExist(readErr) {
				t.Fatal("published failed download")
			}
		})
	}
}

func TestModelURLPolicyIncludesRedirects(t *testing.T) {
	for _, raw := range []string{"http://huggingface.co/model", "https://evil.com/file", "https://huggingface.co.evil.com/file", "https://user:pass@huggingface.co/file", "https://huggingface.co:8443/file", "https://127.0.0.1/file", "file:///tmp/model"} {
		if err := allowedModelURL(raw, false); err == nil {
			t.Fatal("accepted", raw)
		}
	}
	for _, raw := range []string{"https://huggingface.co/repo/file", "https://civitai.com/api/download/models/1"} {
		if err := allowedModelURL(raw, false); err != nil {
			t.Fatal(err)
		}
	}
	client := modelHTTPClient(modelRoundTrip(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{"http://127.0.0.1/private"}}, Body: io.NopCloser(strings.NewReader(""))}, nil
	}))
	cfg, task, _ := modelTest(t)
	if err := downloadModel(cfg, task, modelBody("weights"), client); err == nil {
		t.Fatal("followed unsafe redirect")
	}
}

func TestModelRoutesRequireTokenAndReturnTasks(t *testing.T) {
	cfg, _, _ := modelTest(t)
	for _, path := range []string{"/agent/models/move", "/agent/models/download"} {
		agent := NewAgent(cfg, nil)
		req := httptest.NewRequest("POST", path, strings.NewReader(`{}`))
		rec := httptest.NewRecorder()
		agent.Handler().ServeHTTP(rec, req)
		if rec.Code != 401 {
			t.Fatal("missing auth")
		}
		req = httptest.NewRequest("POST", path, strings.NewReader(`{}`))
		req.Header.Set("X-Rippel-Agent-Token", cfg.Token)
		rec = httptest.NewRecorder()
		agent.Handler().ServeHTTP(rec, req)
		if rec.Code != 202 || !strings.Contains(rec.Body.String(), `"task"`) {
			t.Fatal(rec.Code, rec.Body.String())
		}
	}
}

func TestModelHostsFollowHuggingFaceCDNMoves(t *testing.T) {
	for _, ok := range []string{
		"https://us.aws.cdn.hf.co/xet-bridge-us/abc/def",
		"https://cas-bridge.xethub.hf.co/xet-bridge-us/abc",
		"https://cdn-lfs-us-1.huggingface.co/repos/abc",
	} {
		if err := allowedModelURL(ok, true); err != nil {
			t.Errorf("redirect to %s refused: %v", ok, err)
		}
	}
	// The first hop is still only the model sites themselves.
	if err := allowedModelURL("https://us.aws.cdn.hf.co/x", false); err == nil {
		t.Error("a CDN host was accepted as the starting URL")
	}
	for _, bad := range []string{
		"https://hf.co.evil.example/x",
		"https://evilhf.co/x",
		"https://huggingface.co.example/x",
		"http://us.aws.cdn.hf.co/x",
	} {
		if err := allowedModelURL(bad, true); err == nil {
			t.Errorf("%s was accepted", bad)
		}
	}
}
