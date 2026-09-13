package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// The agent telling rippel it is there.
//
// The direction matters. rippel also calls the agent — that is how installs are
// triggered — but it cannot *discover* one: the machine may be on a different
// subnet, behind NAT, on a laptop that moved, or simply not up yet when rippel
// was. So the agent checks in, and rippel learns the address it checked in
// from. An install that only had to be told the server URL and a token is the
// whole reason the setup link is one line.
//
// Failures here are logged and forgotten. A deployment whose agent cannot reach
// rippel is exactly the "offline" the panel is meant to show, and an agent that
// crashed because the server was restarting would be worse than the problem it
// reported.

// Heartbeat is a running check-in loop.
type Heartbeat struct {
	agent  *Agent
	log    func(string, ...any)
	nudge  chan struct{}
	stop   chan struct{}
	closed sync.Once

	lastError string
}

// checkinBody is the wire shape the /api/deployments/checkin route reads.
type checkinBody struct {
	DeploymentID *string `json:"deploymentId"`
	Version      string  `json:"version"`
	Platform     string  `json:"platform"`
	// Omitted when zero, for the same reason as Comfy below: rippel COALESCEs
	// this column, and 0 is a number, so an install-time probe that sent one
	// would blank the port rippel dials this agent on until the next check-in.
	AgentPort int `json:"agentPort,omitempty"`
	// A pointer, omitted when nil. The install-time probe has not looked at the
	// machine yet, and rippel COALESCEs this column — sending an empty state
	// would blank out what a previous agent reported, so re-running the
	// installer on a working box would flash "ComfyUI not installed".
	Comfy *ComfyState `json:"comfy,omitempty"`
}

func StartHeartbeat(agent *Agent, log func(string, ...any)) *Heartbeat {
	hb := &Heartbeat{
		agent: agent,
		log:   log,
		nudge: make(chan struct{}, 1),
		stop:  make(chan struct{}),
	}
	if agent.config().ServerURL == "" {
		log("no server URL configured, so this agent will not check in; rippel can still call it")
		return hb
	}
	go hb.loop()
	return hb
}

func (hb *Heartbeat) loop() {
	for {
		hb.beat()

		cfg := hb.agent.config()
		wait := time.Duration(max(5, cfg.HeartbeatSeconds)) * time.Second
		timer := time.NewTimer(wait)
		select {
		case <-hb.stop:
			timer.Stop()
			return
		case <-hb.nudge:
			timer.Stop()
		case <-timer.C:
		}
	}
}

// Now checks in immediately, because something just changed. It never blocks:
// a nudge that arrives while one is already queued is the same nudge.
func (hb *Heartbeat) Now() {
	select {
	case hb.nudge <- struct{}{}:
	default:
	}
}

func (hb *Heartbeat) Stop() {
	hb.closed.Do(func() { close(hb.stop) })
}

func (hb *Heartbeat) beat() {
	cfg := hb.agent.config()
	if hb.agent.isPaused() || cfg.ServerURL == "" {
		return
	}

	err := hb.postCheckin(cfg)
	hb.agent.mu.Lock()
	hb.agent.connection.CheckedAt = time.Now().UTC()
	hb.agent.connection.Error = ""
	if err != nil {
		hb.agent.connection.Error = err.Error()
	} else {
		hb.agent.connection.LastSuccess = time.Now().UTC()
	}
	hb.agent.mu.Unlock()
	if err != nil {
		message := err.Error()
		// Say it once, not every twenty seconds, until it changes.
		if message != hb.lastError {
			hb.log("check-in failed: %s", message)
			hb.lastError = message
		}
		return
	}
	if hb.lastError != "" {
		hb.log("check-in recovered")
		hb.lastError = ""
	}
}

func (hb *Heartbeat) postCheckin(cfg *Config) error {
	var deploymentID *string
	if cfg.DeploymentID != "" {
		id := cfg.DeploymentID
		deploymentID = &id
	}
	state := ComfyStatus(cfg)
	body, err := json.Marshal(checkinBody{
		DeploymentID: deploymentID,
		Version:      AgentVersion,
		Platform:     cfg.Platform,
		AgentPort:    cfg.Port,
		Comfy:        &state,
	})
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		cfg.ServerURL+"/api/deployments/checkin", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("X-Rippel-Agent-Token", cfg.Token)

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return friendlyNetworkError(cfg.ServerURL, err)
	}
	defer res.Body.Close()

	raw, _ := io.ReadAll(io.LimitReader(res.Body, 64*1024))
	if res.StatusCode < 200 || res.StatusCode > 299 {
		detail := strings.TrimSpace(string(raw))
		if len(detail) > 200 {
			detail = detail[:200]
		}
		if res.StatusCode == http.StatusUnauthorized {
			return fmt.Errorf(
				"rippel does not recognise this agent's token. The deployment may have been "+
					"removed in rippel; install again from its Deployment screen. (%s)", detail)
		}
		return fmt.Errorf("rippel answered %d %s", res.StatusCode, detail)
	}

	var payload struct {
		DeploymentID string `json:"deploymentId"`
	}
	_ = json.Unmarshal(raw, &payload)

	// rippel is the authority on which deployment this is; an agent installed
	// from a bare token learns its id here and remembers it.
	if payload.DeploymentID != "" && payload.DeploymentID != cfg.DeploymentID {
		hb.agent.mu.Lock()
		hb.agent.cfg.DeploymentID = payload.DeploymentID
		hb.agent.mu.Unlock()
		if err := SaveConfig(map[string]any{"deploymentId": payload.DeploymentID}); err != nil {
			hb.log("could not remember the deployment id: %s", err)
		}
		hb.log("enrolled as deployment %s", payload.DeploymentID)
	}
	return nil
}

// friendlyNetworkError turns Go's transport errors into something a person who
// cannot read a stack trace can act on. The original text is kept in brackets,
// because whoever *can* read it should not have to guess what was hidden.
func friendlyNetworkError(serverURL string, err error) error {
	text := err.Error()
	switch {
	case strings.Contains(text, "no such host"):
		return fmt.Errorf("cannot find %s — check the address rippel gave you (%s)", serverURL, text)
	case strings.Contains(text, "connection refused"):
		return fmt.Errorf("nothing is answering at %s — is rippel running? (%s)", serverURL, text)
	case strings.Contains(text, "context deadline exceeded") || strings.Contains(text, "Client.Timeout"):
		return fmt.Errorf("%s did not answer within 10 seconds — check the network or a firewall (%s)", serverURL, text)
	}
	return fmt.Errorf("could not reach %s: %s", serverURL, text)
}
