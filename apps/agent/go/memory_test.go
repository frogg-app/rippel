package main

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestMemoryArgsPreserveGPUAndRestoreCustomPolicy(t *testing.T) {
	cfg := &Config{ComfyArgs: "--cpu-vae --cuda-device 1 --highvram --enable-dynamic-vram", MemoryMode: "ram"}
	if got, want := comfyMemoryArgs(cfg), []string{"--cpu-vae", "--cuda-device", "1", "--novram"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("%v != %v", got, want)
	}
	cfg.MemoryMode = "auto"
	if !reflect.DeepEqual(comfyMemoryArgs(cfg), strings.Fields(cfg.ComfyArgs)) {
		t.Fatal("custom arguments were changed")
	}
	cfg.MemoryMode = "ram"
	cfg.ComfyArgs = "--cpu --cpu-vae"
	if !reflect.DeepEqual(comfyMemoryArgs(cfg), strings.Fields(cfg.ComfyArgs)) {
		t.Fatal("CPU-only setting was changed")
	}
}

func TestMemoryModePersistsForStoppedEngine(t *testing.T) {
	cfg := testConfig(t)
	t.Setenv("RIPPEL_AGENT_HOME", cfg.Home)
	t.Setenv("RIPPEL_MEMORY_MODE", "")
	cfg.ComfyArgs = "--cpu-vae --cuda-device 1"
	agent := NewAgent(cfg, nil)
	req := httptest.NewRequest("POST", "/agent/memory", strings.NewReader(`{"mode":"ram"}`))
	req.Header.Set("X-Rippel-Agent-Token", cfg.Token)
	res := httptest.NewRecorder()
	agent.Handler().ServeHTTP(res, req)
	if res.Code != 202 {
		t.Fatalf("%d %s", res.Code, res.Body.String())
	}
	var payload struct{ Task TaskView }
	json.Unmarshal(res.Body.Bytes(), &payload)
	task := agent.tasks.Get(payload.Task.ID)
	deadline := time.Now().Add(3 * time.Second)
	for task.Status() == "running" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if task.Status() != "done" {
		t.Fatalf("%+v", task.snapshot(-1))
	}
	saved, err := os.ReadFile(filepath.Join(cfg.Home, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(saved), `"memoryMode": "ram"`) {
		t.Fatal(string(saved))
	}
	if agent.config().ComfyArgs != "--cpu-vae --cuda-device 1" {
		t.Fatal("lost GPU setting")
	}
	if ComfyStatus(agent.config()).MemoryMode != "ram" {
		t.Fatal("status missing mode")
	}
}

func TestMemoryModeRefusesExternalEngine(t *testing.T) {
	cfg := testConfig(t)
	t.Setenv("RIPPEL_AGENT_HOME", cfg.Home)
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"system":{}}`)) }))
	defer stub.Close()
	cfg.ComfyPort = stub.Listener.Addr().(*net.TCPAddr).Port
	agent := NewAgent(cfg, nil)
	req := httptest.NewRequest("POST", "/agent/memory", strings.NewReader(`{"mode":"ram"}`))
	req.Header.Set("X-Rippel-Agent-Token", cfg.Token)
	res := httptest.NewRecorder()
	agent.Handler().ServeHTTP(res, req)
	var payload struct{ Task TaskView }
	json.Unmarshal(res.Body.Bytes(), &payload)
	task := agent.tasks.Get(payload.Task.ID)
	if task == nil {
		t.Fatal(res.Body.String())
	}
	deadline := time.Now().Add(3 * time.Second)
	for task.Status() == "running" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if task.Status() != "failed" || !strings.Contains(*task.Err(), "outside this agent") {
		t.Fatalf("%+v", task.snapshot(-1))
	}
	if exists(filepath.Join(cfg.Home, "config.json")) {
		t.Fatal("changed external engine config")
	}
}

func TestMemoryModeAuthenticationValidationAndBusy(t *testing.T) {
	for _, tc := range []struct {
		body, token string
		busy        bool
		want        int
	}{
		{`{"mode":"ram"}`, "", false, 401}, {`{"mode":"oops"}`, "the-token", false, 400}, {`{"mode":"ram"}`, "the-token", true, 409},
	} {
		cfg := testConfig(t)
		agent := NewAgent(cfg, nil)
		if tc.busy {
			agent.tasks.Create("install-comfyui")
		}
		req := httptest.NewRequest("POST", "/agent/memory", strings.NewReader(tc.body))
		req.Header.Set("X-Rippel-Agent-Token", tc.token)
		res := httptest.NewRecorder()
		agent.Handler().ServeHTTP(res, req)
		if res.Code != tc.want {
			t.Fatalf("got %d want %d", res.Code, tc.want)
		}
	}
}

func TestMemoryModeEnvironmentOverrideAndSaveFailure(t *testing.T) {
	cfg := testConfig(t)
	t.Setenv("RIPPEL_AGENT_HOME", cfg.Home)
	t.Setenv("RIPPEL_MEMORY_MODE", "auto")
	agent := NewAgent(cfg, nil)
	request := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest("POST", "/agent/memory", strings.NewReader(`{"mode":"ram"}`))
		req.Header.Set("X-Rippel-Agent-Token", cfg.Token)
		res := httptest.NewRecorder()
		agent.Handler().ServeHTTP(res, req)
		return res
	}
	if res := request(); res.Code != 409 {
		t.Fatal(res.Code)
	}
	t.Setenv("RIPPEL_MEMORY_MODE", "")
	if err := os.WriteFile(filepath.Join(cfg.Home, "config.json"), []byte("invalid json"), 0600); err != nil {
		t.Fatal(err)
	}
	res := request()
	var payload struct{ Task TaskView }
	json.Unmarshal(res.Body.Bytes(), &payload)
	task := agent.tasks.Get(payload.Task.ID)
	if task == nil {
		t.Fatal(res.Body.String())
	}
	deadline := time.Now().Add(3 * time.Second)
	for task.Status() == "running" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if task.Status() != "failed" {
		t.Fatal(task.Status())
	}
	if memoryMode(agent.config()) != "auto" {
		t.Fatal("failed save modified live settings")
	}
}

func TestVAEAndMemoryDefaultsAndIndependence(t *testing.T) {
	cfg := &Config{ComfyArgs: "--cuda-device 1"}
	if !vaeOnGPU(cfg) || memoryMode(cfg) != "auto" {
		t.Fatal("wrong defaults")
	}
	cpu := false
	cfg.VAEOnGPU = &cpu
	if got := comfyMemoryArgs(cfg); !reflect.DeepEqual(got, []string{"--cuda-device", "1", "--cpu-vae"}) {
		t.Fatal(got)
	}
	cfg.MemoryMode = "ram"
	if got := comfyMemoryArgs(cfg); !reflect.DeepEqual(got, []string{"--cuda-device", "1", "--cpu-vae", "--novram"}) {
		t.Fatal(got)
	}
	gpu := true
	cfg.VAEOnGPU = &gpu
	cfg.ComfyArgs = "--cpu-vae --cuda-device 1"
	if got := comfyMemoryArgs(cfg); !reflect.DeepEqual(got, []string{"--cuda-device", "1", "--novram"}) {
		t.Fatal(got)
	}
}

func TestVAEChoicePersistsAcrossAgentRestart(t *testing.T) {
	cfg := testConfig(t)
	t.Setenv("RIPPEL_AGENT_HOME", cfg.Home)
	agent := NewAgent(cfg, nil)
	req := httptest.NewRequest("POST", "/agent/vae", strings.NewReader(`{"onGpu":false}`))
	req.Header.Set("X-Rippel-Agent-Token", cfg.Token)
	res := httptest.NewRecorder()
	agent.Handler().ServeHTTP(res, req)
	if res.Code != 202 {
		t.Fatal(res.Code, res.Body.String())
	}
	var payload struct{ Task TaskView }
	json.Unmarshal(res.Body.Bytes(), &payload)
	task := agent.tasks.Get(payload.Task.ID)
	deadline := time.Now().Add(3 * time.Second)
	for task.Status() == "running" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if task.Status() != "done" {
		t.Fatal(task.snapshot(-1))
	}
	saved, err := os.ReadFile(filepath.Join(cfg.Home, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	var reloaded Config
	if err = json.Unmarshal(saved, &reloaded); err != nil {
		t.Fatal(err)
	}
	if vaeOnGPU(&reloaded) {
		t.Fatal("CPU VAE choice was not persisted")
	}
	if memoryMode(&reloaded) != "auto" {
		t.Fatal("VAE changed memory mode")
	}
}

func TestVAERequiresBooleanAndAuthentication(t *testing.T) {
	for _, tc := range []struct {
		body   string
		auth   bool
		status int
	}{{`{}`, true, 400}, {`{"onGpu":"yes"}`, true, 400}, {`{"onGpu":true}`, false, 401}} {
		cfg := testConfig(t)
		agent := NewAgent(cfg, nil)
		req := httptest.NewRequest("POST", "/agent/vae", strings.NewReader(tc.body))
		if tc.auth {
			req.Header.Set("X-Rippel-Agent-Token", cfg.Token)
		}
		res := httptest.NewRecorder()
		agent.Handler().ServeHTTP(res, req)
		if res.Code != tc.status {
			t.Fatal(res.Code, res.Body.String())
		}
	}
}
