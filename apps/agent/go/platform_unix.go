//go:build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

// The Unix half of the three things the agent cannot do portably: read free
// disk space, test and kill a process by pid, and start ComfyUI detached.
//
// This file and platform_windows.go are deliberately the *only* places with a
// build tag. Everything else compiles identically for every target, so a
// cross-build that cannot be run here has a very small surface that differs
// from the binary that was tested.

// diskSpace returns free and total bytes on the volume holding path.
func diskSpace(path string) (free *int64, total *int64) {
	var fs syscall.Statfs_t
	if err := syscall.Statfs(path, &fs); err != nil {
		return nil, nil
	}
	f := int64(fs.Bavail) * int64(fs.Bsize)
	t := int64(fs.Blocks) * int64(fs.Bsize)
	return &f, &t
}

// processAlive tests whether a pid is still a live process. Signal 0 tests, it
// does not kill. EPERM means it exists and belongs to someone else, which still
// counts as alive.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	if err == nil {
		return true
	}
	return err == syscall.EPERM
}

// terminateProcess asks politely. SIGTERM lets ComfyUI finish writing whatever
// it was writing.
func terminateProcess(pid int) {
	_ = syscall.Kill(pid, syscall.SIGTERM)
}

// killProcess is the ungentle follow-up, for a ComfyUI wedged in a CUDA call
// that cannot answer a SIGTERM.
func killProcess(pid int) {
	_ = syscall.Kill(pid, syscall.SIGKILL)
}

// detach makes the child its own session leader, so it survives the agent
// exiting or its service being restarted. Anything else and a service restart
// of the agent takes the GPU down with it.
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

// hideConsole is a no-op off Windows; there is no console to hide.
func hideConsole(cmd *exec.Cmd) {}

// looksLikeDoubleClick is always false here: nobody double-clicks a binary on a
// headless Linux box, and guessing wrong would leave a service waiting on a
// prompt nobody can answer.
func looksLikeDoubleClick() bool { return false }

var _ = os.Getpid

func prepareBackground()                                 {}
func openInstalledPanel() bool                           { return false }
func startDesktop(a *Agent, quit func()) (func(), error) { return nil, nil }

func prepareForeground(command string, argc int) {}
