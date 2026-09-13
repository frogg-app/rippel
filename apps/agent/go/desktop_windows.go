//go:build windows

package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

//go:embed tray.ps1
var trayScript []byte

type desktopAddress struct {
	URL   string `json:"url"`
	Token string `json:"token"`
}

func prepareBackground() {
	// Detach even when an older Run key invokes the console-subsystem binary.
	kernel32.NewProc("FreeConsole").Call()
	_ = os.MkdirAll(AgentHome(), 0700)
	if log, err := os.OpenFile(filepath.Join(AgentHome(), "agent.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600); err == nil {
		os.Stdout, os.Stderr = log, log
	}
}

func openInstalledPanel() bool {
	cfg, err := LoadConfig()
	if err != nil || cfg.Token == "" {
		return false
	}
	var address desktopAddress
	raw, err := os.ReadFile(filepath.Join(cfg.Home, "desktop.json"))
	if err == nil && json.Unmarshal(raw, &address) == nil {
		req, err := http.NewRequest(http.MethodPost, address.URL+"/show", bytes.NewReader(nil))
		if err == nil {
			req.Header.Set("X-Rippel-Desktop-Token", address.Token)
			res, err := (&http.Client{Timeout: 2 * time.Second}).Do(req)
			if err == nil {
				res.Body.Close()
				if res.StatusCode == 200 {
					return true
				}
			}
		}
	}
	if reachable(cfg.Host, cfg.Port) {
		prepareForeground("status", 1)
		return false
	}
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	startNow(exe, serviceLog)
	return true
}

func startDesktop(a *Agent, quit func()) (func(), error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		listener.Close()
		return nil, err
	}
	address := desktopAddress{"http://" + listener.Addr().String(), hex.EncodeToString(secret)}
	home := a.config().Home
	path := filepath.Join(home, "tray.ps1")
	if err := os.WriteFile(path, trayScript, 0600); err != nil {
		listener.Close()
		return nil, err
	}
	raw, _ := json.Marshal(address)
	if err := os.WriteFile(filepath.Join(home, "desktop.json"), raw, 0600); err != nil {
		listener.Close()
		return nil, err
	}
	var show atomic.Bool
	var once sync.Once
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if !tokenMatches(r.Header.Get("X-Rippel-Desktop-Token"), address.Token) {
			writeError(w, 401, "unauthorized", "Desktop token required.")
			return
		}
		switch {
		case r.Method == "GET" && r.URL.Path == "/status":
			a.desktopStatus(w)
		case r.Method == "GET" && r.URL.Path == "/show":
			writeJSON(w, 200, map[string]bool{"show": show.Swap(false)})
		case r.Method == "POST" && r.URL.Path == "/show":
			show.Store(true)
			writeJSON(w, 200, map[string]bool{"ok": true})
		case r.Method == "POST" && (r.URL.Path == "/pause" || r.URL.Path == "/resume"):
			if err := a.setPaused(r.URL.Path == "/pause"); err != nil {
				writeError(w, 500, "save_failed", err.Error())
				return
			}
			writeJSON(w, 200, map[string]bool{"ok": true})
		case r.Method == "POST" && r.URL.Path == "/quit":
			a.control.Lock()
			defer a.control.Unlock()
			for _, task := range a.tasks.List() {
				if task.snapshot(0).Status == "running" {
					writeError(w, 409, "busy", "Wait for maintenance tasks to finish before quitting.")
					return
				}
			}
			writeJSON(w, 200, map[string]bool{"ok": true})
			a.paused = true
			once.Do(quit)
		default:
			writeError(w, 404, "not_found", "Unknown desktop action.")
		}
	})
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second}
	go server.Serve(listener)
	stop := make(chan struct{})
	var processMu sync.Mutex
	var process *os.Process
	go func() {
		for {
			cmd := exec.Command("powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", path)
			cmd.Env = append(os.Environ(), "RIPPEL_DESKTOP_URL="+address.URL, "RIPPEL_DESKTOP_TOKEN="+address.Token, "RIPPEL_DESKTOP_PARENT="+strconv.Itoa(os.Getpid()))
			cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
			hideConsole(cmd)
			processMu.Lock()
			select {
			case <-stop:
				processMu.Unlock()
				return
			default:
			}
			err := cmd.Start()
			if err == nil {
				process = cmd.Process
			}
			processMu.Unlock()
			if err == nil {
				err = cmd.Wait()
			}
			select {
			case <-stop:
				return
			default:
			}
			serviceLog("tray exited (%v); retrying in 10 seconds", err)
			select {
			case <-stop:
				return
			case <-time.After(10 * time.Second):
			}
		}
	}()
	return func() {
		close(stop)
		server.Close()
		processMu.Lock()
		if process != nil {
			_ = process.Kill()
		}
		processMu.Unlock()
		_ = os.Remove(filepath.Join(home, "desktop.json"))
	}, nil
}

// GUI-subsystem releases never create a console at login. Setup and CLI
// commands attach to the invoking shell, or allocate a setup console.
func prepareForeground(command string, argc int) {
	if command == "run" {
		return
	}
	if command == "" && argc == 0 {
		if cfg, err := LoadConfig(); err == nil && cfg.Token != "" {
			return
		}
	}
	attached, _, _ := kernel32.NewProc("AttachConsole").Call(0xffffffff)
	if attached == 0 {
		kernel32.NewProc("AllocConsole").Call()
	}
	if _, err := os.Stdout.Stat(); err != nil {
		if f, err := os.OpenFile("CONOUT$", os.O_WRONLY, 0); err == nil {
			os.Stdout = f
		}
	}
	if _, err := os.Stderr.Stat(); err != nil {
		os.Stderr = os.Stdout
	}
	if _, err := os.Stdin.Stat(); err != nil {
		if f, err := os.Open("CONIN$"); err == nil {
			os.Stdin = f
			stdin = bufio.NewReader(f)
		}
	}
}
