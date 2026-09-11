package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPublicModelAddressesRejectLocalNetworks(t *testing.T) {
	for _, raw := range []string{"127.0.0.1", "10.0.0.1", "172.16.1.1", "192.168.1.1", "169.254.169.254", "::1", "fc00::1", "fe80::1", "100.64.0.1", "0.0.0.0"} {
		if publicModelIP(net.ParseIP(raw)) {
			t.Fatal(raw)
		}
	}
	for _, raw := range []string{"1.1.1.1", "2606:4700:4700::1111"} {
		if !publicModelIP(net.ParseIP(raw)) {
			t.Fatal(raw)
		}
	}
	if _, err := publicModelDial(context.Background(), "tcp", "127.0.0.1:443"); err == nil {
		t.Fatal("dialed loopback")
	}
}

func TestModelHostApprovalPersistsExactPendingHost(t *testing.T) {
	cfg := testConfig(t)
	t.Setenv("RIPPEL_AGENT_HOME", cfg.Home)
	agent := NewAgent(cfg, nil)
	task := agent.tasks.Create("model-files")
	done := make(chan error, 1)
	go func() { done <- task.waitHostApproval(context.Background(), "cdn.example.com", time.Second) }()
	deadline := time.Now().Add(time.Second)
	for task.snapshot(0).ApprovalRequired == nil && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	call := func(body string) int {
		req := httptest.NewRequest("POST", "/agent/tasks/"+task.ID+"/host-approval", strings.NewReader(body))
		req.Header.Set("X-Rippel-Agent-Token", cfg.Token)
		res := httptest.NewRecorder()
		agent.Handler().ServeHTTP(res, req)
		return res.Code
	}
	if code := call(`{"hostname":"wrong.example.com","approve":true}`); code != 409 {
		t.Fatal(code)
	}
	if code := call(`{"hostname":"cdn.example.com","approve":true}`); code != 200 {
		t.Fatal(code)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if code := call(`{"hostname":"cdn.example.com","approve":true}`); code != 409 {
		t.Fatal(code)
	}
	raw, err := os.ReadFile(filepath.Join(cfg.Home, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "cdn.example.com") {
		t.Fatal(string(raw))
	}
	if len(agent.config().ApprovedModelHosts) != 1 {
		t.Fatal("approval not applied")
	}
}

func TestModelHostApprovalDenialAndTimeout(t *testing.T) {
	for _, deny := range []bool{false, true} {
		cfg := testConfig(t)
		t.Setenv("RIPPEL_AGENT_HOME", cfg.Home)
		agent := NewAgent(cfg, nil)
		task := agent.tasks.Create("model-files")
		done := make(chan error, 1)
		go func() { done <- task.waitHostApproval(context.Background(), "cdn.example.com", 30*time.Millisecond) }()
		if deny {
			deadline := time.Now().Add(time.Second)
			for task.snapshot(0).ApprovalRequired == nil && time.Now().Before(deadline) {
				time.Sleep(time.Millisecond)
			}
			req := httptest.NewRequest("POST", "/agent/tasks/"+task.ID+"/host-approval", strings.NewReader(`{"hostname":"cdn.example.com","approve":false}`))
			req.Header.Set("X-Rippel-Agent-Token", cfg.Token)
			res := httptest.NewRecorder()
			agent.Handler().ServeHTTP(res, req)
			if res.Code != 200 {
				t.Fatal(res.Code)
			}
		}
		if err := <-done; err == nil {
			t.Fatal("unexpected approval")
		}
		if task.snapshot(0).ApprovalRequired != nil {
			t.Fatal("pending approval leaked")
		}
		if exists(filepath.Join(cfg.Home, "config.json")) {
			t.Fatal("saved unapproved host")
		}
	}
}

func TestDownloadErrorsDoNotExposeSignedURLs(t *testing.T) {
	cfg, task, _ := modelTest(t)
	client := modelHTTPClient(modelRoundTrip(func(*http.Request) (*http.Response, error) {
		return nil, fmt.Errorf("bad location https://cdn.example.com/weights?token=SECRET")
	}))
	err := downloadModel(cfg, task, modelBody("weights"), client)
	if err == nil || strings.Contains(err.Error(), "SECRET") || strings.Contains(err.Error(), "https://") {
		t.Fatal(err)
	}
}

// An isolated DNS answer makes CheckRedirect coverage independent of public DNS.
func TestRedirectWaitsForApprovalBeforeContinuing(t *testing.T) {
	socket, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()
	go func() {
		buf := make([]byte, 512)
		for {
			n, addr, err := socket.ReadFrom(buf)
			if err != nil {
				return
			}
			if n < 12 {
				continue
			}
			end := 12
			for end < n && buf[end] != 0 {
				end += int(buf[end]) + 1
			}
			end += 5
			if end > n {
				continue
			}
			query := append([]byte(nil), buf[:end]...)
			query[10] = 0
			query[11] = 0
			// Echo the question, return one A record and no IPv6 records.
			query[2] = 0x81
			query[3] = 0x80
			query[6] = 0
			query[7] = 0
			if end >= 4 && query[end-4] == 0 && query[end-3] == 1 {
				query[7] = 1
				query = append(query, 0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4, 1, 1, 1, 1)
			}
			socket.WriteTo(query, addr)
		}
	}()
	previous := net.DefaultResolver
	net.DefaultResolver = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "udp", socket.LocalAddr().String())
	}}
	defer func() { net.DefaultResolver = previous }()
	cfg := testConfig(t)
	t.Setenv("RIPPEL_AGENT_HOME", cfg.Home)
	agent := NewAgent(cfg, nil)
	task := agent.tasks.Create("model-files")
	client := agent.approvalModelClient(task)
	defer client.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", "https://cdn.example.com/weights?token=SECRET", nil)
	done := make(chan error, 1)
	go func() { done <- client.CheckRedirect(req, []*http.Request{{}}) }()
	deadline := time.Now().Add(time.Second)
	for task.snapshot(0).ApprovalRequired == nil && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if task.snapshot(0).ApprovalRequired == nil {
		t.Fatal("redirect did not request approval")
	}
	select {
	case err := <-done:
		t.Fatalf("redirect continued before approval: %v", err)
	default:
	}
	approve := httptest.NewRequest("POST", "/agent/tasks/"+task.ID+"/host-approval", strings.NewReader(`{"hostname":"cdn.example.com","approve":true}`))
	approve.Header.Set("X-Rippel-Agent-Token", cfg.Token)
	res := httptest.NewRecorder()
	agent.Handler().ServeHTTP(res, approve)
	if res.Code != 200 {
		t.Fatal(res.Code)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("redirect did not resume")
	}
	// A second request uses the persisted approval, without another prompt.
	if err := client.CheckRedirect(req, []*http.Request{{}}); err != nil {
		t.Fatal(err)
	}
	if task.snapshot(0).ApprovalRequired != nil {
		t.Fatal("requested duplicate approval")
	}
}
