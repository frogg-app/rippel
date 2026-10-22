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

func TestCUDARequiresTorchThatCanImportCurrentComfyUI(t *testing.T) {
	for _, platform := range []string{"windows", "linux"} {
		args, _, err := torchInstallArgs(platform, "cuda", "")
		joined := strings.Join(args, " ")
		if err != nil || !strings.Contains(joined, "torch>=2.7") || !strings.Contains(joined, "/cu126") {
			t.Fatalf("%s: %v %v", platform, args, err)
		}
	}
}

// A Ryzen desktop lists its iGPU first; the wheel must be for the card.
func TestWindowsROCmPrefersTheDiscreteCard(t *testing.T) {
	cases := map[string]string{
		"AMD Radeon(TM) Graphics\r\nAMD Radeon RX 6900 XT\r\n": "gfx1030",
		"AMD Radeon 780M Graphics\nAMD Radeon RX 7900 GRE":    "gfx1100",
		"AMD Radeon Pro W7800":                                "gfx1100",
		"AMD Radeon RX 9060 XT":                               "gfx1200",
		"AMD Radeon 8060S Graphics":                           "gfx1151",
		"AMD Radeon 780M Graphics":                            "gfx1103",
	}
	for names, want := range cases {
		if got, err := windowsROCmTarget(names); err != nil || got != want {
			t.Errorf("%q: got %q %v, want %q", names, got, err, want)
		}
	}
	if _, err := windowsROCmTarget("AMD Radeon(TM) Graphics"); err == nil {
		t.Error("guessed a target for an unnamed iGPU")
	}
}
