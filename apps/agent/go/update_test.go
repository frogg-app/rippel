package main

import (
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestAgentUpdateOnlyFetchesConfiguredServerWithHash(t *testing.T) {
	data := []byte("test-binary")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/deployments/enrolled/agent/") || r.Header.Get("X-Rippel-Agent-Token") != "the-token" {
			t.Error("wrong update origin or token")
		}
		w.Write(data)
	}))
	defer server.Close()
	cfg := testConfig(t)
	cfg.ServerURL = server.URL
	cfg.DeploymentID = "enrolled"
	path, err := stageAgentUpdate(cfg, AgentUpdateRequest{SHA256: fmt.Sprintf("%x", sha256.Sum256(data))}, server.Client(), nil)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(path)
	if string(got) != string(data) {
		t.Fatal("wrong staged bytes")
	}
	os.Remove(path)
	if _, err := stageAgentUpdate(cfg, AgentUpdateRequest{SHA256: strings.Repeat("0", 64)}, server.Client(), nil); err == nil {
		t.Fatal("accepted bad hash")
	}
	files, _ := os.ReadDir(cfg.Home)
	if len(files) != 0 {
		t.Fatal("left an invalid partial binary")
	}
}
func TestAgentUpdateRefusesRedirectAndMissingEnrollment(t *testing.T) {
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("followed redirect with agent credentials") }))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, 302) }))
	defer source.Close()
	cfg := testConfig(t)
	cfg.ServerURL = source.URL
	cfg.DeploymentID = "enrolled"
	if _, err := stageAgentUpdate(cfg, AgentUpdateRequest{SHA256: strings.Repeat("a", 64)}, source.Client(), nil); err == nil {
		t.Fatal("followed redirect")
	}
	cfg.DeploymentID = ""
	if _, err := agentUpdateURL(cfg); err == nil {
		t.Fatal("accepted unenrolled agent")
	}
}
