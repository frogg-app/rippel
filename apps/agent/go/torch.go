package main

// Windows ROCm wheels come from AMD's multi-architecture index. The ordinary
// PyTorch ROCm index is Linux-only. Pin the tested package combination and only
// download kernels for the detected GPU; never silently fall back to CPU/CUDA.
// Sources: ComfyUI README (ROCm 10.0), ROCm/TheRock RELEASES.md, 2026-09-12.
import (
	"fmt"
	"os/exec"
	"strings"
)

func windowsGPUName() string {
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name")
	hideConsole(cmd)
	data, err := cmd.Output()
	if err != nil {
		return ""
	}
	return string(data)
}
func windowsROCmTarget(name string) (string, error) {
	name = strings.ToLower(name)
	groups := []struct {
		target string
		names  []string
	}{
		{"gfx1030", []string{"6900", "6950", "6800", "w6800", "v620"}},
		{"gfx1031", []string{"6700", "6750"}},
		{"gfx1032", []string{"6600", "6650", "w6600"}},
		{"gfx1100", []string{"7900", "w7900", "w7800"}},
		{"gfx1101", []string{"7800", "7700", "w7700"}},
		{"gfx1102", []string{"7600"}},
		{"gfx1201", []string{"9070", "r9700"}},
		{"gfx1200", []string{"9060"}},
	}
	for _, group := range groups {
		for _, token := range group.names {
			if strings.Contains(name, token) {
				return group.target, nil
			}
		}
	}
	return "", fmt.Errorf("Cannot choose Windows ROCm kernels for GPU %q. A supported AMD GPU must be detected before installing", strings.TrimSpace(name))
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
		pins := []string{"torch==2.13.0+rocm10.0.0", "torchvision==0.28.0+rocm10.0.0", "torchaudio==2.11.0.2+rocm10.0.0"}
		return []string{"-m", "pip", "install", "--index-url", "https://stable.repo.amd.com/rocm/whl-next/",
			"torch[device-" + target + "]==2.13.0+rocm10.0.0", "torchvision[device-" + target + "]==0.28.0+rocm10.0.0", pins[2]}, strings.Join(pins, "\n") + "\n", nil
	}
	if accelerator == "cuda" {
		return []string{"-m", "pip", "install", "torch>=2.7", "torchvision>=0.22", "torchaudio>=2.7", "--index-url", torchIndex(accelerator)}, "", nil
	}
	return []string{"-m", "pip", "install", "torch", "torchvision", "torchaudio", "--index-url", torchIndex(accelerator)}, "", nil
}
