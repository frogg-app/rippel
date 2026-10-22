package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"0.4.4", "0.4.3", 1},
		{"0.4.3", "0.4.3", 0},
		{"0.4.10", "0.4.9", 1},
		{"0.5", "0.5.0", 0},
		{"v1.0.0", "0.9.9", 1},
		{"0.4.2", "0.4.3", -1},
	}
	for _, c := range cases {
		if got := compareVersions(c.a, c.b); got != c.want {
			t.Errorf("compareVersions(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}

func TestCheckForUpdateOffersOnlyNewerVersions(t *testing.T) {
	digest := strings.Repeat("ab", 32)
	for _, tc := range []struct {
		version string
		want    bool
	}{
		{"999.0.0", true},
		{AgentVersion, false},
		{"0.0.1", false},
	} {
		var asked string
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			asked = r.URL.Path
			fmt.Fprintf(w, `{"version":%q,"sha256":%q,"sizeBytes":1}`, tc.version, digest)
		}))
		agent := NewAgent(&Config{ServerURL: server.URL, Home: t.TempDir()}, nil)
		info := agent.checkForUpdate(server.Client())
		server.Close()
		if asked != "/api/deployments/agent/"+agentTarget()+"/latest" {
			t.Fatalf("asked %q", asked)
		}
		if info.Error != "" || info.Available != tc.want || info.Latest == nil || *info.Latest != tc.version {
			t.Errorf("version %s: got %+v, want available=%v", tc.version, info, tc.want)
		}
	}
}

func TestCheckForUpdateReportsAnUnreachableServer(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	agent := NewAgent(&Config{ServerURL: server.URL, Home: t.TempDir()}, nil)
	info := agent.checkForUpdate(server.Client())
	server.Close()
	if info.Error == "" || info.Available || info.CheckedAt == nil {
		t.Errorf("got %+v", info)
	}
}
