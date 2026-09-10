package main

import (
	"bufio"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// The rippel agent.
//
// One process per managed machine. It listens for rippel on a port and checks
// in to rippel on a timer, and between those two it can install, update, start
// and stop the ComfyUI on this box and keep the storage helper in place.
//
// It is one static binary with no runtime beside it, which is the whole point:
// installing it is downloading one file and opening it. There is nothing to
// unpack, nothing to compile, and no Node, Python or Visual C++ redistributable
// to get wrong first.
//
// There are two ways in, and the difference between them is the entire user
// experience:
//
//   - `rippel-agent run` is the service. It never prompts, never waits, and
//     writes one line per interesting event to stdout, where systemd, launchd
//     or a log file will catch it.
//   - Double-clicking it, or running it with no arguments, is a person. That
//     path explains what the program is, works out or asks for the one thing it
//     needs, installs itself, and does not close the window on the way out.

func main() {
	args := os.Args[1:]
	command := ""
	if len(args) > 0 {
		command = strings.ToLower(strings.TrimPrefix(args[0], "--"))
	}

	switch command {
	case "run":
		if err := runAgent(); err != nil {
			serviceLog("%s", err)
			os.Exit(1)
		}
	case "install":
		os.Exit(commandInstall(args[1:]))
	case "uninstall":
		os.Exit(commandUninstall())
	case "status":
		os.Exit(commandStatus())
	case "version", "-v":
		fmt.Printf("rippel-agent %s (%s)\n", AgentVersion, normalisePlatform())
	case "help", "-h", "?":
		usage(os.Stdout)
	case "":
		os.Exit(welcome())
	default:
		fmt.Fprintf(os.Stderr, "rippel-agent: there is no command called %q.\n\n", args[0])
		usage(os.Stderr)
		os.Exit(2)
	}
}

func usage(to *os.File) {
	fmt.Fprintf(to, `rippel-agent %s — installs and manages ComfyUI on this machine for rippel.

  rippel-agent                     Set it up. This is what double-clicking does.
  rippel-agent install <link>      Set it up with the link from rippel, no questions.
  rippel-agent run                 Run in the foreground. This is what the service runs.
  rippel-agent status              Say whether it is installed, and what it can see.
  rippel-agent uninstall           Remove the service and the program. Keeps ComfyUI.
  rippel-agent version

The link comes from rippel: Settings, then Deployment, then the machine you are
setting up. It looks like http://192.168.1.9:4000/setup/xxxxxxxx
`, AgentVersion)
}

// ---------------------------------------------------------------- the service

func serviceLog(format string, args ...any) {
	fmt.Fprintf(os.Stdout, "%s rippel-agent %s\n",
		time.Now().UTC().Format(time.RFC3339), fmt.Sprintf(format, args...))
}

// runAgent is the long-running mode: listen, check in, and do as it is told.
func runAgent() error {
	cfg, err := LoadConfig()
	if err != nil {
		return err
	}
	if cfg.Token == "" {
		return fmt.Errorf(
			"refusing to start without a token.\n"+
				"Nothing has been set up on this machine yet. Run this program with no "+
				"arguments to set it up, or put a token in %s.", ConfigFile())
	}

	agent := NewAgent(cfg, nil)
	heartbeat := StartHeartbeat(agent, serviceLog)
	agent.onChange = heartbeat.Now

	address := net.JoinHostPort(cfg.Host, strconv.Itoa(cfg.Port))
	listener, err := net.Listen("tcp", address)
	if err != nil {
		if portInUse(err) {
			return fmt.Errorf(
				"port %d is already being used on this machine.\n"+
					"The rippel agent is probably already running. Check with: rippel-agent status",
				cfg.Port)
		}
		return fmt.Errorf("could not listen on %s: %w", address, err)
	}

	server := &http.Server{
		Handler: agent.Handler(),
		// A slow client must not be able to hold a connection forever, but an
		// install POST is answered in milliseconds (it returns a task id), so
		// these can be short.
		ReadHeaderTimeout: 10 * time.Second,
	}

	serviceLog("v%s on %s listening on %s", AgentVersion, hostname(), address)
	serviceLog("managing ComfyUI at %s (port %d)", cfg.ComfyPath, cfg.ComfyPort)
	if cfg.ServerURL != "" {
		serviceLog("checking in to %s every %ds", cfg.ServerURL, cfg.HeartbeatSeconds)
	}

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)

	serverErr := make(chan error, 1)
	go func() {
		err := server.Serve(listener)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		serverErr <- err
	}()

	select {
	case sig := <-signals:
		serviceLog("%s received, stopping", sig)
	case err := <-serverErr:
		return err
	}

	heartbeat.Stop()
	// ComfyUI is deliberately left running: it is a separate detached process
	// and an agent restart should never take the GPU down with it.
	_ = server.Close()
	return nil
}

// ---------------------------------------------------------------- commands

func commandInstall(args []string) int {
	say := func(format string, a ...any) { fmt.Printf(format+"\n", a...) }

	var setup Setup
	var err error
	switch {
	case len(args) > 0 && args[0] != "":
		setup, err = ParseSetupLink(args[0])
	default:
		found, source, ok := DiscoverSetup()
		if !ok {
			fmt.Fprintln(os.Stderr,
				"rippel-agent install needs the setup link from rippel.\n\n"+
					"  rippel-agent install http://192.168.1.9:4000/setup/xxxxxxxx\n\n"+
					"Find it in rippel under Settings, then Deployment.")
			return 2
		}
		setup = found
		say("Using the setup details from %s.", source)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "rippel-agent: %s\n", err)
		return 2
	}

	if err := Install(setup, say); err != nil {
		fmt.Fprintf(os.Stderr, "\n%s\n", err)
		return 1
	}
	say("")
	say("Done. rippel should show this machine as online within a minute.")
	return 0
}

func commandUninstall() int {
	if err := Uninstall(func(format string, a ...any) { fmt.Printf(format+"\n", a...) }); err != nil {
		fmt.Fprintf(os.Stderr, "%s\n", err)
		return 1
	}
	return 0
}

// commandStatus is what to tell someone to run when they ask "is it working?".
// It answers in sentences, not JSON.
func commandStatus() int {
	cfg, err := LoadConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "rippel-agent: %s\n", err)
		return 1
	}

	fmt.Printf("rippel-agent %s on %s (%s)\n", AgentVersion, hostname(), normalisePlatform())
	fmt.Printf("Settings:  %s\n", ConfigFile())
	if cfg.Token == "" {
		fmt.Println("Set up:    no — nothing has been set up on this machine yet.")
		fmt.Println("           Run this program with no arguments to set it up.")
		return 1
	}
	fmt.Printf("Set up:    yes, for %s\n", cfg.ServerURL)

	if reachable(cfg.Host, cfg.Port) {
		fmt.Printf("Running:   yes, listening on port %d\n", cfg.Port)
	} else {
		fmt.Printf("Running:   no — nothing is listening on port %d\n", cfg.Port)
	}

	state := ComfyStatus(cfg)
	switch {
	case !state.Installed:
		fmt.Printf("ComfyUI:   not installed yet (it would go in %s)\n", cfg.ComfyPath)
	case state.Running:
		fmt.Printf("ComfyUI:   installed and running on port %d\n", state.Port)
	default:
		fmt.Printf("ComfyUI:   installed at %s, not running\n", cfg.ComfyPath)
	}
	fmt.Printf("Graphics:  %s\n", DetectAccelerator())
	return 0
}

func reachable(host string, port int) bool {
	if host == "0.0.0.0" || host == "::" || host == "" {
		host = "127.0.0.1"
	}
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), 2*time.Second)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// ---------------------------------------------------------------- the person

// welcome is what a double-click runs.
//
// It must never do the two things that make someone give up: exit silently, or
// flash a black window and vanish. So it says what this program is before it
// does anything, and on Windows it holds the window open at the end whether it
// succeeded or failed — an error nobody can read is the same as no error
// message at all.
func welcome() int {
	defer pause()

	fmt.Println()
	fmt.Println("  rippel agent")
	fmt.Println("  ────────────")
	fmt.Println()
	fmt.Println("  This program lets rippel install and run ComfyUI on this computer.")
	fmt.Println("  It runs quietly in the background once it is set up.")
	fmt.Println()

	// Already set up? Then a double-click is someone checking on it, not
	// installing it. Telling them it is fine is the right answer.
	if cfg, err := LoadConfig(); err == nil && cfg.Token != "" {
		fmt.Printf("  This computer is already set up, for rippel at %s.\n\n", cfg.ServerURL)
		if reachable(cfg.Host, cfg.Port) {
			fmt.Println("  The agent is running. There is nothing for you to do.")
		} else {
			fmt.Println("  The agent is not running at the moment. Setting it up again will")
			fmt.Println("  start it. Press Enter to do that, or close this window to leave it.")
			fmt.Println()
			readLine("  Press Enter to start it again: ")
			if err := Install(Setup{ServerURL: cfg.ServerURL, Token: cfg.Token}, indented); err != nil {
				return fail(err)
			}
			fmt.Println()
			fmt.Println("  Done. rippel should show this computer as online within a minute.")
		}
		return 0
	}

	setup, source, found := DiscoverSetup()
	if found {
		fmt.Printf("  Setting up from %s.\n\n", source)
	} else {
		fmt.Println("  To set it up, this program needs the link from rippel.")
		fmt.Println()
		fmt.Println("  In rippel, go to Settings, then Deployment, and find this computer.")
		fmt.Println("  Copy the setup link. It looks like this:")
		fmt.Println()
		fmt.Println("      http://192.168.1.9:4000/setup/vT7kQ2...")
		fmt.Println()

		for attempt := 0; attempt < 3; attempt++ {
			line := readLine("  Paste the link here and press Enter: ")
			if strings.TrimSpace(line) == "" {
				fmt.Println()
				fmt.Println("  Nothing was pasted, so nothing was changed.")
				fmt.Println("  Run this program again when you have the link.")
				return 1
			}
			parsed, err := ParseSetupLink(line)
			if err == nil {
				setup = parsed
				break
			}
			fmt.Printf("\n  %s\n\n", err)
			if attempt == 2 {
				fmt.Println("  Nothing was changed. Run this program again when you have the link.")
				return 1
			}
		}
		fmt.Println()
	}

	if err := Install(setup, indented); err != nil {
		return fail(err)
	}
	fmt.Println()
	fmt.Println("  All done. rippel should show this computer as online within a minute.")
	fmt.Println("  You can close this window — the agent keeps running in the background.")
	return 0
}

func indented(format string, args ...any) {
	fmt.Printf("  "+format+"\n", args...)
}

// fail prints an error the way someone who cannot read a stack trace can use:
// indented under a heading, with its own line breaks preserved, and nothing
// about goroutines.
func fail(err error) int {
	fmt.Println()
	fmt.Println("  It did not work.")
	fmt.Println()
	for _, line := range strings.Split(err.Error(), "\n") {
		fmt.Printf("  %s\n", line)
	}
	fmt.Println()
	fmt.Println("  Nothing on this computer was changed that needs undoing.")
	return 1
}

// stdin is read through one shared buffered reader, created once.
//
// A fresh bufio.Reader per prompt reads ahead and then throws its buffer away
// with itself, so the second question silently eats the answer to the third.
// That is invisible at a terminal and obvious the moment anything is piped in —
// including the SSH install path.
var stdin = bufio.NewReader(os.Stdin)

func readLine(prompt string) string {
	fmt.Print(prompt)
	line, err := stdin.ReadString('\n')
	if err != nil && line == "" {
		// No stdin at all — piped from /dev/null, or a service that should not
		// have got here. Treat it as an empty answer rather than looping.
		fmt.Println()
		return ""
	}
	return strings.TrimSpace(line)
}

// pause keeps a double-clicked window open long enough to read.
//
// Only when the console belongs to this process alone: run from a shell there
// is nothing to wait for, and pausing would make the command hang.
func pause() {
	if !looksLikeDoubleClick() {
		return
	}
	fmt.Println()
	fmt.Print("  Press Enter to close this window. ")
	_, _ = stdin.ReadString('\n')
}

var _ = filepath.Join
