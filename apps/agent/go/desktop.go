package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

type ConnectionState struct {
	CheckedAt   time.Time `json:"checkedAt"`
	LastSuccess time.Time `json:"lastSuccess"`
	Error       string    `json:"error"`
}

func (a *Agent) isPaused() bool {
	a.control.RLock()
	defer a.control.RUnlock()
	return a.paused
}

func (a *Agent) setPaused(paused bool) error {
	a.control.Lock()
	defer a.control.Unlock()
	path := filepath.Join(a.config().Home, "paused")
	if paused {
		if err := os.WriteFile(path, []byte("paused\n"), 0600); err != nil {
			return err
		}
	} else if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	a.paused = paused
	a.changed()
	return nil
}

// Read only job identifiers, never workflows or prompts, from the local worker.
func comfyQueue(cfg *Config) (map[string][]string, error) {
	client := &http.Client{Timeout: 2 * time.Second}
	res, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/queue", cfg.ComfyPort))
	if err != nil {
		return nil, fmt.Errorf("ComfyUI queue is unavailable")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("ComfyUI queue answered %d", res.StatusCode)
	}
	var body struct {
		Running [][]json.RawMessage `json:"queue_running"`
		Pending [][]json.RawMessage `json:"queue_pending"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&body); err != nil {
		return nil, fmt.Errorf("ComfyUI returned an unreadable queue")
	}
	if body.Running == nil || body.Pending == nil {
		return nil, fmt.Errorf("ComfyUI did not return queue information")
	}
	result := map[string][]string{"running": {}, "pending": {}}
	for key, rows := range map[string][][]json.RawMessage{"running": body.Running, "pending": body.Pending} {
		for _, row := range rows {
			var id string
			if len(row) < 2 || json.Unmarshal(row[1], &id) != nil {
				return nil, fmt.Errorf("ComfyUI returned an unreadable job")
			}
			result[key] = append(result[key], id)
		}
	}
	return result, nil
}

func (a *Agent) desktopStatus(w http.ResponseWriter) {
	cfg := a.config()
	a.mu.RLock()
	connection := a.connection
	a.mu.RUnlock()
	state := "Waiting for first check-in"
	if cfg.ServerURL == "" {
		state = "No server configured"
	} else if !connection.CheckedAt.IsZero() {
		state = "Connected"
		if connection.Error != "" {
			state = "Disconnected"
		} else if time.Since(connection.CheckedAt) > time.Duration(max(5, cfg.HeartbeatSeconds)*2+10)*time.Second {
			state = "Connection status is stale"
		}
	}
	paused := a.isPaused()
	if paused {
		state = "Paused"
	}
	tasks := []TaskView{}
	for _, task := range a.tasks.List() {
		tasks = append(tasks, task.snapshot(1))
	}
	queue, err := comfyQueue(cfg)
	queueError := ""
	if err != nil {
		queueError = err.Error()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"paused": paused, "connection": state, "checkin": connection, "server": cfg.ServerURL,
		"hostname": hostname(), "tasks": tasks, "queue": queue, "queueError": queueError,
		"observedAt": time.Now().UTC(),
	})
}
