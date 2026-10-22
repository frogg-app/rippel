//go:build windows

package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

//go:embed tray.ps1
var trayScript []byte

// The Tauri tray, when the release build put one here. A directory embed so a
// checkout without it still compiles; see traybin/README.md.
//
//go:embed traybin
var trayBin embed.FS

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
	trayCommand, err := trayLauncher(home)
	if err != nil {
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
		case r.Method == "GET" && r.URL.Path == "/logs":
			a.desktopLogs(w)
		case r.Method == "POST" && (r.URL.Path == "/engine/start" || r.URL.Path == "/engine/stop" || r.URL.Path == "/engine/restart"):
			// The owner at the keyboard, so pause does not apply: it stops remote
			// management, not the person the machine belongs to.
			a.power(w, strings.TrimPrefix(r.URL.Path, "/engine/"))
		case r.Method == "POST" && r.URL.Path == "/update/check":
			writeJSON(w, 200, a.checkForUpdate(&http.Client{Timeout: 10 * time.Second}))
		case r.Method == "POST" && r.URL.Path == "/update":
			// The owner asked from the tray, so this is not subject to pause either.
			a.desktopUpdate(w)
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
	go a.watchForUpdates(stop)
	var processMu sync.Mutex
	var process *os.Process
	go func() {
		for {
			cmd := trayCommand()
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

// trayLauncher writes out whichever tray this build carries and returns how to
// start it: the Tauri app when embedded, otherwise the PowerShell script.
func trayLauncher(home string) (func() *exec.Cmd, error) {
	if exe, err := trayBin.ReadFile("traybin/rippel-tray.exe"); err == nil {
		// A fixed path, because Windows remembers whether a tray icon is shown
		// by the path of its exe: a new name per release (tried in 0.4.8–0.4.9)
		// put the icon back in the hidden overflow after every update.
		path := filepath.Join(home, "rippel-tray.exe")
		if current, err := os.ReadFile(path); err != nil || !bytes.Equal(current, exe) {
			if err := writeTray(path, exe); err != nil {
				return nil, err
			}
		}
		// Copies under the per-release names those versions used.
		if old, err := filepath.Glob(filepath.Join(home, "rippel-tray-*.exe")); err == nil {
			for _, stale := range old {
				_ = os.Remove(stale)
			}
		}
		return func() *exec.Cmd { return exec.Command(path) }, nil
	}
	path := filepath.Join(home, "tray.ps1")
	if err := os.WriteFile(path, trayScript, 0600); err != nil {
		return nil, err
	}
	return func() *exec.Cmd {
		return exec.Command("powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", path)
	}, nil
}

// writeTray replaces the tray exe. Windows will not overwrite a running
// executable, and an agent from before 0.4.8 exits for an update without
// closing its tray, so when the write fails, end any running tray and retry.
func writeTray(path string, exe []byte) error {
	err := os.WriteFile(path, exe, 0700)
	for attempt := 0; err != nil && attempt < 10; attempt++ {
		if attempt == 0 {
			kill := exec.Command("taskkill", "/F", "/IM", filepath.Base(path))
			hideConsole(kill)
			_ = kill.Run()
		}
		time.Sleep(500 * time.Millisecond)
		err = os.WriteFile(path, exe, 0700)
	}
	return err
}
