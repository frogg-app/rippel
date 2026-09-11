package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Installing the agent onto the machine it is being run on.
//
// Installing is copying one file, writing one config, and registering one
// startup entry. Nothing here needs root, and on Windows nothing here needs
// Administrator either — that second point is not a nicety, it is the bug this
// file was rewritten to fix. See registerWindowsAutostart.
//
// The ordering is deliberate and is the other half of the fix. Pairing happens
// first, before a single byte is written; if it fails, the machine is exactly as
// it was. Everything written after that is tracked, so a failure part-way
// through undoes itself rather than leaving the half-installed state the owner
// hit: a binary and a config on disk, no way to start, and no way to tell.

// serviceName is what the agent registers itself as, on all three platforms.
// An administrator who has never heard of rippel can find and stop this.
const serviceName = "rippel-agent"

const launchAgentLabel = "app.rippel.agent"

// skipServiceEnv lets a caller install everything except the startup entry.
//
// For two real cases: a container or image that supervises the agent itself and
// would be confused by a second mechanism, and this repository's own tests,
// which must not register a user service on whatever machine they run on.
const skipServiceEnv = "RIPPEL_SKIP_SERVICE"

// InstalledPath is where the agent copies itself to. The folder someone
// downloaded into is a Downloads folder they will one day tidy up, and a
// startup entry pointing into it would stop working that day.
func InstalledPath() string {
	name := serviceName
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(AgentHome(), name)
}

// AutostartError marks the one failure that must not undo the install.
//
// If the binary and config are in place but the startup entry could not be
// made, the machine is genuinely usable — the agent runs when started — and
// deleting a working install over it would be the wrong trade. So it is
// reported as its own thing, in the words of what did and did not happen,
// rather than as "it did not work".
type AutostartError struct {
	// Detail is the mechanism's own output, kept verbatim.
	Detail string
	// Exe is where the agent actually is, so the manual instructions can name it.
	Exe string
}

func (e *AutostartError) Error() string {
	return fmt.Sprintf("could not register a startup entry: %s", e.Detail)
}

// installedFiles tracks what this run created, so a later failure can undo it.
type installedFiles struct {
	paths      []string
	createdDir string
}

func (f *installedFiles) track(path string) { f.paths = append(f.paths, path) }

// rollBack removes what this run created and nothing else. An upgrade over an
// existing install creates nothing, so it rolls back nothing — which is correct:
// the previous install is still there and still works.
func (f *installedFiles) rollBack() {
	for i := len(f.paths) - 1; i >= 0; i-- {
		_ = os.Remove(f.paths[i])
	}
	if f.createdDir != "" {
		// Only if we made it and it is now empty; never a recursive delete of a
		// directory that might hold somebody's ComfyUI.
		_ = os.Remove(f.createdDir)
	}
}

// Install does the whole job: pair, copy the binary, write the config, register
// the startup entry, start it.
//
// `say` is how it narrates itself — the interactive path prints to a console a
// person is watching, and the SSH path streams the same lines back to rippel.
func Install(setup Setup, say func(string, ...any)) error {
	home := AgentHome()
	created := &installedFiles{}

	if _, err := os.Stat(home); os.IsNotExist(err) {
		created.createdDir = home
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return fmt.Errorf("could not create %s: %w", home, err)
	}

	// Stop any previous copy before replacing the file underneath it. On
	// Windows a running exe cannot be overwritten at all; on Unix it can, but
	// replacing a binary a live process is executing is still a bad idea.
	stopService(say)

	target := InstalledPath()
	replaced, err := copySelf(target)
	if err != nil {
		created.rollBack()
		return err
	}
	if !replaced {
		created.track(target)
	}
	say("Installed to %s", target)

	configPath := filepath.Join(home, "config.json")
	if _, statErr := os.Stat(configPath); os.IsNotExist(statErr) {
		created.track(configPath)
	}
	config := map[string]any{
		"token":     setup.Token,
		"serverUrl": setup.ServerURL,
		"comfyPath": filepath.Join(home, "ComfyUI"),
	}
	// Unlike the old setup link, pairing tells us the deployment id up front, so
	// it is written down now rather than learned on the first check-in.
	if setup.DeploymentID != "" {
		config["deploymentId"] = setup.DeploymentID
	}
	if err := writeConfigAt(configPath, config); err != nil {
		created.rollBack()
		return err
	}
	say("Wrote %s", configPath)

	warnAboutMissingTools(say)

	// From here on nothing is rolled back: the agent is installed and works.
	return registerService(target, home, say)
}

// copySelf writes this running executable to target. It reports whether it
// replaced something that was already there, so an upgrade is not rolled back
// as if this run had created it.
func copySelf(target string) (replaced bool, err error) {
	source, execErr := os.Executable()
	if execErr != nil {
		return false, fmt.Errorf("could not work out where this program is: %w", execErr)
	}
	if same, _ := sameFile(source, target); same {
		// Already installed and re-run in place; nothing to copy.
		return true, nil
	}
	_, statErr := os.Stat(target)
	replaced = statErr == nil

	data, err := os.ReadFile(source)
	if err != nil {
		return replaced, fmt.Errorf("could not read %s: %w", source, err)
	}

	if err := os.WriteFile(target, data, 0o755); err != nil {
		// Windows refuses to overwrite a file that is executing. Renaming it
		// aside is allowed even then, so the previous copy is moved out of the
		// way and left for the OS to clean up on the next reboot.
		aside := target + ".old"
		_ = os.Remove(aside)
		if renameErr := os.Rename(target, aside); renameErr != nil {
			return replaced, fmt.Errorf(
				"Could not write %s.\n\n  %s\n\n"+
					"If the agent is already running, stop it and try again.", target, err)
		}
		if err := os.WriteFile(target, data, 0o755); err != nil {
			return replaced, fmt.Errorf("could not write %s: %w", target, err)
		}
	}
	return replaced, os.Chmod(target, 0o755)
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
// upgrade keeps the storage token it had learned.
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
	if os.Getenv(skipServiceEnv) != "" {
		say("%s is set, so no startup entry was registered.", skipServiceEnv)
		say("Start it yourself with: %s run", exe)
		return nil
	}
	switch runtime.GOOS {
	case "darwin":
		return registerLaunchAgent(exe, home, say)
	case "windows":
		return registerWindowsAutostart(exe, home, say)
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
		// Nothing to "stop" for a Run key — the entry is not a service. Any
		// running copy is ended so its file can be replaced.
		_ = quiet("taskkill", "/IM", serviceName+".exe", "/F")
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
		say("No systemd here, so nothing was registered to start automatically.")
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
		return &AutostartError{Detail: "systemctl --user daemon-reload failed", Exe: exe}
	}
	if err := quiet("systemctl", "--user", "enable", serviceName+".service"); err != nil {
		return &AutostartError{Detail: "systemctl --user enable failed", Exe: exe}
	}
	// restart, not `enable --now`: on a re-run the service is already enabled,
	// and --now would leave the old binary in memory having just replaced the
	// file under it.
	if out, err := output("systemctl", "--user", "restart", serviceName+".service"); err != nil {
		return &AutostartError{Detail: out, Exe: exe}
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
		return &AutostartError{Detail: out, Exe: exe}
	}
	say("Started as a LaunchAgent.")
	say("Logs: %s", logPath)
	return nil
}

func xmlEscape(text string) string {
	replacer := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")
	return replacer.Replace(text)
}

// startupFolder is the per-user Startup folder, whose contents Explorer runs at
// logon. %APPDATA% is the documented way to find it and is always set for an
// interactive user.
func startupFolder() string {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		return ""
	}
	return filepath.Join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
}

func startupShimPath() string {
	folder := startupFolder()
	if folder == "" {
		return ""
	}
	return filepath.Join(folder, serviceName+".cmd")
}

// registerWindowsAutostart makes the agent start at logon, without elevation.
//
// **This is the bug.** The previous mechanism was `schtasks /Create`, and on the
// owner's own machine it answered `ERROR: Access is denied` — after the agent
// had already copied itself and written its config. Creating a Scheduled Task
// can require administrator rights depending on how the machine is configured,
// and asking a person setting up their own GPU box to find an elevated prompt is
// exactly the step this whole feature exists to remove.
//
// So: the per-user Run key, and a Startup-folder script as the fallback.
//
//   - `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run` is
//     documented by Microsoft as a per-user Run key: entries under HKCU run
//     when *that* user logs on, and writing to one's own HKCU hive needs no
//     elevation, because it is that user's own registry. (Microsoft, "Run and
//     RunOnce Registry Keys", learn.microsoft.com/windows/win32/setupapi/
//     run-and-runonce-registry-keys — the HKEY_CURRENT_USER variants are listed
//     alongside the HKEY_LOCAL_MACHINE ones, which *are* the ones that need
//     administrator rights.)
//   - The per-user Startup folder under %APPDATA% is the shell's own equivalent:
//     Explorer runs what is in it at logon, and it is an ordinary directory in
//     the user's roaming profile that the user can write to.
//
// `reg.exe` rather than a registry API binding, for the same reason the old code
// used schtasks.exe: it is present on every Windows, it is pure exec with no
// cgo, and its failure is a readable line of text rather than an HRESULT.
//
// A .cmd rather than a .lnk for the fallback, because writing a shortcut means
// COM and IShellLink, which means cgo or a hand-rolled binary format — a .cmd is
// a text file, and `start ""` launches the agent without leaving a console
// window sitting on the desktop.
//
// **Unverified here.** Neither branch of this function can be executed on the
// Linux box it was written and cross-compiled on. What is testable — and is
// tested — is the command line built for reg.exe and the text of the .cmd.
func registerWindowsAutostart(exe, home string, say func(string, ...any)) error {
	command := windowsRunCommand(exe)
	var problems []string

	// The Run key first: it is the mechanism Windows itself documents for this,
	// and it leaves nothing on the desktop or in a folder to be tidied away.
	if out, err := output("reg", "add", windowsRunKey,
		"/v", serviceName, "/t", "REG_SZ", "/d", command, "/f"); err != nil {
		problems = append(problems, fmt.Sprintf("the registry: %s", out))
	} else {
		say("Registered to start at logon (per-user, no administrator needed).")
		say("Logs: %s", filepath.Join(home, "agent.log"))
		startNow(exe, say)
		return nil
	}

	// Fallback: a one-line script in the user's own Startup folder.
	if shim := startupShimPath(); shim != "" {
		if err := os.MkdirAll(filepath.Dir(shim), 0o755); err != nil {
			problems = append(problems, fmt.Sprintf("the Startup folder: %s", err))
		} else if err := os.WriteFile(shim, []byte(startupShimBody(exe)), 0o644); err != nil {
			problems = append(problems, fmt.Sprintf("the Startup folder: %s", err))
		} else {
			say("Registered to start at logon, from %s", shim)
			say("Logs: %s", filepath.Join(home, "agent.log"))
			startNow(exe, say)
			return nil
		}
	} else {
		problems = append(problems, "the Startup folder: APPDATA is not set for this account")
	}

	return &AutostartError{Detail: strings.Join(problems, "; "), Exe: exe}
}

// windowsRunKey is the per-user Run key. Per-user is the whole point: the
// HKEY_LOCAL_MACHINE key of the same name is the one that needs elevation.
const windowsRunKey = `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`

// windowsRunCommand is the value written under the Run key.
//
// The path is quoted because this lands under C:\Users\<name>\, and a user
// folder with a space in it is the normal case, not the edge case.
func windowsRunCommand(exe string) string {
	return `"` + exe + `" run`
}

// startupShimBody is the fallback script. `start ""` returns immediately and
// gives the agent its own process, so the logon does not wait on it; the empty
// quotes are start's title argument, without which it would read a quoted path
// as the title and launch nothing.
func startupShimBody(exe string) string {
	return "@echo off\r\nstart \"\" /b \"" + exe + "\" run\r\n"
}

// startNow launches the agent immediately, so the person who just installed it
// does not have to log out to see it appear in rippel.
func startNow(exe string, say func(string, ...any)) {
	cmd := exec.Command(exe, "run")
	hideConsole(cmd)
	detach(cmd)
	if err := cmd.Start(); err != nil {
		say("Note: the agent is registered but could not be started just now (%s).", err)
		say("      It will start when you next log in.")
		return
	}
	_ = cmd.Process.Release()
	say("Started it.")
}

// Uninstall removes the startup entry and the installed binary, leaving the
// config and any ComfyUI checkout alone — removing rippel's management of a
// machine should not delete the thing it was managing.
func Uninstall(say func(string, ...any)) error {
	stopService(say)
	switch runtime.GOOS {
	case "darwin":
		plist := launchAgentPlistPath()
		if err := os.Remove(plist); err == nil {
			say("Removed %s", plist)
		}
	case "windows":
		// Both mechanisms, because either could have been the one that worked.
		if err := quiet("reg", "delete", windowsRunKey, "/v", serviceName, "/f"); err == nil {
			say("Removed the startup entry from the registry.")
		}
		if shim := startupShimPath(); shim != "" {
			if err := os.Remove(shim); err == nil {
				say("Removed %s", shim)
			}
		}
		// A task left by a version of the agent that predates this one.
		_ = quiet("schtasks", "/Delete", "/TN", serviceName, "/F")
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
// second agent started by hand while the first is already up.
func portInUse(err error) bool {
	text := strings.ToLower(err.Error())
	return strings.Contains(text, "address already in use") ||
		strings.Contains(text, "only one usage of each socket address")
}
