package main

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

func TestPausePersistsAndBlocksRemoteChanges(t *testing.T) {
	cfg := testConfig(t)
	a := NewAgent(cfg, nil)
	if err := a.setPaused(true); err != nil {
		t.Fatal(err)
	}
	a = NewAgent(cfg, nil)
	if !a.isPaused() {
		t.Fatal("pause did not survive restart")
	}
	request := func(method, path string) int {
		r := httptest.NewRequest(method, path, nil)
		r.Header.Set("X-Rippel-Agent-Token", cfg.Token)
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, r)
		return w.Code
	}
	if code := request("POST", "/agent/comfyui/start"); code != 503 {
		t.Fatalf("paused start: %d", code)
	}
	if code := request("GET", "/agent/ping"); code != 200 {
		t.Fatalf("paused ping: %d", code)
	}
	if err := a.setPaused(false); err != nil {
		t.Fatal(err)
	}
	if NewAgent(cfg, nil).isPaused() {
		t.Fatal("resume did not persist")
	}
	if code := request("POST", "/agent/config"); code != 200 {
		t.Fatalf("resumed config: %d", code)
	}
}

func TestQueueOnlyExposesJobIDs(t *testing.T) {
	for _, tc := range []struct {
		body  string
		fails bool
	}{
		{`{"queue_running":[[1,"job-one",{"secret":"prompt"}]],"queue_pending":[[2,"job-two",{}]]}`, false},
		{`{"queue_running":[],"queue_pending":[]}`, false},
		{`{}`, true}, {`{"queue_running":[[1]],"queue_pending":[]}`, true},
	} {
		t.Run(tc.body, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, tc.body) }))
			defer srv.Close()
			_, port, _ := net.SplitHostPort(srv.Listener.Addr().String())
			cfg := testConfig(t)
			cfg.ComfyPort, _ = strconv.Atoi(port)
			queue, err := comfyQueue(cfg)
			if (err != nil) != tc.fails {
				t.Fatalf("queue=%v err=%v", queue, err)
			}
			if err == nil && len(queue["running"]) > 0 && queue["running"][0] != "job-one" {
				t.Fatal(queue)
			}
		})
	}
}

func TestPausedHeartbeatDoesNotCheckIn(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; fmt.Fprint(w, `{}`) }))
	defer srv.Close()
	cfg := testConfig(t)
	cfg.ServerURL = srv.URL
	a := NewAgent(cfg, nil)
	if err := a.setPaused(true); err != nil {
		t.Fatal(err)
	}
	hb := &Heartbeat{agent: a, log: func(string, ...any) {}}
	hb.beat()
	if calls != 0 {
		t.Fatal("paused agent checked in")
	}
	if err := a.setPaused(false); err != nil {
		t.Fatal(err)
	}
	hb.beat()
	if calls != 1 || a.connection.LastSuccess.IsZero() {
		t.Fatal("resumed agent did not record successful check-in")
	}
}
