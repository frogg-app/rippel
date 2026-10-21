package main

import (
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

func memoryMode(cfg *Config) string {
	if cfg.MemoryMode == "ram" {
		return "ram"
	}
	return "auto"
}

// Keep operator arguments intact on disk. RAM mode overrides only competing
// memory policies; GPU selection, CPU VAE and other settings survive toggling.
// --novram uses ComfyUI's minimal GPU weight loading and disables dynamic VRAM.
// --lowvram alone does not do this on current dynamic-VRAM ComfyUI versions.
func comfyMemoryArgs(cfg *Config) []string {
	args := strings.Fields(cfg.ComfyArgs)
	// An explicit per-backend choice overrides the legacy launch flag.
	if cfg.VAEOnGPU != nil {
		filtered := make([]string, 0, len(args)+1)
		for _, arg := range args {
			if arg != "--cpu-vae" {
				filtered = append(filtered, arg)
			}
		}
		args = filtered
		if !*cfg.VAEOnGPU {
			args = append(args, "--cpu-vae")
		}
	}
	if memoryMode(cfg) != "ram" {
		return args
	}
	// CPU-only engines already keep their weights in system memory.
	for _, arg := range args {
		if arg == "--cpu" {
			return args
		}
	}
	out := make([]string, 0, len(args)+1)
	for _, arg := range args {
		switch arg {
		case "--gpu-only", "--highvram", "--normalvram", "--lowvram", "--novram", "--enable-dynamic-vram":
			continue
		}
		out = append(out, arg)
	}
	return append(out, "--novram")
}

func (a *Agent) hasRunningTasks() bool {
	for _, task := range a.tasks.List() {
		if task.Status() == "running" {
			return true
		}
	}
	return false
}

func (a *Agent) setMemory(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mode string `json:"mode"`
	}
	if err := readBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if body.Mode != "auto" && body.Mode != "ram" {
		writeError(w, http.StatusBadRequest, "bad_request", "Choose auto or ram.")
		return
	}
	// A service environment override would undo a saved UI choice on reboot.
	if override := os.Getenv("RIPPEL_MEMORY_MODE"); override != "" && override != body.Mode {
		writeError(w, http.StatusConflict, "configured_by_environment", "Memory mode is controlled by this agent's environment.")
		return
	}
	a.applyComputeSetting(w, map[string]any{"memoryMode": body.Mode}, "Memory", func(cfg *Config) { cfg.MemoryMode = body.Mode })
}

func vaeOnGPU(cfg *Config) bool {
	if cfg.VAEOnGPU != nil {
		return *cfg.VAEOnGPU
	}
	for _, arg := range strings.Fields(cfg.ComfyArgs) {
		if arg == "--cpu-vae" {
			return false
		}
	}
	return true
}

func (a *Agent) setVAE(w http.ResponseWriter, r *http.Request) {
	var body struct {
		OnGPU *bool `json:"onGpu"`
	}
	if err := readBody(r, &body); err != nil || body.OnGPU == nil {
		writeError(w, http.StatusBadRequest, "bad_request", "Choose whether to run the VAE on GPU.")
		return
	}
	value := *body.OnGPU
	a.applyComputeSetting(w, map[string]any{"vaeOnGpu": value}, "VAE", func(cfg *Config) { cfg.VAEOnGPU = &value })
}

func (a *Agent) applyComputeSetting(w http.ResponseWriter, patch map[string]any, label string, apply func(*Config)) {
	a.begin(w, "set-memory", func(task *Task) error {
		defer a.changed()
		cfg := a.config()
		running := ComfyStatus(cfg).Running
		pid := readPid(cfg)
		owned := pid > 0 && processAlive(pid)
		if running && !owned {
			return fmt.Errorf("The engine was started outside this agent. Stop it there before changing memory mode.")
		}
		// Persist before modifying the live configuration; a failed write leaves it intact.
		if err := SaveConfig(patch); err != nil {
			return err
		}
		a.mu.Lock()
		apply(a.cfg)
		a.mu.Unlock()
		task.Append(label + " setting saved.")
		if owned {
			task.Append("Restarting the generation engine.")
			if _, err := StopComfy(cfg, 10*time.Second); err != nil {
				return err
			}
			if _, err := StartComfy(a.config()); err != nil {
				return err
			}
			deadline := time.Now().Add(90 * time.Second)
			for time.Now().Before(deadline) {
				if ComfyStatus(a.config()).Running {
					task.Append("Generation engine ready.")
					return nil
				}
				time.Sleep(time.Second)
			}
			return fmt.Errorf("Memory setting saved, but the engine has not started. Check the engine log.")
		}
		task.Append("The setting will apply when the engine starts.")
		return nil
	})
}
