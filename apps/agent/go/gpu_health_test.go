package main

import (
	"errors"
	"strings"
	"testing"
)

func hip() *string { s := "7.1"; return &s }

// steve-pc: HIP device 0 is the gfx1036 iGPU with 39 GB of shared memory.
var steveDevices = []torchDevice{
	{Index: 0, Name: "AMD Radeon(TM) Graphics", Arch: "gfx1036", Memory: 39232454656},
	{Index: 1, Name: "AMD Radeon RX 6900 XT", Arch: "gfx1030:sramecc-:xnack-", Memory: 17163091968},
}

func TestOrderDevicesPutsTheWheelsCardBeforeTheIGPU(t *testing.T) {
	if got := orderDevices(steveDevices, "gfx1030")[0].Index; got != 1 {
		t.Fatal(got)
	}
	// Unknown install target: discrete still beats the bigger shared pool.
	if got := orderDevices(steveDevices, "")[0].Index; got != 1 {
		t.Fatal(got)
	}
}

func TestCheckGPUPinsTheDeviceThatPasses(t *testing.T) {
	restore := runTorchProbe
	defer func() { runTorchProbe = restore }()
	var pins []string
	runTorchProbe = func(cfg *Config, mode, pin string) (torchReport, error) {
		report := torchReport{Torch: "2.13.0+rocm10.0.0", HIP: hip(), Devices: steveDevices}
		if mode == "test" {
			pins = append(pins, pin)
			report.OK = pin == "HIP_VISIBLE_DEVICES=1"
			if !report.OK {
				report.Error = "HIP error: device kernel image is invalid"
			}
		}
		return report, nil
	}
	health, pin := checkGPU(&Config{ComfyPath: t.TempDir()}, func(string, ...any) {})
	if health.State != "ready" || pin != "HIP_VISIBLE_DEVICES=1" || health.Arch != "gfx1030" || pins[0] != pin {
		t.Fatal(health, pin, pins)
	}
}

func TestCheckGPUReportsUnsupportedWithTheError(t *testing.T) {
	restore := runTorchProbe
	defer func() { runTorchProbe = restore }()
	runTorchProbe = func(cfg *Config, mode, pin string) (torchReport, error) {
		if mode == "test" {
			return torchReport{}, errors.New("GPU test crashed: exit status 1")
		}
		return torchReport{HIP: hip(), Devices: steveDevices[:1]}, nil
	}
	health, pin := checkGPU(&Config{ComfyPath: t.TempDir()}, func(string, ...any) {})
	if health.State != "unsupported" || pin != "" || !strings.Contains(health.Detail, "crashed") {
		t.Fatal(health, pin)
	}
}

func TestRepairBuildsFollowTheReportedArch(t *testing.T) {
	builds := repairBuilds("windows", torchReport{HIP: hip(), Devices: steveDevices}, "gfx1100")
	if len(builds) != 2 || builds[0].target != "gfx1030" || builds[1].target != "gfx1036" {
		t.Fatal(builds)
	}
	if got := repairBuilds("windows", torchReport{HIP: hip(), Devices: steveDevices}, "gfx1030"); len(got) != 1 || got[0].target != "gfx1036" {
		t.Fatal(got)
	}
	cuda := repairBuilds("linux", torchReport{Devices: []torchDevice{{Arch: "sm_120"}}}, "")
	if len(cuda) != 1 || !strings.Contains(strings.Join(cuda[0].args, " "), "cu128") {
		t.Fatal(cuda)
	}
}

func TestParseProbe(t *testing.T) {
	report, err := parseProbe("warning\nRIPPEL_GPU {\"torch\":\"2.13\",\"ok\":true,\"devices\":[]}\n", nil)
	if err != nil || !report.OK || report.Torch != "2.13" {
		t.Fatal(report, err)
	}
	if _, err := parseProbe("Segmentation fault", errors.New("exit status 139")); err == nil {
		t.Fatal("a crash read as a pass")
	}
}

func TestComfyGPUEnvAndArgs(t *testing.T) {
	env := comfyGPUEnv(&Config{GPUEnv: "HIP_VISIBLE_DEVICES=1"}, []string{"PATH=x", "HIP_VISIBLE_DEVICES=0"})
	if strings.Join(env, ";") != "PATH=x;HIP_VISIBLE_DEVICES=1" {
		t.Fatal(env)
	}
	if got := comfyGPUArgs(&Config{GPUFallback: "cpu"}, []string{"main.py"}); got[len(got)-1] != "--cpu" {
		t.Fatal(got)
	}
	if got := comfyGPUArgs(&Config{}, []string{"main.py"}); len(got) != 1 {
		t.Fatal(got)
	}
}
