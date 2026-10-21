package main

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestTunnelAddress(t *testing.T) {
	for _, pair := range [][2]string{{"https://rippel.example", "wss://rippel.example/api/deployments/tunnel"}, {"http://localhost:4000/prefix/", "ws://localhost:4000/prefix/api/deployments/tunnel"}} {
		got, err := tunnelAddress(pair[0])
		if err != nil || got != pair[1] {
			t.Fatalf("%q %v", got, err)
		}
	}
	for _, bad := range []string{"https://user:secret@example.com", "ftp://example.com", "https://example.com?token=secret"} {
		if _, err := tunnelAddress(bad); err == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
}
func TestTunnelLocalEngineAndTargetRestriction(t *testing.T) {
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "tunnel response") }))
	defer engine.Close()
	port, _ := strconv.Atoi(strings.Split(engine.URL, ":")[2])
	result := make(chan error, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			result <- err
			return
		}
		defer ws.Close()
		_ = ws.SetReadDeadline(time.Now().Add(5 * time.Second))
		// Unknown targets cannot turn the tunnel into an arbitrary port forwarder.
		_ = ws.WriteJSON(tunnelFrame{Type: "open", ID: "bad", Target: "database"})
		var frame tunnelFrame
		if err = ws.ReadJSON(&frame); err != nil {
			result <- err
			return
		}
		if frame.Type != "close" {
			t.Errorf("unknown target was not refused")
		}
		_ = ws.WriteJSON(tunnelFrame{Type: "open", ID: "good", Target: "engine"})
		if err = ws.ReadJSON(&frame); err != nil {
			result <- err
			return
		}
		if frame.Type != "opened" {
			t.Errorf("engine did not open")
		}
		data := base64.StdEncoding.EncodeToString([]byte("GET /system_stats HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"))
		_ = ws.WriteJSON(tunnelFrame{Type: "data", ID: "good", Data: data})
		body := ""
		for {
			if err = ws.ReadJSON(&frame); err != nil {
				result <- err
				return
			}
			if frame.Type == "data" {
				decoded, _ := base64.StdEncoding.DecodeString(frame.Data)
				body += string(decoded)
				_ = ws.WriteJSON(tunnelFrame{Type: "ack", ID: "good"})
			}
			if frame.Type == "end" {
				break
			}
		}
		if !strings.Contains(body, "tunnel response") {
			t.Errorf("missing response: %s", body)
		}
		result <- nil
	}))
	defer upstream.Close()
	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(upstream.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	runTunnel(context.Background(), ws, func() *Config { return &Config{ComfyPort: port} })
	if err = <-result; err != nil {
		t.Fatal(err)
	}
}

func TestTunnelConcurrentChannels(t *testing.T) {
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, r.URL.Path) }))
	defer engine.Close()
	port, _ := strconv.Atoi(strings.Split(engine.URL, ":")[2])
	result := make(chan error, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			result <- err
			return
		}
		defer ws.Close()
		ws.SetReadDeadline(time.Now().Add(5 * time.Second))
		for i := 0; i < 10; i++ {
			ws.WriteJSON(tunnelFrame{Type: "open", ID: strconv.Itoa(i), Target: "engine"})
		}
		bodies := map[string]string{}
		finished := 0
		for finished < 10 {
			var f tunnelFrame
			if err := ws.ReadJSON(&f); err != nil {
				result <- err
				return
			}
			switch f.Type {
			case "opened":
				ws.WriteJSON(tunnelFrame{Type: "data", ID: f.ID, Data: base64.StdEncoding.EncodeToString([]byte("GET /" + f.ID + " HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"))})
			case "data":
				b, _ := base64.StdEncoding.DecodeString(f.Data)
				bodies[f.ID] += string(b)
				ws.WriteJSON(tunnelFrame{Type: "ack", ID: f.ID})
			case "end":
				finished++
				if !strings.Contains(bodies[f.ID], "/"+f.ID) {
					t.Errorf("missing response %s: %s", f.ID, bodies[f.ID])
				}
			case "close":
				t.Errorf("unexpected close %s", f.ID)
				finished++
			}
		}
		result <- nil
	}))
	defer upstream.Close()
	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(upstream.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	runTunnel(context.Background(), ws, func() *Config { return &Config{ComfyPort: port} })
	if err := <-result; err != nil {
		t.Fatal(err)
	}
}

func TestTunnelReconnectsAfterServerCloses(t *testing.T) {
	connections := make(chan struct{}, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err != nil {
			return
		}
		connections <- struct{}{}
		ws.Close()
	}))
	defer server.Close()
	stop := StartTunnel(NewAgent(&Config{ServerURL: server.URL}, nil), func(string, ...any) {})
	defer stop()
	for i := 0; i < 2; i++ {
		select {
		case <-connections:
		case <-time.After(5 * time.Second):
			t.Fatal("agent did not reconnect")
		}
	}
}
