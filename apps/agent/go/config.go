package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// AgentVersion is reported on every ping and check-in. rippel stores it against
// the deployment, so it is the one string an operator sees when asking "what is
// actually running on that box".
const AgentVersion = "0.2.0"

// Config is the agent's settings, and the directory they came from.
//
// Every setting has an environment variable and a place in config.json next to
// the install, with the environment winning. That split is not decoration: the
// installer writes the file (so a service unit needs no env block and a token
// never lands in a shell history), while a person debugging by hand overrides
// one value on the command line without editing a file.
type Config struct {
	Token            string `json:"token,omitempty"`
	ServerURL        string `json:"serverUrl,omitempty"`
	DeploymentID     string `json:"deploymentId,omitempty"`
	Port             int    `json:"port,omitempty"`
	Host             string `json:"host,omitempty"`
	ComfyPath        string `json:"comfyPath,omitempty"`
	ComfyPort        int    `json:"comfyPort,omitempty"`
	ComfyArgs        string `json:"comfyArgs,omitempty"`
	StorageToken     string `json:"storageToken,omitempty"`
	HeartbeatSeconds int    `json:"heartbeatSeconds,omitempty"`

	// Derived at load time, never written back.
	Platform string `json:"-"`
	Home     string `json:"-"`
}

// normalisePlatform maps runtime.GOOS onto the three names rippel's
// AgentPlatform type knows. Anything else is "unknown", which the panel renders
// rather than rejecting.
func normalisePlatform() string {
	switch runtime.GOOS {
	case "linux":
		return "linux"
	case "darwin":
		return "darwin"
	case "windows":
		return "win32"
	}
	return "unknown"
}

// AgentHome is ~/.rippel-agent unless RIPPEL_AGENT_HOME says otherwise.
func AgentHome() string {
	if custom := os.Getenv("RIPPEL_AGENT_HOME"); custom != "" {
		if abs, err := filepath.Abs(custom); err == nil {
			return abs
		}
		return custom
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		// A service account with no profile still has to run somewhere. The
		// executable's own folder is a better answer than the working
		// directory, because that is where a self-installed agent already is.
		if exe, exeErr := os.Executable(); exeErr == nil {
			return filepath.Join(filepath.Dir(exe), ".rippel-agent")
		}
		return ".rippel-agent"
	}
	return filepath.Join(home, ".rippel-agent")
}

// configPaths are looked at in order: the agent home first, then a config.json
// beside the executable. The second covers an agent run straight out of a
// folder without installing, which is a legitimate way to try it.
func configPaths() []string {
	paths := []string{filepath.Join(AgentHome(), "config.json")}
	if exe, err := os.Executable(); err == nil {
		beside := filepath.Join(filepath.Dir(exe), "config.json")
		if beside != paths[0] {
			paths = append(paths, beside)
		}
	}
	return paths
}

// ConfigFile is the path the agent read its settings from, or would write them
// to. Everything the agent creates later — the pid file, ComfyUI's log, an
// updated config — lands next to this, not at a path nothing is in.
func ConfigFile() string {
	for _, path := range configPaths() {
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	return filepath.Join(AgentHome(), "config.json")
}

func readConfigFile() (Config, string, error) {
	for _, path := range configPaths() {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var file Config
		if err := json.Unmarshal(raw, &file); err != nil {
			return Config{}, "", fmt.Errorf("%s is not valid JSON: %w", path, err)
		}
		return file, filepath.Dir(path), nil
	}
	return Config{}, AgentHome(), nil
}

func envString(name, fromFile, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	if fromFile != "" {
		return fromFile
	}
	return fallback
}

func envInt(name string, fromFile, fallback int) (int, error) {
	if value := os.Getenv(name); value != "" {
		n, err := strconv.Atoi(strings.TrimSpace(value))
		if err != nil {
			return 0, fmt.Errorf("%s must be a whole number, got %q", name, value)
		}
		return n, nil
	}
	if fromFile != 0 {
		return fromFile, nil
	}
	return fallback, nil
}

// LoadConfig merges config.json with the environment and fills in the defaults.
func LoadConfig() (*Config, error) {
	file, home, err := readConfigFile()
	if err != nil {
		return nil, err
	}

	cfg := &Config{
		Token:        envString("RIPPEL_AGENT_TOKEN", file.Token, ""),
		ServerURL:    strings.TrimRight(envString("RIPPEL_SERVER_URL", file.ServerURL, ""), "/"),
		DeploymentID: envString("RIPPEL_DEPLOYMENT_ID", file.DeploymentID, ""),
		Host:         envString("RIPPEL_AGENT_HOST", file.Host, "0.0.0.0"),
		ComfyArgs:    envString("RIPPEL_COMFY_ARGS", file.ComfyArgs, ""),
		StorageToken: envString("RIPPEL_STORAGE_TOKEN", file.StorageToken, ""),
		Platform:     normalisePlatform(),
		Home:         home,
	}

	if cfg.Port, err = envInt("RIPPEL_AGENT_PORT", file.Port, 8189); err != nil {
		return nil, err
	}
	if cfg.ComfyPort, err = envInt("RIPPEL_COMFY_PORT", file.ComfyPort, 8188); err != nil {
		return nil, err
	}
	if cfg.HeartbeatSeconds, err = envInt("RIPPEL_HEARTBEAT_SECONDS", file.HeartbeatSeconds, 20); err != nil {
		return nil, err
	}

	comfyPath := envString("RIPPEL_COMFY_PATH", file.ComfyPath, filepath.Join(home, "ComfyUI"))
	if abs, absErr := filepath.Abs(comfyPath); absErr == nil {
		comfyPath = abs
	}
	cfg.ComfyPath = comfyPath

	if cfg.Port < 1 || cfg.Port > 65535 {
		return nil, fmt.Errorf("the agent's port must be between 1 and 65535, got %d", cfg.Port)
	}
	if cfg.ComfyPort < 1 || cfg.ComfyPort > 65535 {
		return nil, fmt.Errorf("ComfyUI's port must be between 1 and 65535, got %d", cfg.ComfyPort)
	}
	return cfg, nil
}

// SaveConfig merges a patch into the config file the agent actually read,
// creating it at the default home if there was none.
//
// 0600: the file holds the token, and on a shared box the default umask is not
// enough. Windows ignores the mode; its ACL comes from the profile directory.
func SaveConfig(patch map[string]any) error {
	path := ConfigFile()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}

	current := map[string]any{}
	if raw, err := os.ReadFile(path); err == nil {
		if len(strings.TrimSpace(string(raw))) > 0 {
			if err := json.Unmarshal(raw, &current); err != nil {
				return fmt.Errorf("%s is not valid JSON, so it was left alone: %w", path, err)
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}

	for key, value := range patch {
		current[key] = value
	}
	body, err := json.MarshalIndent(current, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(body, '\n'), 0o600)
}
