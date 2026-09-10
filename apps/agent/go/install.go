package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Installing the agent onto the machine it is being run on.
//
// The old agent needed a shell script for this, because it was source that had
// to find a Node runtime, download six files and write a service unit. A single
// static binary needs none of that: installing is copying one file, writing one
// config, and registering one service. That whole reduction is why this is Go.
//
// Nothing here needs root. The agent installs into its own home directory and
// runs as whoever owns the ComfyUI checkout, which is what you want — a ComfyUI
// installed by root is one you cannot maintain as yourself later.

// serviceName is what the agent registers itself as, on all three platforms.
// An administrator who has never heard of rippel can find and stop this.
const serviceName = "rippel-agent"

const launchAgentLabel = "app.rippel.agent"

// InstalledPath is where the agent copies itself to. The folder someone
// downloaded into is a Downloads folder they will one day tidy up, and a
// service pointing into it would stop working that day.
func InstalledPath() string {
	name := serviceName
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(AgentHome(), name)
}

// Install does the whole job: check the server will have us, copy the binary,
// write the config, register the service, start it.
//
// `say` is how it narrates itself — the interactive path prints to a console a
// person is watching, and the SSH path streams the same lines back to rippel.
func Install(setup Setup, say func(string, ...any)) error {
	home := AgentHome()

	say("Checking that rippel at %s knows this token...", setup.ServerURL)
	if err := verifySetup(setup); err != nil {
		return err
	}
	say("rippel recognised it.")

	if err := os.MkdirAll(home, 0o700); err != nil {
		return fmt.Errorf("could not create %s: %w", home, err)
	}

	// Stop any previous copy before replacing the file underneath it. On
	// Windows a running exe cannot be overwritten at all; on Unix it can, but
	// replacing a binary a live service is executing is still a bad idea.
	stopService(say)

	target := InstalledPath()
	if err := copySelf(target); err != nil {
		return err
	}
	say("Installed to %s", target)

	config := map[string]any{
		"token":     setup.Token,
		"serverUrl": setup.ServerURL,
		"comfyPath": filepath.Join(home, "ComfyUI"),
	}
	// The deployment id is deliberately absent: the first check-in learns it
	// from rippel, which is one fewer thing that can be pasted wrong.
	if setup.AgentPort != 0 {
		config["port"] = setup.AgentPort
	}
	if setup.ComfyPort != 0 {
		config["comfyPort"] = setup.ComfyPort
	}
	if err := writeConfigAt(filepath.Join(home, "config.json"), config); err != nil {
		return err
	}
	say("Wrote %s", filepath.Join(home, "config.json"))

	warnAboutMissingTools(say)

	if err := registerService(target, home, say); err != nil {
		return err
	}
	return nil
}

// verifySetup asks rippel whether this token is a deployment, before anything
// is written to disk.
//
// This is the single most valuable thing the installer does for a
// non-technical person. Without it, a mistyped address or a token from a
// deployment that was since deleted produces a service that installs perfectly,
// starts perfectly, and never appears in rippel — with the reason buried in a
// log they will never open. Here it is a sentence on screen, before anything
// happened.
func verifySetup(setup Setup) error {
	// No comfy state and no agent port: the installer has not started a server
	// or looked at the disk yet, and rippel should keep what it already knew
	// rather than being told nothing is there.
	body, err := json.Marshal(checkinBody{
		Version:  AgentVersion,
		Platform: normalisePlatform(),
	})
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		setup.ServerURL+"/api/deployments/checkin", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("X-Rippel-Agent-Token", setup.Token)

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf(
			"Could not reach rippel.\n\n  %s\n\n"+
				"Check that this machine is on the same network as rippel, and that the "+
				"address in your setup link is right.",
			friendlyNetworkError(setup.ServerURL, err))
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 8*1024))

	switch {
	case res.StatusCode == http.StatusUnauthorized:
		return fmt.Errorf(
			"rippel does not recognise that setup code.\n\n" +
				"It is probably out of date — codes stop working when the deployment is " +
				"removed in rippel. Open rippel, go to Settings then Deployment, and copy " +
				"the link for this machine again.")
	case res.StatusCode == http.StatusNotFound:
		return fmt.Errorf(
			"There is no rippel at %s — something answered, but it was not rippel.\n\n"+
				"Check the address in your setup link.", setup.ServerURL)
	case res.StatusCode < 200 || res.StatusCode > 299:
		return fmt.Errorf("rippel answered %d: %s", res.StatusCode,
			strings.TrimSpace(string(raw)))
	}
	return nil
}

// copySelf writes this running executable to target.
func copySelf(target string) error {
	source, err := os.Executable()
	if err != nil {
		return fmt.Errorf("could not work out where this program is: %w", err)
	}
	if same, _ := sameFile(source, target); same {
		// Already installed and re-run in place; nothing to copy.
		return nil
	}

	data, err := os.ReadFile(source)
	if err != nil {
		return fmt.Errorf("could not read %s: %w", source, err)
	}

	if err := os.WriteFile(target, data, 0o755); err != nil {
		// Windows refuses to overwrite a file that is executing. Renaming it
		// aside is allowed even then, so the previous copy is moved out of the
		// way and left for the OS to clean up on the next reboot.
		aside := target + ".old"
		_ = os.Remove(aside)
		if renameErr := os.Rename(target, aside); renameErr != nil {
			return fmt.Errorf(
				"Could not write %s.\n\n  %s\n\n"+
					"If the agent is already running, stop it and try again.", target, err)
		}
		if err := os.WriteFile(target, data, 0o755); err != nil {
			return fmt.Errorf("could not write %s: %w", target, err)
		}
	}
	return os.Chmod(target, 0o755)
}

func sameFile(a, b string) (bool, error) {
	infoA, err := os.Stat(a)
	if err != nil {
		return false, err
	}
	infoB, err := os.Stat(b)
	if err != nil {
		return false, err
	}
	return os.SameFile(infoA, infoB), nil
}

// writeConfigAt writes the config, merging over anything already there so an
// upgrade keeps the deployment id and storage token it had learned.
func writeConfigAt(path string, patch map[string]any) error {
	current := map[string]any{}
	if raw, err := os.ReadFile(path); err == nil && len(strings.TrimSpace(string(raw))) > 0 {
		_ = json.Unmarshal(raw, &current)
	}
	// A re-install pointed at a different rippel is a different deployment, so
	// the remembered id must not survive a changed server or token.
	if current["serverUrl"] != patch["serverUrl"] || current["token"] != patch["token"] {
		delete(current, "deploymentId")
	}
	for key, value := range patch {
		current[key] = value
	}
	body, err := json.MarshalIndent(current, "", "  ")
	if err != nil {
		return err
	}
	// 0600: it holds the token.
	return os.WriteFile(path, append(body, '\n'), 0o600)
}

// warnAboutMissingTools says now what would otherwise fail after a download.
// The agent itself needs neither; ComfyUI needs both.
func warnAboutMissingTools(say func(string, ...any)) {
	tools := []string{"git", "python3"}
	if runtime.GOOS == "windows" {
		tools = []string{"git", "python"}
	}
	for _, tool := range tools {
		if _, err := exec.LookPath(tool); err != nil {
			say("Note: %s is not installed on this machine. The agent will run fine, "+
				"but installing ComfyUI will need it.", tool)
		}
	}
}

// ---------------------------------------------------------------- services

func registerService(exe, home string, say func(string, ...any)) error {
	switch runtime.GOOS {
	case "darwin":
		return registerLaunchAgent(exe, home, say)
	case "windows":
		return registerScheduledTask(exe, home, say)
	default:
		return registerSystemdUnit(exe, home, say)
	}
}

// stopService is best-effort on every platform: there may be nothing installed
// yet, which is not an error.
func stopService(say func(string, ...any)) {
	switch runtime.GOOS {
	case "darwin":
		plist := launchAgentPlistPath()
		if exists(plist) {
			_ = quiet("launchctl", "unload", plist)
		}
	case "windows":
		_ = quiet("schtasks", "/End", "/TN", serviceName)
	default:
		if _, err := exec.LookPath("systemctl"); err == nil {
			_ = quiet("systemctl", "--user", "stop", serviceName+".service")
		}
	}
}

func quiet(command string, args ...string) error {
	cmd := exec.Command(command, args...)
	hideConsole(cmd)
	return cmd.Run()
}

func output(command string, args ...string) (string, error) {
	cmd := exec.Command(command, args...)
	hideConsole(cmd)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// registerSystemdUnit writes a --user unit with lingering enabled.
//
// A user service, not a system one: the agent needs no privilege it does not
// already have as the user who will own the ComfyUI checkout, and asking for
// root to run a GPU process as root is how a checkout ends up unwritable by the
// person maintaining it. Without lingering the service stops when the SSH
// session ends, which for a headless GPU box means the agent is only up while
// someone is logged in.
func registerSystemdUnit(exe, home string, say func(string, ...any)) error {
	if _, err := exec.LookPath("systemctl"); err != nil {
		say("No systemd here, so nothing was registered as a service.")
		say("Start it yourself with: %s run", exe)
		return nil
	}

	unitDir := filepath.Join(home, "..", ".config", "systemd", "user")
	if configHome := os.Getenv("XDG_CONFIG_HOME"); configHome != "" {
		unitDir = filepath.Join(configHome, "systemd", "user")
	} else if userHome, err := os.UserHomeDir(); err == nil {
		unitDir = filepath.Join(userHome, ".config", "systemd", "user")
	}
	if err := os.MkdirAll(unitDir, 0o755); err != nil {
		return fmt.Errorf("could not create %s: %w", unitDir, err)
	}

	unit := fmt.Sprintf(`[Unit]
Description=rippel agent
After=network-online.target

[Service]
ExecStart=%s run
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`, exe)
	unitPath := filepath.Join(unitDir, serviceName+".service")
	if err := os.WriteFile(unitPath, []byte(unit), 0o644); err != nil {
		return fmt.Errorf("could not write %s: %w", unitPath, err)
	}

	if err := quiet("systemctl", "--user", "daemon-reload"); err != nil {
		return fmt.Errorf("systemctl --user daemon-reload failed: %w", err)
	}
	if err := quiet("systemctl", "--user", "enable", serviceName+".service"); err != nil {
		return fmt.Errorf("could not enable the service: %w", err)
	}
	// restart, not `enable --now`: on a re-run the service is already enabled,
	// and --now would leave the old binary in memory having just replaced the
	// file under it.
	if out, err := output("systemctl", "--user", "restart", serviceName+".service"); err != nil {
		return fmt.Errorf("could not start the service: %s", out)
	}

	if user := os.Getenv("USER"); user != "" {
		if err := quiet("loginctl", "enable-linger", user); err != nil {
			say("Note: could not enable lingering, so the agent will stop when you log out.")
			say("      To fix that, run: sudo loginctl enable-linger %s", user)
		}
	}
	say("Started as a systemd user service.")
	say("Logs: journalctl --user -u %s -f", serviceName)
	return nil
}

func launchAgentPlistPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, "Library", "LaunchAgents", launchAgentLabel+".plist")
}

func registerLaunchAgent(exe, home string, say func(string, ...any)) error {
	plist := launchAgentPlistPath()
	if err := os.MkdirAll(filepath.Dir(plist), 0o755); err != nil {
		return fmt.Errorf("could not create %s: %w", filepath.Dir(plist), err)
	}

	logPath := filepath.Join(home, "agent.log")
	body := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>%s</string>
  <key>ProgramArguments</key>
  <array>
    <string>%s</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>%s</string>
  <key>StandardErrorPath</key><string>%s</string>
</dict>
</plist>
`, launchAgentLabel, xmlEscape(exe), xmlEscape(logPath), xmlEscape(logPath))

	if err := os.WriteFile(plist, []byte(body), 0o644); err != nil {
		return fmt.Errorf("could not write %s: %w", plist, err)
	}
	_ = quiet("launchctl", "unload", plist)
	if out, err := output("launchctl", "load", plist); err != nil {
		return fmt.Errorf("could not start the LaunchAgent: %s", out)
	}
	say("Started as a LaunchAgent.")
	say("Logs: %s", logPath)
	return nil
}

func xmlEscape(text string) string {
	replacer := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")
	return replacer.Replace(text)
}

// registerScheduledTask is the Windows supervision mechanism.
//
// A Scheduled Task for the current user with a logon trigger: the one mechanism
// present on every Windows since 7, needing no service wrapper downloaded from
// anywhere and no administrator rights. It is also the mechanism a Windows
// administrator can see and stop without knowing anything about rippel.
//
// schtasks.exe rather than the PowerShell cmdlets, because schtasks has been on
// every Windows for twenty years and does not depend on an execution policy.
func registerScheduledTask(exe, home string, say func(string, ...any)) error {
	// schtasks takes the command as one string, so the path is quoted here —
	// this lands under C:\Users\<name>\, and a user folder with a space in it
	// is the normal case, not the edge case.
	command := `"` + exe + `" run`

	_ = quiet("schtasks", "/Delete", "/TN", serviceName, "/F")

	if out, err := output("schtasks", "/Create",
		"/TN", serviceName,
		"/TR", command,
		"/SC", "ONLOGON",
		"/RL", "LIMITED",
		"/F",
	); err != nil {
		return fmt.Errorf(
			"Could not register the startup task.\n\n  %s\n\n"+
				"The agent is installed at %s — you can start it by "+
				"double-clicking it, but it will not start again by itself after a restart.",
			out, exe)
	}

	if out, err := output("schtasks", "/Run", "/TN", serviceName); err != nil {
		return fmt.Errorf(
			"The startup task was registered but would not start.\n\n  %s\n\n"+
				"Try restarting the machine.", out)
	}

	say("Registered the startup task %q and started it.", serviceName)
	say("It will start again by itself whenever you log in.")
	say("Logs: %s", filepath.Join(home, "agent.log"))
	return nil
}

// Uninstall removes the service and the installed binary, leaving the config
// and any ComfyUI checkout alone — removing rippel's management of a machine
// should not delete the thing it was managing.
func Uninstall(say func(string, ...any)) error {
	stopService(say)
	switch runtime.GOOS {
	case "darwin":
		plist := launchAgentPlistPath()
		if err := os.Remove(plist); err == nil {
			say("Removed %s", plist)
		}
	case "windows":
		_ = quiet("schtasks", "/Delete", "/TN", serviceName, "/F")
		say("Removed the startup task %q.", serviceName)
	default:
		if _, err := exec.LookPath("systemctl"); err == nil {
			_ = quiet("systemctl", "--user", "disable", serviceName+".service")
			userHome, _ := os.UserHomeDir()
			unit := filepath.Join(userHome, ".config", "systemd", "user", serviceName+".service")
			if err := os.Remove(unit); err == nil {
				say("Removed %s", unit)
			}
			_ = quiet("systemctl", "--user", "daemon-reload")
		}
	}
	if err := os.Remove(InstalledPath()); err == nil {
		say("Removed %s", InstalledPath())
	}
	say("Done. %s was left in place, along with any ComfyUI it installed.", AgentHome())
	return nil
}

// portInUse is the check behind the friendliest error the run path can give: a
// second agent started by hand while the service is already up.
func portInUse(err error) bool {
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "address already in use") ||
		strings.Contains(text, "only one usage of each socket address")
}

var _ = strconv.Itoa
