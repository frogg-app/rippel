//go:build windows

package main

import (
	"os/exec"
	"syscall"
	"unsafe"
)

// The Windows half of the three things the agent cannot do portably: read free
// disk space, test and kill a process by pid, and start ComfyUI detached. Plus
// one Windows-only question — was this exe double-clicked?
//
// This file and platform_unix.go are deliberately the *only* places with a
// build tag, and this one cannot be executed on the Linux box it is built from.
// So it is kept short, uses documented kernel32 calls only, and every failure
// falls back to the same answer an absent capability would give.

var (
	kernel32 = syscall.NewLazyDLL("kernel32.dll")

	procGetDiskFreeSpaceExW  = kernel32.NewProc("GetDiskFreeSpaceExW")
	procGetConsoleProcessList = kernel32.NewProc("GetConsoleProcessList")
	procOpenProcess          = kernel32.NewProc("OpenProcess")
	procGetExitCodeProcess   = kernel32.NewProc("GetExitCodeProcess")
	procCloseHandle          = kernel32.NewProc("CloseHandle")
)

const (
	stillActive              = 259
	processQueryLimitedInfo  = 0x1000
	createNewProcessGroup    = 0x00000200
	detachedProcess          = 0x00000008
)

// diskSpace returns free and total bytes on the volume holding path.
func diskSpace(path string) (free *int64, total *int64) {
	wide, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, nil
	}
	var freeToCaller, totalBytes, totalFree uint64
	ret, _, _ := procGetDiskFreeSpaceExW.Call(
		uintptr(unsafe.Pointer(wide)),
		uintptr(unsafe.Pointer(&freeToCaller)),
		uintptr(unsafe.Pointer(&totalBytes)),
		uintptr(unsafe.Pointer(&totalFree)),
	)
	if ret == 0 {
		return nil, nil
	}
	f := int64(freeToCaller)
	t := int64(totalBytes)
	return &f, &t
}

// processAlive asks the kernel whether that pid still has an exit code pending.
// A handle we cannot open is treated as alive: the process exists and belongs
// to someone else, which is the same conclusion EPERM gives on Unix.
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	handle, _, _ := procOpenProcess.Call(processQueryLimitedInfo, 0, uintptr(pid))
	if handle == 0 {
		return false
	}
	defer procCloseHandle.Call(handle)

	var code uint32
	ret, _, _ := procGetExitCodeProcess.Call(handle, uintptr(unsafe.Pointer(&code)))
	if ret == 0 {
		return true
	}
	return code == stillActive
}

// terminateProcess and killProcess are the same call on Windows: there are no
// signals, so taskkill /T takes the tree. The venv python is a child of nothing
// else, so the tree is exactly ComfyUI.
func terminateProcess(pid int) { taskkill(pid, false) }

func killProcess(pid int) { taskkill(pid, true) }

func taskkill(pid int, force bool) {
	args := []string{"/PID", itoa(pid), "/T"}
	if force {
		args = append(args, "/F")
	}
	cmd := exec.Command("taskkill", args...)
	hideConsole(cmd)
	_ = cmd.Run()
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}

// detach starts ComfyUI with no console and its own process group, so closing
// the window the agent was started from does not take the GPU down with it.
func detach(cmd *exec.Cmd) {
	attr := cmd.SysProcAttr
	if attr == nil {
		attr = &syscall.SysProcAttr{}
	}
	attr.CreationFlags |= createNewProcessGroup | detachedProcess
	cmd.SysProcAttr = attr
}

// hideConsole keeps a helper command from flashing a black window at whoever is
// sitting at the machine.
func hideConsole(cmd *exec.Cmd) {
	attr := cmd.SysProcAttr
	if attr == nil {
		attr = &syscall.SysProcAttr{}
	}
	attr.HideWindow = true
	cmd.SysProcAttr = attr
}

// looksLikeDoubleClick reports whether this process owns its console alone.
//
// Explorer creates a fresh console for a double-clicked exe, and that console
// dies the instant the process does — which is the "flashes and vanishes"
// failure the whole interactive path exists to prevent. Run from an existing
// cmd or PowerShell, the console is shared with that shell, so the list has
// more than one process in it and there is nothing to wait for.
//
// A failed call answers false, which is the safe direction: a service that
// paused for a keypress nobody can send would never start.
func looksLikeDoubleClick() bool {
	var pids [4]uint32
	count, _, _ := procGetConsoleProcessList.Call(
		uintptr(unsafe.Pointer(&pids[0])),
		uintptr(len(pids)),
	)
	return count == 1
}
