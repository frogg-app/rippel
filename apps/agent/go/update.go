package main

// Agent updates are executable code, so the caller supplies no URL or command.
// Fetch only this agent's platform binary from its configured rippel server,
// require a SHA-256, stage beside the installed binary and preserve config.
import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const maxAgentUpdateBytes int64 = 64 << 20

// releaseDesktop closes the tray before the agent exits for an update. os.Exit
// skips the run loop's deferred cleanup, which left the old tray showing "Lost
// the agent" beside the new one. Set by run once the desktop is up.
var releaseDesktop = func() {}

type AgentUpdateRequest struct {
	SHA256 string `json:"sha256"`
}

func agentUpdateURL(cfg *Config) (string, error) {
	base, err := url.Parse(cfg.ServerURL)
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" || cfg.DeploymentID == "" {
		return "", fmt.Errorf("Agent must be enrolled with a configured rippel server before updating")
	}
	platform := runtime.GOOS
	if platform == "darwin" {
		platform = "macos"
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/api/deployments/" + url.PathEscape(cfg.DeploymentID) + "/agent/" + platform + "-" + runtime.GOARCH
	return base.String(), nil
}

// progress, when set, is told how much of the binary has arrived.
func stageAgentUpdate(cfg *Config, request AgentUpdateRequest, client *http.Client, progress func(received, total int64)) (string, error) {
	digest, err := hex.DecodeString(request.SHA256)
	if err != nil || len(digest) != sha256.Size {
		return "", fmt.Errorf("A file SHA-256 is required")
	}
	address, err := agentUpdateURL(cfg)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequest(http.MethodGet, address, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("X-Rippel-Agent-Token", cfg.Token)
	// Never leak the agent token through redirects, including a changed server.
	safeClient := *client
	safeClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return fmt.Errorf("Agent binary redirects are refused")
	}
	response, err := safeClient.Do(req)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("Agent binary returned HTTP %d", response.StatusCode)
	}
	if response.ContentLength > maxAgentUpdateBytes {
		return "", fmt.Errorf("Agent binary exceeds 64 MiB")
	}
	if err := os.MkdirAll(cfg.Home, 0700); err != nil {
		return "", err
	}
	suffix := ""
	if runtime.GOOS == "windows" {
		suffix = ".exe"
	}
	file, err := os.CreateTemp(cfg.Home, ".rippel-update-*"+suffix)
	if err != nil {
		return "", err
	}
	path := file.Name()
	ok := false
	defer func() {
		file.Close()
		if !ok {
			os.Remove(path)
		}
	}()
	hash := sha256.New()
	var sink io.Writer = io.MultiWriter(file, hash)
	if progress != nil {
		sink = &progressWriter{inner: sink, total: response.ContentLength, report: progress}
	}
	count, err := io.Copy(sink, io.LimitReader(response.Body, maxAgentUpdateBytes+1))
	if err != nil {
		return "", err
	}
	if count == 0 || count > maxAgentUpdateBytes {
		return "", fmt.Errorf("Invalid agent binary size")
	}
	if hex.EncodeToString(hash.Sum(nil)) != strings.ToLower(request.SHA256) {
		return "", fmt.Errorf("Agent binary SHA-256 mismatch")
	}
	if err := file.Sync(); err != nil {
		return "", err
	}
	if err := file.Close(); err != nil {
		return "", err
	}
	if err := os.Chmod(path, 0700); err != nil {
		return "", err
	}
	ok = true
	return path, nil
}
func launchAgentUpdate(cfg *Config, staged string) error {
	target, err := os.Executable()
	if err != nil {
		return err
	}
	if runtime.GOOS == "windows" && filepath.Clean(target) != filepath.Clean(InstalledPath()) {
		return fmt.Errorf("Install the agent into its managed directory before self-updating")
	}
	// Validate the new executable can run on this OS before changing anything.
	probe := exec.Command(staged, "version")
	hideConsole(probe)
	data, err := probe.Output()
	if err != nil || !strings.Contains(strings.ToLower(string(data)), "rippel") {
		return fmt.Errorf("Downloaded binary did not identify itself as a runnable rippel agent")
	}
	if runtime.GOOS != "windows" {
		// Rename is atomic on Unix. The existing service supervisor restarts the
		// same path after exit; manual runs re-exec it via a detached child.
		if err := os.Rename(staged, target); err != nil {
			return err
		}
		go func() { time.Sleep(time.Second); _ = replaceAgentProcess(target); os.Exit(0) }()
		return nil
	}
	helper := exec.Command(staged, "apply-update", strconv.Itoa(os.Getpid()), target)
	helper.Env = append(os.Environ(), "RIPPEL_AGENT_HOME="+cfg.Home)
	detach(helper)
	log, err := os.OpenFile(filepath.Join(cfg.Home, "agent-update.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer log.Close()
	helper.Stdout = log
	helper.Stderr = log
	if err := helper.Start(); err != nil {
		return err
	}
	_ = helper.Process.Release()
	go func() { time.Sleep(time.Second); releaseDesktop(); os.Exit(0) }()
	return nil
}

// Runs from the staged Windows binary after the old process has exited.
func applyAgentUpdate(args []string) error {
	if len(args) != 2 {
		return fmt.Errorf("Invalid update handoff")
	}
	pid, err := strconv.Atoi(args[0])
	if err != nil || pid <= 0 {
		return fmt.Errorf("Invalid previous agent pid")
	}
	source, err := os.Executable()
	if err != nil {
		return err
	}
	target := args[1]
	if filepath.Clean(filepath.Dir(source)) != filepath.Clean(AgentHome()) || filepath.Clean(target) != filepath.Clean(InstalledPath()) {
		return fmt.Errorf("Update handoff must remain in the agent installation directory")
	}
	deadline := time.Now().Add(30 * time.Second)
	for processAlive(pid) && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	if processAlive(pid) {
		return fmt.Errorf("Previous agent did not exit")
	}
	// The helper itself is running from source, so copy to a sibling temporary
	// file, then atomically publish. Config and ComfyUI are never rewritten.
	data, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	next := target + ".next"
	if err := os.WriteFile(next, data, 0700); err != nil {
		return err
	}
	defer os.Remove(next)
	if err := os.Rename(next, target); err != nil {
		return err
	}
	// The startup entry is a per-user Run key now, not a scheduled task, so there
	// is nothing to ask to restart: launch the new binary the way install does,
	// detached and without a console window.
	cmd := exec.Command(target, "run")
	cmd.Env = os.Environ()
	hideConsole(cmd)
	detach(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
func (a *Agent) updateAgent(w http.ResponseWriter, r *http.Request) {
	var request AgentUpdateRequest
	if err := readBody(r, &request); err != nil {
		writeError(w, 400, "bad_request", err.Error())
		return
	}
	a.beginAgentUpdate(w, request)
}

// beginAgentUpdate downloads, verifies and switches to the binary with the
// given digest, as a task whose byte counts show the download's progress.
func (a *Agent) beginAgentUpdate(w http.ResponseWriter, request AgentUpdateRequest) {
	a.begin(w, "update-agent", func(task *Task) error {
		cfg := a.config()
		staged, err := stageAgentUpdate(cfg, request, &http.Client{Timeout: 5 * time.Minute}, task.setBytes)
		if err != nil {
			return err
		}
		task.Append("Verified agent binary. Restarting the agent; ComfyUI stays running.")
		if err := launchAgentUpdate(cfg, staged); err != nil {
			os.Remove(staged)
			return err
		}
		return nil
	})
}

type progressWriter struct {
	inner    io.Writer
	total    int64
	received int64
	report   func(received, total int64)
}

func (p *progressWriter) Write(b []byte) (int, error) {
	n, err := p.inner.Write(b)
	p.received += int64(n)
	p.report(p.received, max(p.total, 0))
	return n, err
}
