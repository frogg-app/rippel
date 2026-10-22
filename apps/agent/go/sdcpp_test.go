package main

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// The release list as GitHub published it on 2026-10-21, names only.
var releaseNames = []string{
	"cudart-sd-bin-win-cu12-x64.zip",
	"sd-master-a77d362-bin-Darwin-macOS-26.6.2-arm64.zip",
	"sd-master-a77d362-bin-Linux-Ubuntu-24.04-x86_64-rocm-10.1.0.zip",
	"sd-master-a77d362-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip",
	"sd-master-a77d362-bin-Linux-Ubuntu-24.04-x86_64.zip",
	"sd-master-a77d362-bin-win-cpu-x64.zip",
	"sd-master-a77d362-bin-win-cuda12-x64.zip",
	"sd-master-a77d362-bin-win-rocm-10.1.0-x64.zip",
	"sd-master-a77d362-bin-win-vulkan-x64.zip",
}

func fakeRelease() *release {
	rel := &release{Tag: "master-987-a77d362"}
	for _, name := range releaseNames {
		rel.Assets = append(rel.Assets, releaseAsset{Name: name, URL: "https://example.invalid/" + name})
	}
	return rel
}

func TestAssetSelectionAgainstRealReleaseNames(t *testing.T) {
	cases := []struct {
		goos, goarch, build string
		want                []string
	}{
		{"linux", "amd64", "cpu", []string{"sd-master-a77d362-bin-Linux-Ubuntu-24.04-x86_64.zip"}},
		{"linux", "amd64", "vulkan", []string{"sd-master-a77d362-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip"}},
		{"linux", "amd64", "rocm", []string{"sd-master-a77d362-bin-Linux-Ubuntu-24.04-x86_64-rocm-10.1.0.zip"}},
		{"windows", "amd64", "cpu", []string{"sd-master-a77d362-bin-win-cpu-x64.zip"}},
		{"windows", "amd64", "vulkan", []string{"sd-master-a77d362-bin-win-vulkan-x64.zip"}},
		{"windows", "amd64", "rocm", []string{"sd-master-a77d362-bin-win-rocm-10.1.0-x64.zip"}},
		{"windows", "amd64", "cuda", []string{"sd-master-a77d362-bin-win-cuda12-x64.zip", "cudart-sd-bin-win-cu12-x64.zip"}},
		{"darwin", "arm64", "cpu", []string{"sd-master-a77d362-bin-Darwin-macOS-26.6.2-arm64.zip"}},
		{"darwin", "arm64", "vulkan", []string{"sd-master-a77d362-bin-Darwin-macOS-26.6.2-arm64.zip"}},
	}
	for _, c := range cases {
		patterns, err := sdcppAssetPatterns(c.goos, c.goarch, c.build)
		if err != nil {
			t.Fatalf("%s/%s %s: %v", c.goos, c.goarch, c.build, err)
		}
		assets, err := pickAssets(fakeRelease(), patterns)
		if err != nil {
			t.Fatalf("%s/%s %s: %v", c.goos, c.goarch, c.build, err)
		}
		if len(assets) != len(c.want) {
			t.Fatalf("%s/%s %s: got %d assets, want %d", c.goos, c.goarch, c.build, len(assets), len(c.want))
		}
		for i := range c.want {
			if assets[i].Name != c.want[i] {
				t.Errorf("%s/%s %s: asset %d = %s, want %s", c.goos, c.goarch, c.build, i, assets[i].Name, c.want[i])
			}
		}
	}
}

func TestAssetSelectionRefusesWhatUpstreamDoesNotShip(t *testing.T) {
	if _, err := sdcppAssetPatterns("linux", "amd64", "cuda"); err == nil {
		t.Error("Linux has no CUDA build and should say so")
	}
	if _, err := sdcppAssetPatterns("linux", "arm64", "cpu"); err == nil {
		t.Error("no Linux arm64 release exists")
	}
	if _, err := sdcppAssetPatterns("darwin", "amd64", "cpu"); err == nil {
		t.Error("no Intel Mac release exists")
	}
}

func TestPickAssetsRefusesAmbiguity(t *testing.T) {
	rel := fakeRelease()
	_, err := pickAssets(rel, []*regexp.Regexp{regexp.MustCompile(`win`)})
	if err == nil {
		t.Fatal("a pattern matching several assets must be refused rather than guessed")
	}
}

func TestDetectSdcppBuild(t *testing.T) {
	cases := map[[2]string]string{
		{"windows", "cuda"}: "cuda",
		{"linux", "cuda"}:   "vulkan",
		{"windows", "rocm"}: "vulkan",
		{"linux", "rocm"}:   "vulkan",
		{"linux", "cpu"}:    "cpu",
		{"darwin", "cpu"}:   "cpu",
	}
	for in, want := range cases {
		if got := DetectSdcppBuild(in[0], in[1]); got != want {
			t.Errorf("DetectSdcppBuild(%s, %s) = %s, want %s", in[0], in[1], got, want)
		}
	}
}

func makeZip(t *testing.T, entries map[string]string) string {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for name, body := range entries {
		f, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = f.Write([]byte(body))
	}
	_ = w.Close()
	path := filepath.Join(t.TempDir(), "a.zip")
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestUnzipIntoExtractsFlatAndRefusesEscapes(t *testing.T) {
	task := NewTasks().Create("install-sdcpp")
	dest := t.TempDir()

	good := makeZip(t, map[string]string{"sd-server": "bin", "libggml.so": "lib", "docs/readme.txt": "hi"})
	count, err := unzipInto(task, good, dest)
	if err != nil || count != 3 {
		t.Fatalf("unzip: count=%d err=%v", count, err)
	}
	if !exists(filepath.Join(dest, "sd-server")) || !exists(filepath.Join(dest, "docs", "readme.txt")) {
		t.Error("files were not extracted where the archive put them")
	}

	for _, bad := range []string{"../escape", "/abs", "a/../../b"} {
		archive := makeZip(t, map[string]string{bad: "x"})
		if _, err := unzipInto(task, archive, t.TempDir()); err == nil {
			t.Errorf("entry %q must be refused", bad)
		}
	}
}

func TestParseSdcppModelStatus(t *testing.T) {
	status := parseSdcppModelStatus([]byte(`{"error":null,"load_elapsed_seconds":4.3,"models":{"model":"checkpoints/sd_turbo.gguf"},"recipe":"sd-turbo","revision":2,"state":"ready"}`))
	if status == nil || status.State != "ready" || status.Recipe == nil || *status.Recipe != "sd-turbo" {
		t.Fatalf("bad parse: %+v", status)
	}
	if status.Models["model"] != "checkpoints/sd_turbo.gguf" || status.LoadElapsedSeconds == nil || *status.LoadElapsedSeconds != 4.3 {
		t.Errorf("fields lost: %+v", status)
	}
	if parseSdcppModelStatus(nil) != nil || parseSdcppModelStatus([]byte(`{}`)) != nil || parseSdcppModelStatus([]byte(`nope`)) != nil {
		t.Error("an absent or malformed status must read as not running")
	}
	empty := parseSdcppModelStatus([]byte(`{"state":"empty","recipe":null,"models":{},"error":null}`))
	if empty == nil || empty.State != "empty" || empty.Models == nil {
		t.Errorf("empty server must still count as running: %+v", empty)
	}
}

func TestEnginePortFollowsTheActiveEngine(t *testing.T) {
	cfg := &Config{Engine: "comfyui", ComfyPort: 8188, SdcppPort: 8190}
	if enginePort(cfg) != 8188 {
		t.Error("ComfyUI active should dial its port")
	}
	cfg.Engine = "sdcpp"
	if enginePort(cfg) != 8190 {
		t.Error("sd.cpp active should dial its port")
	}
}

func TestSdcppModelDirsSharesComfyModels(t *testing.T) {
	home := t.TempDir()
	cfg := &Config{ComfyPath: filepath.Join(home, "ComfyUI"), SdcppPath: filepath.Join(home, "sdcpp")}
	dirs := sdcppModelDirs(cfg)
	if len(dirs) != 1 || dirs[0] != filepath.Join(home, "sdcpp", "models") {
		t.Fatalf("without ComfyUI only sd.cpp's own folder: %v", dirs)
	}
	_ = os.MkdirAll(filepath.Join(cfg.ComfyPath, "models"), 0o755)
	dirs = sdcppModelDirs(cfg)
	if len(dirs) != 2 || dirs[0] != filepath.Join(cfg.ComfyPath, "models") {
		t.Fatalf("ComfyUI's models must come first so its ids stay bare: %v", dirs)
	}
}
