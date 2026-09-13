package main

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The agent's HTTP API.
//
// Small on purpose: rippel is the only client, there is one credential, and
// every route is either a question about this machine or an instruction to
// change it.
//
// Authentication is one shared token, compared in constant time, required on
// every route including the ping. There is no "harmless" route here: knowing
// whether an agent is listening is already worth something to a scanner, and a
// token check costs nothing.

// maxBody is the longest body the agent will read. Helper sources are the only
// large one.
const maxBody = 1024 * 1024

// Agent holds the mutable state the routes share: the config (which /agent/config
// can change under a running server) and the task registry.
type Agent struct {
	control    sync.RWMutex
	paused     bool
	connection ConnectionState
	mu         sync.RWMutex
	cfg        *Config
	tasks      *Tasks
	onChange   func()
}

func NewAgent(cfg *Config, onChange func()) *Agent {
	if onChange == nil {
		onChange = func() {}
	}
	_, pausedErr := os.Stat(filepath.Join(cfg.Home, "paused"))
	return &Agent{cfg: cfg, tasks: NewTasks(), onChange: onChange, paused: pausedErr == nil}
}

// config hands out a copy, so a long ComfyUI install reads consistent settings
// even if /agent/config changes them halfway through.
func (a *Agent) config() *Config {
	a.mu.RLock()
	defer a.mu.RUnlock()
	snapshot := *a.cfg
	return &snapshot
}

func (a *Agent) changed() {
	defer func() {
		// A heartbeat that cannot be nudged will happen on its next tick.
		_ = recover()
	}()
	a.onChange()
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		body = []byte(`{"error":"internal","message":"Could not encode the answer."}`)
		status = http.StatusInternalServerError
	}
	w.Header().Set("content-type", "application/json")
	w.Header().Set("content-length", strconv.Itoa(len(body)))
	// Nothing here is for a browser, and this is the cheapest way to say so.
	w.Header().Set("x-content-type-options", "nosniff")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func writeError(w http.ResponseWriter, status int, kind, message string) {
	writeJSON(w, status, map[string]string{"error": kind, "message": message})
}

// tokenMatches compares in constant time. Lengths are compared first because a
// length-dependent comparison would itself leak the length.
func tokenMatches(given, expected string) bool {
	if expected == "" || len(given) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(given), []byte(expected)) == 1
}

func readBody(r *http.Request, into any) error {
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil {
		return fmt.Errorf("could not read the request body: %w", err)
	}
	if len(raw) > maxBody {
		return fmt.Errorf("The request body is too large.")
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, into); err != nil {
		return fmt.Errorf("The request body is not valid JSON.")
	}
	return nil
}

// begin starts a background task, refusing a second of the same kind.
func (a *Agent) begin(w http.ResponseWriter, kind string, work func(*Task) error) {
	if a.tasks.IsRunning(kind) {
		writeError(w, http.StatusConflict, "busy",
			fmt.Sprintf("A %s is already running on this machine.", kind))
		return
	}
	task := a.tasks.Create(kind)
	snapshot := task.snapshot(0)
	writeJSON(w, http.StatusAccepted, map[string]any{"task": snapshot})

	go func() {
		a.tasks.Finish(task, work(task))
	}()
}

// Handler is the agent's whole routing table.
func (a *Agent) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", a.route)
	return mux
}

func (a *Agent) route(w http.ResponseWriter, r *http.Request) {
	cfg := a.config()
	path := strings.TrimRight(r.URL.Path, "/")
	if path == "" {
		path = "/"
	}

	if !tokenMatches(r.Header.Get("X-Rippel-Agent-Token"), cfg.Token) {
		message := "That is not this agent's token."
		if cfg.Token == "" {
			message = "This agent has no token configured, so it refuses every request. " +
				"Set one in config.json and restart it."
		}
		writeError(w, http.StatusUnauthorized, "unauthorized", message)
		return
	}

	// --- questions

	if r.Method == http.MethodGet && path == "/agent/ping" {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":       true,
			"version":  AgentVersion,
			"platform": cfg.Platform,
			"hostname": hostname(),
		})
		return
	}

	if r.Method == http.MethodGet && path == "/agent/status" {
		tasks := []TaskView{}
		for _, task := range a.tasks.List() {
			// The list carries one line each: the panel wants to know what is
			// happening, and the full log is one route away.
			tasks = append(tasks, task.snapshot(1))
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":          true,
			"version":     AgentVersion,
			"platform":    cfg.Platform,
			"hostname":    hostname(),
			"comfy":       ComfyStatus(cfg),
			"accelerator": DetectAccelerator(),
			"tasks":       tasks,
		})
		return
	}

	if r.Method == http.MethodGet && strings.HasPrefix(path, "/agent/tasks/") {
		task := a.tasks.Get(strings.TrimPrefix(path, "/agent/tasks/"))
		if task == nil {
			writeError(w, http.StatusNotFound, "not_found", "No such task.")
			return
		}
		since, _ := strconv.Atoi(r.URL.Query().Get("since"))
		lines, offset := task.logFrom(since)
		snapshot := task.snapshot(-1)
		snapshot.Log = lines
		writeJSON(w, http.StatusOK, map[string]any{"task": snapshot, "logOffset": offset})
		return
	}

	if r.Method == http.MethodGet && path == "/agent/comfyui/log" {
		writeJSON(w, http.StatusOK, map[string]any{"log": TailComfyLog(cfg, 500)})
		return
	}

	// Pause applies to remote management; work already accepted can finish.
	a.control.RLock()
	defer a.control.RUnlock()
	if a.paused && r.Method != http.MethodGet {
		writeError(w, http.StatusServiceUnavailable, "paused", "The owner has paused this agent.")
		return
	}

	// --- instructions

	if r.Method == http.MethodPost && path == "/agent/comfyui/install" {
		var body struct {
			Accelerator string `json:"accelerator"`
		}
		if err := readBody(r, &body); err != nil {
			writeError(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		a.begin(w, "install-comfyui", func(task *Task) error {
			_, err := InstallComfy(a.config(), task, body.Accelerator)
			a.changed()
			return err
		})
		return
	}

	if r.Method == http.MethodPost && path == "/agent/comfyui/update" {
		a.begin(w, "update-comfyui", func(task *Task) error {
			err := UpdateComfy(a.config(), task)
			a.changed()
			return err
		})
		return
	}

	if r.Method == http.MethodPost && strings.HasPrefix(path, "/agent/comfyui/") {
		action := strings.TrimPrefix(path, "/agent/comfyui/")
		if action == "start" || action == "stop" || action == "restart" {
			a.power(w, action)
			return
		}
	}

	if r.Method == http.MethodPost && path == "/agent/helper/install" {
		a.installHelper(w, r)
		return
	}

	if r.Method == http.MethodPost && path == "/agent/config" {
		a.updateConfig(w, r)
		return
	}

	writeError(w, http.StatusNotFound, "not_found",
		fmt.Sprintf("No route for %s %s.", r.Method, path))
}

func (a *Agent) power(w http.ResponseWriter, action string) {
	cfg := a.config()
	var result PowerResult
	var err error

	switch action {
	case "start":
		result, err = StartComfy(cfg)
	case "stop":
		result, err = StopComfy(cfg, 10*time.Second)
	case "restart":
		// A stop that fails because nothing was running is not a reason to
		// refuse the start that follows it.
		_, _ = StopComfy(cfg, 10*time.Second)
		result, err = StartComfy(cfg)
	}

	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	a.changed()
	writeJSON(w, http.StatusOK, result)
}

func (a *Agent) installHelper(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Files        []HelperFile `json:"files"`
		StorageToken string       `json:"storageToken"`
		Restart      *bool        `json:"restart"`
	}
	if err := readBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if len(body.Files) == 0 {
		writeError(w, http.StatusBadRequest, "bad_request", "No helper files were sent.")
		return
	}
	if body.StorageToken == "" {
		writeError(w, http.StatusBadRequest, "bad_request",
			"No storage token was sent, and the helper refuses every request without one.")
		return
	}

	a.begin(w, "install-helper", func(task *Task) error {
		cfg := a.config()
		if _, err := InstallHelper(cfg, task, body.Files); err != nil {
			return err
		}
		// The helper reads its token from ComfyUI's environment, so the agent
		// has to hold it and pass it on the next start.
		a.mu.Lock()
		a.cfg.StorageToken = body.StorageToken
		a.mu.Unlock()
		if err := SaveConfig(map[string]any{"storageToken": body.StorageToken}); err != nil {
			return err
		}

		if body.Restart == nil || *body.Restart {
			if ComfyStatus(a.config()).Running {
				task.Append("restarting ComfyUI so it loads the helper")
				_, _ = StopComfy(a.config(), 10*time.Second)
				if _, err := StartComfy(a.config()); err != nil {
					return err
				}
			}
		}
		a.changed()
		return nil
	})
}

// updateConfig changes the settings a restart is not needed for.
//
// The listening port and the token are deliberately not changeable over the
// wire: one needs a restart to mean anything, and the other would let a stolen
// token rotate itself and lock the operator out.
func (a *Agent) updateConfig(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ServerURL        *string `json:"serverUrl"`
		DeploymentID     *string `json:"deploymentId"`
		ComfyPath        *string `json:"comfyPath"`
		ComfyArgs        *string `json:"comfyArgs"`
		ComfyPort        *int    `json:"comfyPort"`
		HeartbeatSeconds *int    `json:"heartbeatSeconds"`
	}
	if err := readBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}

	patch := map[string]any{}
	a.mu.Lock()
	if body.ServerURL != nil {
		a.cfg.ServerURL = strings.TrimRight(*body.ServerURL, "/")
		patch["serverUrl"] = a.cfg.ServerURL
	}
	if body.DeploymentID != nil {
		a.cfg.DeploymentID = *body.DeploymentID
		patch["deploymentId"] = a.cfg.DeploymentID
	}
	if body.ComfyPath != nil {
		a.cfg.ComfyPath = *body.ComfyPath
		patch["comfyPath"] = a.cfg.ComfyPath
	}
	if body.ComfyArgs != nil {
		a.cfg.ComfyArgs = *body.ComfyArgs
		patch["comfyArgs"] = a.cfg.ComfyArgs
	}
	if body.ComfyPort != nil {
		a.cfg.ComfyPort = *body.ComfyPort
		patch["comfyPort"] = a.cfg.ComfyPort
	}
	if body.HeartbeatSeconds != nil {
		a.cfg.HeartbeatSeconds = *body.HeartbeatSeconds
		patch["heartbeatSeconds"] = a.cfg.HeartbeatSeconds
	}
	a.mu.Unlock()

	if len(patch) > 0 {
		if err := SaveConfig(patch); err != nil {
			writeError(w, http.StatusInternalServerError, "internal", err.Error())
			return
		}
	}
	a.changed()
	writeJSON(w, http.StatusOK, map[string]any{"config": patch})
}

func hostname() string {
	name, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return name
}
