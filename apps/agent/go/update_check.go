package main

// Whether the rippel this agent is paired with serves a newer agent, so the
// tray can offer the update instead of someone noticing it on a web page.
//
// The rippel says what it serves at /api/deployments/agent/<target>/latest:
// a version (when its build wrote one) and the SHA-256 the update is checked
// against. That digest is also all an update needs, so the tray can start one
// without the web app's help.
import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// How often the agent asks, once the first check is out of the way.
const updateCheckEvery = 6 * time.Hour

type UpdateInfo struct {
	Current   string     `json:"current"`
	Latest    *string    `json:"latest"`
	Available bool       `json:"available"`
	CheckedAt *time.Time `json:"checkedAt"`
	Error     string     `json:"error"`
}

type updateChecker struct {
	mu      sync.Mutex
	info    UpdateInfo
	sha256  string
	selfSHA string
}

func (c *updateChecker) snapshot() UpdateInfo {
	c.mu.Lock()
	defer c.mu.Unlock()
	info := c.info
	info.Current = AgentVersion
	return info
}

type latestAgent struct {
	Version *string `json:"version"`
	SHA256  string  `json:"sha256"`
}

// agentTarget names this build the way the rippel's binary routes do.
func agentTarget() string {
	platform := runtime.GOOS
	if platform == "darwin" {
		platform = "macos"
	}
	return platform + "-" + runtime.GOARCH
}

func latestAgentURL(cfg *Config) (string, error) {
	base, err := url.Parse(cfg.ServerURL)
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" {
		return "", fmt.Errorf("No rippel server is configured")
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/api/deployments/agent/" + agentTarget() + "/latest"
	base.RawQuery, base.Fragment = "", ""
	return base.String(), nil
}

// checkForUpdate asks the rippel what it serves and records the answer.
func (a *Agent) checkForUpdate(client *http.Client) UpdateInfo {
	latest, err := fetchLatestAgent(a.config(), client)
	c := &a.updates
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now().UTC()
	c.info.CheckedAt = &now
	if err != nil {
		c.info.Error = err.Error()
	} else {
		if c.selfSHA == "" {
			c.selfSHA = ownDigest()
		}
		c.info.Error = ""
		c.info.Latest = latest.Version
		c.sha256 = latest.SHA256
		c.info.Available = updateIsNewer(latest, c.selfSHA)
	}
	info := c.info
	info.Current = AgentVersion
	return info
}

func fetchLatestAgent(cfg *Config, client *http.Client) (latestAgent, error) {
	address, err := latestAgentURL(cfg)
	if err != nil {
		return latestAgent{}, err
	}
	response, err := client.Get(address)
	if err != nil {
		return latestAgent{}, fmt.Errorf("Could not reach rippel to check for updates")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return latestAgent{}, fmt.Errorf("rippel has no agent update for this machine (HTTP %d)", response.StatusCode)
	}
	var latest latestAgent
	if err := json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&latest); err != nil {
		return latestAgent{}, fmt.Errorf("rippel's update answer was unreadable")
	}
	if digest, err := hex.DecodeString(latest.SHA256); err != nil || len(digest) != sha256.Size {
		return latestAgent{}, fmt.Errorf("rippel's update answer had no usable digest")
	}
	return latest, nil
}

// updateIsNewer compares versions when the rippel names one, so an older build
// on the server is never offered as an "update". Without a version, any
// different binary counts.
func updateIsNewer(latest latestAgent, selfSHA string) bool {
	if latest.Version != nil && *latest.Version != "" {
		return compareVersions(*latest.Version, AgentVersion) > 0
	}
	return selfSHA != "" && !strings.EqualFold(latest.SHA256, selfSHA)
}

// compareVersions orders dotted numeric versions; a missing part counts as 0.
func compareVersions(a, b string) int {
	pa, pb := strings.Split(strings.TrimPrefix(a, "v"), "."), strings.Split(strings.TrimPrefix(b, "v"), ".")
	for i := 0; i < max(len(pa), len(pb)); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			if x > y {
				return 1
			}
			return -1
		}
	}
	return 0
}

func ownDigest() string {
	path, err := os.Executable()
	if err != nil {
		return ""
	}
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return ""
	}
	return hex.EncodeToString(hash.Sum(nil))
}

// watchForUpdates checks shortly after start, then every few hours, until stop.
func (a *Agent) watchForUpdates(stop <-chan struct{}) {
	client := &http.Client{Timeout: 20 * time.Second}
	wait := 20 * time.Second
	for {
		select {
		case <-stop:
			return
		case <-time.After(wait):
		}
		a.checkForUpdate(client)
		wait = updateCheckEvery
	}
}

// desktopUpdate starts the update the last check found, checking first if
// there has been no check yet.
func (a *Agent) desktopUpdate(w http.ResponseWriter) {
	info := a.updates.snapshot()
	if info.CheckedAt == nil || info.Error != "" {
		info = a.checkForUpdate(&http.Client{Timeout: 10 * time.Second})
	}
	if info.Error != "" {
		writeError(w, http.StatusBadGateway, "update_check_failed", info.Error)
		return
	}
	if !info.Available {
		writeError(w, http.StatusConflict, "up_to_date", "This agent is already up to date.")
		return
	}
	a.updates.mu.Lock()
	digest := a.updates.sha256
	a.updates.mu.Unlock()
	a.beginAgentUpdate(w, AgentUpdateRequest{SHA256: digest})
}
