package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"
)

const modelApprovalWait = 15 * time.Minute

type modelApprovalError string

func (e modelApprovalError) Error() string { return string(e) }

func publicModelIP(ip net.IP) bool {
	return ip != nil && ip.IsGlobalUnicast() && !ip.IsPrivate() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() && !ip.IsUnspecified() && !ip.Equal(net.ParseIP("169.254.169.254")) && !(ip.To4() != nil && ip.To4()[0] == 100 && ip.To4()[1] >= 64 && ip.To4()[1] <= 127)
}

func publicModelAddresses(ctx context.Context, host string) ([]net.IPAddr, error) {
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil || len(ips) == 0 {
		return nil, fmt.Errorf("could not resolve download host %s", host)
	}
	for _, ip := range ips {
		if !publicModelIP(ip.IP) {
			return nil, fmt.Errorf("download host must use public internet addresses")
		}
	}
	return ips, nil
}

// Resolve at every dial, validate every returned address, and connect to that
// numeric address. Neither DNS rebinding nor an environment proxy can bypass it.
func publicModelDial(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, fmt.Errorf("invalid download address")
	}
	ips, err := publicModelAddresses(ctx, host)
	if err != nil {
		return nil, err
	}
	dialer := net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	for _, ip := range ips {
		conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
		if err == nil {
			return conn, nil
		}
	}
	return nil, fmt.Errorf("could not connect to download host %s", host)
}

func (t *Task) waitHostApproval(ctx context.Context, host string, timeout time.Duration) error {
	t.mu.Lock()
	t.approval = &HostApproval{Hostname: host}
	reply := make(chan bool, 1)
	t.approvalReply = reply
	t.mu.Unlock()
	defer func() { t.mu.Lock(); t.approval = nil; t.approvalReply = nil; t.mu.Unlock() }()
	t.Appendf("Waiting for approval to download from %s.", host)
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case approved := <-reply:
		if approved {
			return nil
		}
		return modelApprovalError("Download host approval declined.")
	case <-timer.C:
		return modelApprovalError("Download host approval timed out. Retry the download.")
	case <-ctx.Done():
		return modelApprovalError("Download cancelled while awaiting host approval.")
	}
}

func (a *Agent) approvalModelClient(task *Task) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = publicModelDial
	return &http.Client{Timeout: 12 * time.Hour, Transport: transport, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return fmt.Errorf("too many download redirects")
		}
		u := req.URL
		if u.Scheme != "https" || u.User != nil || u.Fragment != "" || (u.Port() != "" && u.Port() != "443") {
			return fmt.Errorf("model downloads require HTTPS without credentials, fragments or custom ports")
		}
		if allowedModelURL(u.String(), true) == nil {
			return nil
		}
		host := strings.ToLower(u.Hostname())
		if host == "" || net.ParseIP(host) != nil || strings.HasSuffix(host, ".") || !strings.Contains(host, ".") {
			return fmt.Errorf("download requires a public hostname")
		}
		if _, err := publicModelAddresses(req.Context(), host); err != nil {
			return err
		}
		for _, approved := range a.config().ApprovedModelHosts {
			if approved == host {
				return nil
			}
		}
		return task.waitHostApproval(req.Context(), host, modelApprovalWait)
	}}
}

func (a *Agent) approveModelHost(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Hostname string `json:"hostname"`
		Approve  *bool  `json:"approve"`
	}
	if err := readBody(r, &body); err != nil || body.Approve == nil {
		writeError(w, 400, "bad_request", "Choose whether to allow this download host.")
		return
	}
	task := a.tasks.Get(id)
	if task == nil {
		writeError(w, 404, "not_found", "No such task.")
		return
	}
	task.mu.Lock()
	defer task.mu.Unlock()
	if task.status != "running" || task.approval == nil || task.approval.Hostname != body.Hostname || task.approvalReply == nil {
		writeError(w, 409, "not_pending", "This host is not awaiting approval.")
		return
	}
	if *body.Approve {
		a.mu.Lock()
		hosts := append([]string(nil), a.cfg.ApprovedModelHosts...)
		found := false
		for _, host := range hosts {
			if host == body.Hostname {
				found = true
			}
		}
		if !found {
			hosts = append(hosts, body.Hostname)
		}
		err := SaveConfig(map[string]any{"approvedModelHosts": hosts})
		if err == nil {
			a.cfg.ApprovedModelHosts = hosts
		}
		a.mu.Unlock()
		if err != nil {
			writeError(w, 500, "save_failed", "Could not save download host approval.")
			return
		}
	}
	task.approvalReply <- *body.Approve
	task.approval = nil
	task.approvalReply = nil
	writeJSON(w, 200, map[string]bool{"ok": true})
}
