package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Everything the agent knows how to do to a ComfyUI install.
//
// The install is deliberately the boring one everybody does by hand — git
// clone, a venv beside it, pip install torch, pip install -r requirements.txt —
// because the failure modes of that sequence are the ones every ComfyUI answer
// on the internet is about. An agent with a clever bespoke layout would be a
// machine nobody else could help you fix.
//
// Two things are not boring and are worth stating:
//
//   - Which torch. There is no one wheel index that works on every machine, and
//     installing the wrong one gets you a ComfyUI that starts, loads a
//     checkpoint, and faults on the first real kernel. So the vendor is detected
//     (nvidia-smi, then rocminfo) and, failing that, we fall back to CPU wheels
//     rather than guessing CUDA — CUDA is the common case and therefore the
//     tempting wrong answer.
//   - Starting it detached. ComfyUI must outlive the request that started it and
//     the agent process itself, so it is spawned detached with its output
//     redirected to a file and its pid written down.

const comfyRepo = "https://github.com/comfyanonymous/ComfyUI.git"

// HelperDir is the folder name the storage helper must have inside custom_nodes.
const HelperDir = "comfyui-rippel-storage"

// ComfyState is the wire shape rippel's ComfyState type expects. The JSON tags
// are the contract; do not rename them without changing packages/shared.
type ComfyState struct {
	Installed       bool    `json:"installed"`
	Running         bool    `json:"running"`
	Path            *string `json:"path"`
	Version         *string `json:"version"`
	Commit          *string `json:"commit"`
	Port            int     `json:"port"`
	HelperInstalled bool    `json:"helperInstalled"`
	HelperReady     bool    `json:"helperReady"`
	DiskFree        *int64  `json:"diskFree"`
	DiskTotal       *int64  `json:"diskTotal"`
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func venvPath(cfg *Config) string { return filepath.Join(cfg.ComfyPath, ".venv") }

// venvPython is the interpreter inside the venv, which is what every later step
// must use — not the system python that created it.
func venvPython(cfg *Config) string {
	if runtime.GOOS == "windows" {
		return filepath.Join(venvPath(cfg), "Scripts", "python.exe")
	}
	return filepath.Join(venvPath(cfg), "bin", "python")
}

func pidFile(cfg *Config) string { return filepath.Join(cfg.Home, "comfyui.pid") }

// ComfyLogFile is where ComfyUI's own output is redirected.
func ComfyLogFile(cfg *Config) string { return filepath.Join(cfg.Home, "comfyui.log") }

// ---------------------------------------------------------------- status

func readPid(cfg *Config) int {
	raw, err := os.ReadFile(pidFile(cfg))
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || pid <= 0 {
		return 0
	}
	return pid
}

// askComfy is a short-timeout GET against the managed ComfyUI. Any failure is
// "not answering", which is the only distinction the status needs.
func askComfy(cfg *Config, path string) map[string]any {
	ctx, cancel := context.WithTimeout(context.Background(), 2500*time.Millisecond)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("http://127.0.0.1:%d%s", cfg.ComfyPort, path), nil)
	if err != nil {
		return nil
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil
	}
	var payload map[string]any
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		return nil
	}
	return payload
}

func gitCommit(cfg *Config) *string {
	cmd := exec.Command("git", "rev-parse", "--short", "HEAD")
	cmd.Dir = cfg.ComfyPath
	hideConsole(cmd)
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	commit := strings.TrimSpace(string(out))
	if commit == "" {
		return nil
	}
	return &commit
}

// helperState is whether the helper is present, and whether it actually answers.
func helperState(cfg *Config) (installed bool, ready bool) {
	dir := filepath.Join(cfg.ComfyPath, "custom_nodes", HelperDir)
	installed = exists(filepath.Join(dir, "__init__.py"))
	if !installed || cfg.StorageToken == "" {
		return installed, false
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2500*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("http://127.0.0.1:%d/rippel/storage/ping", cfg.ComfyPort), nil)
	if err != nil {
		return true, false
	}
	req.Header.Set("X-Rippel-Token", cfg.StorageToken)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return true, false
	}
	defer res.Body.Close()
	return true, res.StatusCode >= 200 && res.StatusCode <= 299
}

// comfyVersion digs ComfyUI's own version string out of /system_stats, which
// nests it under "system". A missing or oddly-shaped answer is simply nil.
func comfyVersion(stats map[string]any) *string {
	system, ok := stats["system"].(map[string]any)
	if !ok {
		return nil
	}
	version, ok := system["comfyui_version"].(string)
	if !ok || version == "" {
		return nil
	}
	return &version
}

// ComfyStatus is the whole picture of the managed ComfyUI, as one object.
//
// "Running" is answered by asking the port, not by the pid file: a pid file
// outlives a crash, and an operator who started ComfyUI by hand has no pid file
// at all. The pid is only how we stop it.
func ComfyStatus(cfg *Config) ComfyState {
	installed := exists(filepath.Join(cfg.ComfyPath, "main.py"))
	stats := askComfy(cfg, "/system_stats")
	helperInstalled, helperReady := helperState(cfg)

	spaceAt := cfg.Home
	if installed {
		spaceAt = cfg.ComfyPath
	}
	free, total := diskSpace(spaceAt)

	state := ComfyState{
		Installed:       installed,
		Running:         stats != nil,
		Port:            cfg.ComfyPort,
		HelperInstalled: helperInstalled,
		HelperReady:     helperReady,
		DiskFree:        free,
		DiskTotal:       total,
	}
	if installed {
		path := cfg.ComfyPath
		state.Path = &path
		state.Commit = gitCommit(cfg)
	}
	if stats != nil {
		state.Version = comfyVersion(stats)
	}
	return state
}

// ---------------------------------------------------------------- install

// DetectAccelerator asks the machine which torch wheels it wants.
func DetectAccelerator() string {
	if probe("nvidia-smi", "-L") {
		return "cuda"
	}
	if probe("rocminfo") {
		return "rocm"
	}
	return "cpu"
}

func probe(command string, args ...string) bool {
	cmd := exec.Command(command, args...)
	hideConsole(cmd)
	return cmd.Run() == nil
}

// torchIndex is the pip index for each vendor.
func torchIndex(accelerator string) string {
	switch accelerator {
	case "rocm":
		return "https://download.pytorch.org/whl/rocm6.2"
	case "cpu":
		return "https://download.pytorch.org/whl/cpu"
	}
	return "https://download.pytorch.org/whl/cu124"
}

func systemPython(task *Task) (string, error) {
	candidates := []string{"python3", "python"}
	if runtime.GOOS == "windows" {
		candidates = []string{"python", "py"}
	}
	for _, candidate := range candidates {
		if probe(candidate, "--version") {
			task.Appendf("using %s to create the virtual environment", candidate)
			return candidate, nil
		}
	}
	return "", errors.New(
		"No Python found on this machine. Install Python 3.10 or newer from https://python.org, " +
			"make sure it is on PATH, then try again.")
}

// InstallComfy clones ComfyUI, builds its venv and installs its dependencies.
//
// Idempotent by design: an existing checkout is updated rather than refused, and
// an existing venv is reused, so re-running after a failure part-way through
// picks up where it stopped instead of demanding a clean machine.
func InstallComfy(cfg *Config, task *Task, accelerator string) (string, error) {
	if accelerator == "" || accelerator == "auto" {
		accelerator = DetectAccelerator()
	}
	task.Appendf("installing ComfyUI into %s for %s", cfg.ComfyPath, accelerator)

	if err := os.MkdirAll(cfg.Home, 0o700); err != nil {
		return "", err
	}

	if exists(filepath.Join(cfg.ComfyPath, ".git")) {
		task.Append("a checkout is already there; updating it instead of cloning")
		if err := Run(task, cfg.ComfyPath, os.Environ(), "git", "pull", "--ff-only"); err != nil {
			return "", err
		}
	} else {
		if info, err := os.Stat(cfg.ComfyPath); err == nil && info.IsDir() {
			task.Appendf("%s exists but is not a git checkout; cloning into it", cfg.ComfyPath)
		}
		if err := Run(task, "", os.Environ(), "git", "clone", "--depth", "1", comfyRepo, cfg.ComfyPath); err != nil {
			return "", err
		}
	}

	if !exists(venvPython(cfg)) {
		python, err := systemPython(task)
		if err != nil {
			return "", err
		}
		if err := Run(task, "", os.Environ(), python, "-m", "venv", venvPath(cfg)); err != nil {
			return "", err
		}
	} else {
		task.Append("virtual environment already exists; reusing it")
	}

	python := venvPython(cfg)
	if err := Run(task, "", os.Environ(), python, "-m", "pip", "install", "--upgrade", "pip", "wheel"); err != nil {
		return "", err
	}
	if err := Run(task, "", os.Environ(), python, "-m", "pip", "install",
		"torch", "torchvision", "torchaudio", "--index-url", torchIndex(accelerator)); err != nil {
		return "", err
	}
	if err := Run(task, cfg.ComfyPath, os.Environ(), python, "-m", "pip", "install", "-r", "requirements.txt"); err != nil {
		return "", err
	}

	task.Append("ComfyUI installed.")
	return accelerator, nil
}

// UpdateComfy is `git pull` plus a dependency refresh. It does not restart; the
// caller decides.
func UpdateComfy(cfg *Config, task *Task) error {
	if !exists(filepath.Join(cfg.ComfyPath, ".git")) {
		return fmt.Errorf("No ComfyUI checkout at %s. Install it first.", cfg.ComfyPath)
	}
	if err := Run(task, cfg.ComfyPath, os.Environ(), "git", "pull", "--ff-only"); err != nil {
		return err
	}
	if err := Run(task, cfg.ComfyPath, os.Environ(), venvPython(cfg),
		"-m", "pip", "install", "-r", "requirements.txt"); err != nil {
		return err
	}
	task.Append("ComfyUI updated.")
	return nil
}

// ---------------------------------------------------------------- run control

// PowerResult is what a start or stop answers with.
//
// Started and Stopped are pointers so that `false` survives the encoder: with a
// plain bool and omitempty, "I did not start it, and here is why" would go out
// as a body carrying only a reason, and rippel's panel reads the flag.
type PowerResult struct {
	Started *bool  `json:"started,omitempty"`
	Stopped *bool  `json:"stopped,omitempty"`
	PID     int    `json:"pid,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

func yes() *bool { t := true; return &t }
func no() *bool  { f := false; return &f }

// StartComfy spawns ComfyUI detached, listening on every interface.
//
// --listen 0.0.0.0 is not optional here: the whole point of a deployment is that
// rippel is on another machine. ComfyUI has no authentication of its own, which
// is why the README is emphatic that it belongs on a LAN.
func StartComfy(cfg *Config) (PowerResult, error) {
	if !exists(filepath.Join(cfg.ComfyPath, "main.py")) {
		return PowerResult{}, fmt.Errorf("No ComfyUI at %s. Install it first.", cfg.ComfyPath)
	}
	if ComfyStatus(cfg).Running {
		return PowerResult{Started: no(), Reason: "already running"}, nil
	}

	if err := os.MkdirAll(cfg.Home, 0o700); err != nil {
		return PowerResult{}, err
	}
	logFile, err := os.OpenFile(ComfyLogFile(cfg), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return PowerResult{}, fmt.Errorf("could not open %s: %w", ComfyLogFile(cfg), err)
	}
	defer logFile.Close()

	args := []string{"main.py", "--listen", "0.0.0.0", "--port", strconv.Itoa(cfg.ComfyPort)}
	args = append(args, strings.Fields(cfg.ComfyArgs)...)

	cmd := exec.Command(venvPython(cfg), args...)
	cmd.Dir = cfg.ComfyPath
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	// The storage helper reads its token from ComfyUI's own environment, so it
	// has to be set on the process we start, not on the agent.
	cmd.Env = os.Environ()
	if cfg.StorageToken != "" {
		cmd.Env = append(cmd.Env, "RIPPEL_STORAGE_TOKEN="+cfg.StorageToken)
	}
	detach(cmd)

	if err := cmd.Start(); err != nil {
		return PowerResult{}, fmt.Errorf("could not start ComfyUI: %w", err)
	}
	// Release the child rather than waiting on it: it is meant to outlive us,
	// and an un-reaped child would otherwise sit as a zombie for the agent's
	// whole lifetime.
	pid := cmd.Process.Pid
	_ = cmd.Process.Release()

	if err := os.WriteFile(pidFile(cfg), []byte(strconv.Itoa(pid)), 0o600); err != nil {
		return PowerResult{}, err
	}
	return PowerResult{Started: yes(), PID: pid}, nil
}

// StopComfy stops it, politely first.
//
// If ComfyUI is answering on its port but the agent did not start it, the agent
// refuses to stop it and says so — killing a process someone else started is
// not the agent's to do.
func StopComfy(cfg *Config, grace time.Duration) (PowerResult, error) {
	pid := readPid(cfg)
	if pid == 0 || !processAlive(pid) {
		_ = os.Remove(pidFile(cfg))
		if ComfyStatus(cfg).Running {
			return PowerResult{}, errors.New(
				"ComfyUI is answering on its port but was not started by this agent, " +
					"so the agent will not stop it. Stop it where it was started.")
		}
		return PowerResult{Stopped: no(), Reason: "not running"}, nil
	}

	terminateProcess(pid)
	deadline := time.Now().Add(grace)
	for processAlive(pid) && time.Now().Before(deadline) {
		time.Sleep(250 * time.Millisecond)
	}
	if processAlive(pid) {
		killProcess(pid)
	}
	_ = os.Remove(pidFile(cfg))
	return PowerResult{Stopped: yes(), PID: pid}, nil
}

// ---------------------------------------------------------------- helper node

// HelperFile is one Python file of the storage helper, as rippel sends it.
type HelperFile struct {
	Name    string `json:"name"`
	Content string `json:"content"`
}

// InstallHelper puts comfyui-rippel-storage into custom_nodes.
//
// The source comes from the rippel server rather than being carried in the
// agent, so the helper always matches the rippel that will call it — a
// mismatched pair is the one failure this whole panel exists to prevent, and
// shipping a copy inside the agent guarantees one the first time either side
// changes.
//
// The token is written into the ComfyUI launch environment rather than the
// helper's source, because that is where the helper reads it from and because a
// token in a file under custom_nodes would end up in whatever backup or
// screenshot that folder does.
func InstallHelper(cfg *Config, task *Task, files []HelperFile) (string, error) {
	// The names come from the server, but the guard runs before anything is
	// touched: nothing a request can say should reach the filesystem as a path.
	for _, file := range files {
		if strings.Contains(file.Name, "..") ||
			strings.ContainsAny(file.Name, `/\`) ||
			file.Name == "" {
			return "", fmt.Errorf("Refusing to write a helper file named %q.", file.Name)
		}
	}
	if !exists(filepath.Join(cfg.ComfyPath, "custom_nodes")) {
		return "", fmt.Errorf("No ComfyUI at %s. Install it first.", cfg.ComfyPath)
	}

	dir := filepath.Join(cfg.ComfyPath, "custom_nodes", HelperDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	for _, file := range files {
		if err := os.WriteFile(filepath.Join(dir, file.Name), []byte(file.Content), 0o644); err != nil {
			return "", err
		}
		task.Appendf("wrote custom_nodes/%s/%s", HelperDir, file.Name)
	}
	task.Append("Storage helper installed. ComfyUI must restart to pick it up.")
	return dir, nil
}

// TailComfyLog returns the last n lines of ComfyUI's own output, which is what
// anyone reading a log after a failed start actually wants.
func TailComfyLog(cfg *Config, n int) []string {
	raw, err := os.ReadFile(ComfyLogFile(cfg))
	if err != nil {
		return []string{}
	}
	lines := []string{}
	for _, line := range strings.Split(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		lines = append(lines, line)
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines
}
