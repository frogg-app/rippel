package main

// Whether the installed torch can actually run on this machine's GPU.
//
// "torch.cuda.is_available()" is not that question. A Ryzen desktop with an
// RX 6900 XT enumerates its iGPU (gfx1036) as HIP device 0, and a wheel built
// for gfx1030 has no kernels for it: ComfyUI starts, loads a checkpoint, and
// the first convolution fails with hipErrorInvalidImage ("device kernel image
// is invalid"). NVIDIA's version is "no kernel image is available" on a card
// newer than the CUDA build. So the agent runs one real convolution on each
// device, pins ComfyUI to the first that works, and when none does tries the
// build for the architecture the device itself reports, then CPU.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

// GPUHealth is the wire shape of packages/shared's GpuHealth.
type GPUHealth struct {
	// ready | unsupported | cpu | checking
	State     string `json:"state"`
	Device    string `json:"device,omitempty"`
	Arch      string `json:"arch,omitempty"`
	Torch     string `json:"torch,omitempty"`
	Detail    string `json:"detail,omitempty"`
	CheckedAt string `json:"checkedAt,omitempty"`
}

type torchDevice struct {
	Index  int    `json:"index"`
	Name   string `json:"name"`
	Arch   string `json:"arch"`
	Memory int64  `json:"memory"`
}

type torchReport struct {
	Torch   string        `json:"torch"`
	HIP     *string       `json:"hip"`
	Devices []torchDevice `json:"devices"`
	OK      bool          `json:"ok"`
	Error   string        `json:"error"`
}

// The test is a VAE-sized fp16 convolution: the same kernel family VAEEncode
// faulted in. Kernel errors are asynchronous, hence the synchronize.
const gpuProbeScript = `
import json, sys
out = {"torch": "", "hip": None, "devices": [], "ok": False, "error": ""}
try:
    import torch
    out["torch"] = torch.__version__
    out["hip"] = getattr(torch.version, "hip", None)
    if not torch.cuda.is_available():
        out["error"] = "torch sees no GPU"
    else:
        for i in range(torch.cuda.device_count()):
            p = torch.cuda.get_device_properties(i)
            arch = getattr(p, "gcnArchName", "") or ("sm_%d%d" % (p.major, p.minor))
            out["devices"].append({"index": i, "name": p.name, "arch": arch, "memory": p.total_memory})
        if sys.argv[-1] == "test":
            d = torch.device("cuda:0")
            x = torch.randn(1, 128, 256, 256, device=d, dtype=torch.float16)
            w = torch.randn(128, 128, 3, 3, device=d, dtype=torch.float16)
            y = torch.nn.functional.conv2d(x, w, padding=1)
            torch.cuda.synchronize()
            out["ok"] = bool(torch.isfinite(y.float().mean()).item())
            if not out["ok"]:
                out["error"] = "the test convolution returned garbage"
except Exception as e:
    out["error"] = str(e).strip()
print("RIPPEL_GPU " + json.dumps(out), flush=True)
`

var visibilityVars = []string{"HIP_VISIBLE_DEVICES", "CUDA_VISIBLE_DEVICES", "ROCR_VISIBLE_DEVICES"}

// withoutVisibility drops inherited device masks, so indices mean what the
// probe saw.
func withoutVisibility(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		keep := true
		for _, name := range visibilityVars {
			if strings.HasPrefix(strings.ToUpper(kv), name+"=") {
				keep = false
			}
		}
		if keep {
			out = append(out, kv)
		}
	}
	return out
}

// gpuEnvFor is the one variable that pins a device. Only one is set: HIP also
// honours CUDA_VISIBLE_DEVICES, and two masks would filter twice.
func gpuEnvFor(report torchReport, index int) string {
	if report.HIP != nil && *report.HIP != "" {
		return "HIP_VISIBLE_DEVICES=" + strconv.Itoa(index)
	}
	return "CUDA_VISIBLE_DEVICES=" + strconv.Itoa(index)
}

var runTorchProbe = func(cfg *Config, mode, pin string) (torchReport, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, venvPython(cfg), "-c", gpuProbeScript, mode)
	cmd.Dir = cfg.ComfyPath
	cmd.Env = withoutVisibility(os.Environ())
	if pin != "" {
		cmd.Env = append(cmd.Env, pin)
	}
	hideConsole(cmd)
	raw, err := cmd.CombinedOutput()
	return parseProbe(string(raw), err)
}

// parseProbe reads the marker line. A process that died without one (a driver
// crash takes Python with it) is a failure carrying its last output.
func parseProbe(output string, runErr error) (torchReport, error) {
	for _, line := range strings.Split(output, "\n") {
		if rest, ok := strings.CutPrefix(strings.TrimSpace(line), "RIPPEL_GPU "); ok {
			var report torchReport
			if err := json.Unmarshal([]byte(rest), &report); err != nil {
				return torchReport{}, err
			}
			return report, nil
		}
	}
	tail := strings.TrimSpace(output)
	if len(tail) > 600 {
		tail = tail[len(tail)-600:]
	}
	if runErr != nil {
		return torchReport{}, fmt.Errorf("GPU test crashed: %v %s", runErr, tail)
	}
	return torchReport{}, fmt.Errorf("GPU test said nothing: %s", tail)
}

// orderDevices tries the device the wheel was built for first, then discrete
// cards by size. An iGPU's "memory" is borrowed system RAM, so size alone
// would put it first.
func orderDevices(devices []torchDevice, target string) []torchDevice {
	out := append([]torchDevice(nil), devices...)
	score := func(d torchDevice) int {
		s := 0
		if target != "" && baseArch(d.Arch) == target {
			s += 2
		}
		if !isIntegratedTarget(baseArch(d.Arch)) {
			s++
		}
		return s
	}
	sort.SliceStable(out, func(i, j int) bool {
		if score(out[i]) != score(out[j]) {
			return score(out[i]) > score(out[j])
		}
		return out[i].Memory > out[j].Memory
	})
	return out
}

func gpuTargetFile(cfg *Config) string { return filepath.Join(cfg.ComfyPath, ".rippel-gpu-target") }

func installedGPUTarget(cfg *Config) string {
	raw, _ := os.ReadFile(gpuTargetFile(cfg))
	return strings.TrimSpace(string(raw))
}

func now() string { return time.Now().UTC().Format(time.RFC3339) }

// checkGPU runs the test on each device in turn. The pin is empty when there
// is one device, so a single-GPU machine starts ComfyUI exactly as before.
func checkGPU(cfg *Config, log func(string, ...any)) (GPUHealth, string) {
	list, err := runTorchProbe(cfg, "list", "")
	if err != nil {
		return GPUHealth{State: "unsupported", Detail: err.Error(), CheckedAt: now()}, ""
	}
	if len(list.Devices) == 0 {
		return GPUHealth{State: "unsupported", Torch: list.Torch, Detail: list.Error, CheckedAt: now()}, ""
	}
	firstErr := ""
	for _, device := range orderDevices(list.Devices, installedGPUTarget(cfg)) {
		pin := ""
		if len(list.Devices) > 1 {
			pin = gpuEnvFor(list, device.Index)
		}
		log("testing %s (%s)", device.Name, baseArch(device.Arch))
		result, err := runTorchProbe(cfg, "test", pin)
		detail := result.Error
		if err != nil {
			detail = err.Error()
		}
		if err == nil && result.OK {
			return GPUHealth{State: "ready", Device: device.Name, Arch: baseArch(device.Arch), Torch: list.Torch, CheckedAt: now()}, pin
		}
		log("%s failed: %s", device.Name, detail)
		if firstErr == "" {
			firstErr = fmt.Sprintf("%s (%s): %s", device.Name, baseArch(device.Arch), detail)
		}
	}
	best := orderDevices(list.Devices, installedGPUTarget(cfg))[0]
	return GPUHealth{State: "unsupported", Device: best.Name, Arch: baseArch(best.Arch), Torch: list.Torch, Detail: firstErr, CheckedAt: now()}, ""
}

// gpuBuild is one torch install the repair can try.
type gpuBuild struct {
	label       string
	args        []string
	constraints string
	target      string
}

// repairBuilds are the GPU builds worth trying after the installed one failed,
// from what the devices themselves report: AMD wheels for each discrete arch
// (then iGPU arches), and NVIDIA's newer CUDA build for cards the default
// build predates.
func repairBuilds(goos string, list torchReport, installedTarget string) []gpuBuild {
	var builds []gpuBuild
	if list.HIP != nil && *list.HIP != "" && goos == "windows" {
		seen := map[string]bool{installedTarget: true}
		for _, device := range orderDevices(list.Devices, "") {
			target := baseArch(device.Arch)
			if seen[target] || !rocmWheelTargets[target] {
				continue
			}
			seen[target] = true
			args, constraints := rocmWindowsArgs(target)
			builds = append(builds, gpuBuild{label: "ROCm for " + target, args: args, constraints: constraints, target: target})
		}
		return builds
	}
	if list.HIP == nil && len(list.Devices) > 0 {
		builds = append(builds, gpuBuild{label: "CUDA 12.8", args: []string{"-m", "pip", "install", "--force-reinstall",
			"torch>=2.7", "torchvision>=0.22", "torchaudio>=2.7", "--index-url", "https://download.pytorch.org/whl/cu128"}})
	}
	return builds
}

// gpuFingerprint changes when the drivers or the installed torch do, which is
// when a passing test stops meaning anything.
func gpuFingerprint(cfg *Config) string {
	parts := []string{gpuAdapters()}
	matches, _ := filepath.Glob(filepath.Join(venvPath(cfg), "Lib", "site-packages", "torch", "version.py"))
	more, _ := filepath.Glob(filepath.Join(venvPath(cfg), "lib", "python3*", "site-packages", "torch", "version.py"))
	for _, path := range append(matches, more...) {
		if raw, err := os.ReadFile(path); err == nil {
			parts = append(parts, string(raw))
		}
	}
	return strings.Join(parts, "\n")
}

func gpuAdapters() string {
	if runtime.GOOS != "windows" {
		paths, _ := filepath.Glob("/sys/class/drm/card*/device/uevent")
		return strings.Join(paths, ",")
	}
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
		"Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + '|' + $_.DriverVersion }")
	hideConsole(cmd)
	data, _ := cmd.Output()
	return strings.TrimSpace(string(data))
}

// setGPU updates the in-memory config and config.json together.
func (a *Agent) setGPU(health GPUHealth, pin string, fallback string, fingerprint string) {
	a.mu.Lock()
	h := health
	a.cfg.GPUHealth = &h
	a.cfg.GPUEnv = pin
	a.cfg.GPUFallback = fallback
	if fingerprint != "" {
		a.cfg.GPUFingerprint = fingerprint
	}
	a.mu.Unlock()
	patch := map[string]any{"gpuHealth": health, "gpuEnv": pin, "gpuFallback": fallback}
	if fingerprint != "" {
		patch["gpuFingerprint"] = fingerprint
	}
	_ = SaveConfig(patch)
	a.changed()
}

func (a *Agent) markChecking() {
	a.mu.Lock()
	previous := GPUHealth{}
	if a.cfg.GPUHealth != nil {
		previous = *a.cfg.GPUHealth
	}
	previous.State = "checking"
	a.cfg.GPUHealth = &previous
	a.mu.Unlock()
	a.changed()
}

// installTorch swaps the venv's torch. ComfyUI holds the DLLs open on
// Windows, so it is stopped first; the caller restarts it.
func installTorch(cfg *Config, task *Task, build gpuBuild) error {
	if err := Run(task, cfg.ComfyPath, withoutVisibility(os.Environ()), venvPython(cfg), build.args...); err != nil {
		return err
	}
	constraintPath := filepath.Join(cfg.ComfyPath, ".rippel-torch-constraints.txt")
	if build.constraints != "" {
		if err := os.WriteFile(constraintPath, []byte(build.constraints), 0o600); err != nil {
			return err
		}
	} else {
		_ = os.Remove(constraintPath)
	}
	if build.target != "" {
		_ = os.WriteFile(gpuTargetFile(cfg), []byte(build.target+"\n"), 0o644)
	} else {
		_ = os.Remove(gpuTargetFile(cfg))
	}
	return nil
}

// RepairGPU tests the GPU and, when it fails, tries each compatible build and
// finally CPU. It never leaves ComfyUI stopped if it was running.
func (a *Agent) RepairGPU(task *Task) error {
	cfg := a.config()
	if !exists(venvPython(cfg)) {
		return errors.New("ComfyUI is not installed yet.")
	}
	a.markChecking()
	wasRunning := ComfyStatus(cfg).Running
	startedWith := cfg.GPUEnv
	stopped := false
	stop := func() {
		if !stopped && wasRunning {
			task.Append("stopping ComfyUI to change its graphics libraries")
			_, _ = StopComfy(a.config(), 10*time.Second)
			stopped = true
		}
	}
	finish := func(health GPUHealth, pin, fallback string) error {
		a.setGPU(health, pin, fallback, gpuFingerprint(a.config()))
		if wasRunning && (stopped || pin != startedWith || fallback != cfg.GPUFallback) {
			task.Append("restarting ComfyUI")
			_, _ = StopComfy(a.config(), 10*time.Second)
			if _, err := StartComfy(a.config()); err != nil {
				return err
			}
		}
		switch health.State {
		case "ready":
			task.Appendf("GPU ready: %s", health.Device)
		case "cpu":
			task.Append("No working GPU build; ComfyUI now runs on the processor.")
		default:
			task.Appendf("GPU not supported by this build: %s", health.Detail)
		}
		return nil
	}

	// Coming back from CPU: put the GPU build back before testing.
	if cfg.GPUFallback == "cpu" {
		accelerator := DetectAccelerator()
		if accelerator != "cpu" {
			gpuName := ""
			if runtime.GOOS == "windows" {
				gpuName = windowsGPUName()
			}
			args, constraints, err := torchInstallArgs(runtime.GOOS, accelerator, gpuName)
			if err == nil {
				target, _ := windowsROCmTarget(gpuName)
				if runtime.GOOS != "windows" || accelerator != "rocm" {
					target = ""
				}
				stop()
				args = append([]string{args[0], args[1], args[2], "--force-reinstall"}, args[3:]...)
				if err := installTorch(cfg, task, gpuBuild{args: args, constraints: constraints, target: target}); err != nil {
					task.Appendf("could not reinstall the GPU build: %s", err)
				}
			}
		}
	}

	health, pin := checkGPU(cfg, task.Appendf)
	if health.State == "ready" {
		return finish(health, pin, "")
	}

	if list, err := runTorchProbe(cfg, "list", ""); err == nil {
		for _, build := range repairBuilds(runtime.GOOS, list, installedGPUTarget(cfg)) {
			task.Appendf("trying %s", build.label)
			stop()
			if err := installTorch(cfg, task, build); err != nil {
				task.Appendf("%s did not install: %s", build.label, err)
				continue
			}
			if next, nextPin := checkGPU(cfg, task.Appendf); next.State == "ready" {
				return finish(next, nextPin, "")
			}
		}
	}

	task.Append("falling back to the processor")
	stop()
	cpu := gpuBuild{label: "CPU", args: []string{"-m", "pip", "install", "--force-reinstall", "torch", "torchvision", "torchaudio", "--index-url", torchIndex("cpu")}}
	if err := installTorch(cfg, task, cpu); err != nil {
		task.Appendf("CPU build did not install: %s", err)
		return finish(health, "", "")
	}
	return finish(GPUHealth{State: "cpu", Device: health.Device, Arch: health.Arch, Detail: health.Detail, CheckedAt: now()}, "", "cpu")
}

// CheckGPUOnStart re-tests when the drivers or torch changed since the last
// test, or when there has never been one. It runs as an ordinary task, so the
// machine card shows it.
func (a *Agent) CheckGPUOnStart() {
	cfg := a.config()
	if !exists(venvPython(cfg)) || a.tasks.IsRunning("repair-gpu") {
		return
	}
	if cfg.GPUHealth != nil && cfg.GPUFingerprint != "" && cfg.GPUFingerprint == gpuFingerprint(cfg) {
		return
	}
	a.taskStartMu.Lock()
	if a.hasRunningTasks() {
		a.taskStartMu.Unlock()
		return
	}
	task := a.tasks.Create("repair-gpu")
	a.taskStartMu.Unlock()
	a.tasks.Finish(task, a.RepairGPU(task))
}

// comfyGPUEnv is what StartComfy adds for the GPU: the pinned device, with
// any inherited mask removed.
func comfyGPUEnv(cfg *Config, env []string) []string {
	if cfg.GPUEnv == "" {
		return env
	}
	return append(withoutVisibility(env), cfg.GPUEnv)
}

// comfyGPUArgs adds --cpu when the repair fell back to the processor.
func comfyGPUArgs(cfg *Config, args []string) []string {
	if cfg.GPUFallback != "cpu" {
		return args
	}
	for _, arg := range args {
		if arg == "--cpu" {
			return args
		}
	}
	return append(args, "--cpu")
}
