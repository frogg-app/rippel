package main

import (
	"strings"
	"testing"
)

func TestWindowsROCmUsesAMDWindowsWheels(t *testing.T) {
	args, constraints, err := torchInstallArgs("windows", "rocm", "AMD Radeon RX 6900 XT")
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "stable.repo.amd.com") || !strings.Contains(joined, "torch[device-gfx1030]==") || strings.Contains(joined, "rocm6.2") {
		t.Fatal(joined)
	}
	if !strings.Contains(constraints, "torch==2.13.0+rocm10.0.0") {
		t.Fatal(constraints)
	}
}
func TestROCmRefusesUnknownGPUAndAccelerator(t *testing.T) {
	if _, _, err := torchInstallArgs("windows", "rocm", "Unknown GPU"); err == nil {
		t.Fatal("guessed unknown GPU")
	}
	if _, _, err := torchInstallArgs("linux", "typo", ""); err == nil {
		t.Fatal("silently chose CUDA")
	}
	args, _, err := torchInstallArgs("linux", "rocm", "")
	if err != nil || !strings.Contains(strings.Join(args, " "), "download.pytorch.org/whl/rocm") {
		t.Fatal(args, err)
	}
}
