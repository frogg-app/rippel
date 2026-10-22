package main

// Windows ROCm wheels come from AMD's multi-architecture index. The ordinary
// PyTorch ROCm index is Linux-only. Pin the tested package combination and only
// download kernels for the chosen GPU. Every gfx target AMD publishes an extra
// for is listed in ROCm/TheRock RELEASES.md (checked 2026-10-23), including the
// Ryzen iGPUs; a wheel built for one target has no kernels for another, and
// running on the wrong device fails with hipErrorInvalidImage.
import (
	"fmt"
	"os/exec"
	"regexp"
	"strings"
)

const rocmWindowsIndex = "https://stable.repo.amd.com/rocm/whl-next/"

var rocmWindowsPins = []string{"torch==2.13.0+rocm10.0.0", "torchvision==0.28.0+rocm10.0.0", "torchaudio==2.11.0.2+rocm10.0.0"}

// windowsGPUName is every display adapter, one per line. A Ryzen desktop lists
// its integrated "AMD Radeon(TM) Graphics" beside the real card.
func windowsGPUName() string {
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name")
	hideConsole(cmd)
	data, err := cmd.Output()
	if err != nil {
		return ""
	}
	return string(data)
}

// rocmGroups maps marketing-name tokens to gfx targets, most specific first
// (W7800 is gfx1100 even though "7800" alone is gfx1101).
var rocmGroups = []struct {
	target string
	names  []string
}{
	{"gfx1100", []string{"7900", "w7900", "w7800"}},
	{"gfx1101", []string{"7800", "7700", "w7700"}},
	{"gfx1102", []string{"7600", "7650", "w7600"}},
	{"gfx1201", []string{"9070", "r9700", "r9600"}},
	{"gfx1200", []string{"9060"}},
	{"gfx1151", []string{"8060s", "8050s", "8040s"}},
	{"gfx1150", []string{"890m", "880m"}},
	{"gfx1103", []string{"780m", "760m", "740m"}},
	{"gfx1035", []string{"680m", "660m"}},
	{"gfx1030", []string{"6900", "6950", "6800", "w6800", "v620"}},
	{"gfx1031", []string{"6700", "6750"}},
	{"gfx1032", []string{"6600", "6650", "w6600"}},
	{"gfx1034", []string{"6500", "6400"}},
}

// integratedName is the name Windows gives an iGPU it has no model for.
var integratedName = regexp.MustCompile(`(?i)radeon\s*(\(tm\))?\s*(graphics|vega)`)

func rocmTargetForName(name string) string {
	lower := strings.ToLower(name)
	for _, group := range rocmGroups {
		for _, token := range group.names {
			if strings.Contains(lower, token) {
				return group.target
			}
		}
	}
	return ""
}

// windowsROCmTarget picks the discrete card's target when there is one: the
// generic iGPU line never matches, and a named iGPU (780M, 8060S) is only used
// when it is the only AMD GPU.
func windowsROCmTarget(names string) (string, error) {
	fallback := ""
	for _, line := range strings.Split(names, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || integratedName.MatchString(line) {
			continue
		}
		target := rocmTargetForName(line)
		if target == "" {
			continue
		}
		if !isIntegratedTarget(target) {
			return target, nil
		}
		if fallback == "" {
			fallback = target
		}
	}
	if fallback != "" {
		return fallback, nil
	}
	return "", fmt.Errorf("Cannot choose Windows ROCm kernels for GPU %q. A supported AMD GPU must be detected before installing", strings.TrimSpace(names))
}

// isIntegratedTarget is true for the gfx targets AMD ships only as iGPUs.
// Strix Halo (gfx1151) is an iGPU too, but it is the whole GPU of its machine.
func isIntegratedTarget(target string) bool {
	switch target {
	case "gfx90c", "gfx1033", "gfx1035", "gfx1036", "gfx1037", "gfx1103", "gfx1150", "gfx1152", "gfx1153":
		return true
	}
	return false
}

// rocmWheelTargets is every device extra AMD publishes for Windows.
var rocmWheelTargets = map[string]bool{
	"gfx1010": true, "gfx1011": true, "gfx1012": true,
	"gfx1030": true, "gfx1031": true, "gfx1032": true, "gfx1033": true, "gfx1034": true, "gfx1035": true, "gfx1036": true,
	"gfx1100": true, "gfx1101": true, "gfx1102": true, "gfx1103": true,
	"gfx1150": true, "gfx1151": true, "gfx1152": true, "gfx1153": true,
	"gfx1200": true, "gfx1201": true,
}

// baseArch strips HIP's feature suffix: "gfx1030:sramecc-:xnack-" is gfx1030.
func baseArch(arch string) string {
	return strings.ToLower(strings.TrimSpace(strings.SplitN(arch, ":", 2)[0]))
}

// rocmWindowsArgs installs the pinned torch with kernels for one target.
func rocmWindowsArgs(target string) ([]string, string) {
	return []string{"-m", "pip", "install", "--index-url", rocmWindowsIndex,
		"torch[device-" + target + "]==2.13.0+rocm10.0.0", "torchvision[device-" + target + "]==0.28.0+rocm10.0.0", rocmWindowsPins[2]}, strings.Join(rocmWindowsPins, "\n") + "\n"
}

func torchInstallArgs(platform, accelerator, gpuName string) ([]string, string, error) {
	if accelerator != "cpu" && accelerator != "cuda" && accelerator != "rocm" {
		return nil, "", fmt.Errorf("Unknown accelerator %q; choose cpu, cuda or rocm", accelerator)
	}
	if platform == "windows" && accelerator == "rocm" {
		target, err := windowsROCmTarget(gpuName)
		if err != nil {
			return nil, "", err
		}
		args, constraints := rocmWindowsArgs(target)
		return args, constraints, nil
	}
	if accelerator == "cuda" {
		return []string{"-m", "pip", "install", "torch>=2.7", "torchvision>=0.22", "torchaudio>=2.7", "--index-url", torchIndex(accelerator)}, "", nil
	}
	return []string{"-m", "pip", "install", "torch", "torchvision", "torchaudio", "--index-url", torchIndex(accelerator)}, "", nil
}
