package main

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Everything the agent knows how to do to a stable-diffusion.cpp install.
//
// This is the lighter of the two engines on purpose. sd-server is one static
// binary and a handful of shared libraries in one folder: no Python, no venv,
// no torch wheel to pick, nothing to `pip install -r`. Installing it is
// downloading a release archive and unzipping it; starting it is one process
// with its port and its model folders on the command line. Most of comfy.go has
// no counterpart here, and that absence is the feature.
//
// The two things worth stating:
//
//   - Which build. Upstream publishes one archive per accelerator, and a GPU
//     build on a machine without that runtime fails on the first graph rather
//     than at start. The choice is made from the same vendor probe ComfyUI
//     uses, but defaults to Vulkan rather than CUDA or ROCm outside the one
//     case (NVIDIA on Windows) where the CUDA archive is self-contained: Vulkan
//     needs nothing but a graphics driver, which every machine with a GPU has.
//   - Model folders. sd-server reads the same `models/` layout ComfyUI does, so
//     a machine that already has ComfyUI shares its weights rather than
//     downloading them twice. The agent passes both folders; downloads land in
//     whichever one the active engine owns (see modelRoot).

const sdcppReleaseAPI = "https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/latest"

// maxSdcppArchive bounds one release download. The CUDA runtime archive is the
// largest at ~540 MB; a gigabyte leaves room for upstream to grow.
const maxSdcppArchive int64 = 1 << 30

// SdcppState is the wire shape rippel's SdcppState type expects. The JSON tags
// are the contract; do not rename them without changing packages/shared.
type SdcppState struct {
	Installed bool              `json:"installed"`
	Running   bool              `json:"running"`
	Path      *string           `json:"path"`
	Version   *string           `json:"version"`
	Build     *string           `json:"build"`
	Port      int               `json:"port"`
	ModelDirs []string          `json:"modelDirs"`
	Model     *SdcppModelStatus `json:"model"`
	DiskFree  *int64            `json:"diskFree"`
	DiskTotal *int64            `json:"diskTotal"`
}

// SdcppModelStatus is /sdcpp/v1/models/status, trimmed to what the panel shows.
type SdcppModelStatus struct {
	State              string            `json:"state"`
	Recipe             *string           `json:"recipe"`
	Models             map[string]string `json:"models"`
	Error              *string           `json:"error"`
	LoadElapsedSeconds *float64          `json:"loadElapsedSeconds,omitempty"`
}

// sdcppInstall is written beside the binaries so the status can say which
// release and build this is without re-reading the archive name.
type sdcppInstall struct {
	Version string `json:"version"`
	Build   string `json:"build"`
	Asset   string `json:"asset"`
}

func sdcppBinary(cfg *Config) string {
	name := "sd-server"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(cfg.SdcppPath, name)
}

func sdcppPidFile(cfg *Config) string { return filepath.Join(cfg.Home, "sdcpp.pid") }

// SdcppLogFile is where sd-server's own output is redirected.
func SdcppLogFile(cfg *Config) string { return filepath.Join(cfg.Home, "sdcpp.log") }

func sdcppInstallFile(cfg *Config) string { return filepath.Join(cfg.SdcppPath, "rippel-install.json") }

// sdcppOwnModels is the folder sd.cpp owns outright, created on first start.
func sdcppOwnModels(cfg *Config) string { return filepath.Join(cfg.SdcppPath, "models") }

// sdcppModelDirs is every folder sd-server is told to scan, in the order the
// server will qualify them: the first keeps bare relative ids, the rest get a
// root prefix. ComfyUI's folder goes first when it exists, because that is
// where a machine's existing weights are and where rippel's model catalogue
// has been downloading to.
func sdcppModelDirs(cfg *Config) []string {
	dirs := []string{}
	if comfyModels := filepath.Join(cfg.ComfyPath, "models"); exists(comfyModels) {
		dirs = append(dirs, comfyModels)
	}
	own := sdcppOwnModels(cfg)
	if len(dirs) == 0 || own != dirs[0] {
		dirs = append(dirs, own)
	}
	return dirs
}

// ---------------------------------------------------------------- status

func readSdcppInstall(cfg *Config) *sdcppInstall {
	raw, err := os.ReadFile(sdcppInstallFile(cfg))
	if err != nil {
		return nil
	}
	var info sdcppInstall
	if json.Unmarshal(raw, &info) != nil {
		return nil
	}
	return &info
}

// askSdcpp is a short-timeout GET against the managed sd-server. Any failure
// is "not answering", which is the only distinction the status needs.
func askSdcpp(cfg *Config, path string) []byte {
	ctx, cancel := context.WithTimeout(context.Background(), 2500*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		fmt.Sprintf("http://127.0.0.1:%d%s", cfg.SdcppPort, path), nil)
	if err != nil {
		return nil
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return nil
	}
	return raw
}

// parseSdcppModelStatus reads the server's status body, which spells its one
// multi-word key in snake_case while the rest of the agent's wire is camelCase.
func parseSdcppModelStatus(raw []byte) *SdcppModelStatus {
	if len(raw) == 0 {
		return nil
	}
	var body struct {
		State              string            `json:"state"`
		Recipe             *string           `json:"recipe"`
		Models             map[string]string `json:"models"`
		Error              *string           `json:"error"`
		LoadElapsedSeconds *float64          `json:"load_elapsed_seconds"`
	}
	if json.Unmarshal(raw, &body) != nil || body.State == "" {
		return nil
	}
	if body.Models == nil {
		body.Models = map[string]string{}
	}
	return &SdcppModelStatus{
		State: body.State, Recipe: body.Recipe, Models: body.Models,
		Error: body.Error, LoadElapsedSeconds: body.LoadElapsedSeconds,
	}
}

// SdcppStatus is the whole picture of the managed sd.cpp, as one object.
//
// As with ComfyUI, "Running" is answered by asking the port rather than by the
// pid file, which outlives a crash.
func SdcppStatus(cfg *Config) SdcppState {
	installed := exists(sdcppBinary(cfg))
	model := parseSdcppModelStatus(askSdcpp(cfg, "/sdcpp/v1/models/status"))

	spaceAt := cfg.Home
	if installed {
		spaceAt = cfg.SdcppPath
	}
	free, total := diskSpace(spaceAt)

	state := SdcppState{
		Installed: installed,
		Running:   model != nil,
		Port:      cfg.SdcppPort,
		ModelDirs: sdcppModelDirs(cfg),
		Model:     model,
		DiskFree:  free,
		DiskTotal: total,
	}
	if installed {
		path := cfg.SdcppPath
		state.Path = &path
		if info := readSdcppInstall(cfg); info != nil {
			if info.Version != "" {
				version := info.Version
				state.Version = &version
			}
			if info.Build != "" {
				build := info.Build
				state.Build = &build
			}
		}
	}
	return state
}

// ---------------------------------------------------------------- install

// DetectSdcppBuild picks the upstream build for this machine.
//
// `accelerator` is what DetectAccelerator answered (cuda, rocm, cpu). Vulkan
// is the default for any GPU because it needs only a graphics driver; CUDA is
// chosen on Windows with NVIDIA because that archive ships its runtime beside
// it (the cudart companion), while the Linux release has no CUDA build at all.
func DetectSdcppBuild(goos, accelerator string) string {
	switch accelerator {
	case "cuda":
		if goos == "windows" {
			return "cuda"
		}
		return "vulkan"
	case "rocm":
		return "vulkan"
	}
	return "cpu"
}

// sdcppAssetPatterns is which release archives to fetch for one target, as
// regular expressions on the asset name. The first must match exactly one
// asset; the rest are companions unpacked into the same folder.
func sdcppAssetPatterns(goos, goarch, build string) ([]*regexp.Regexp, error) {
	switch goos {
	case "linux":
		if goarch != "amd64" {
			return nil, fmt.Errorf("No stable-diffusion.cpp release exists for Linux on %s.", goarch)
		}
		switch build {
		case "cpu":
			return []*regexp.Regexp{regexp.MustCompile(`^sd-.*-bin-Linux-.*-x86_64\.zip$`)}, nil
		case "vulkan":
			return []*regexp.Regexp{regexp.MustCompile(`^sd-.*-bin-Linux-.*-x86_64-vulkan\.zip$`)}, nil
		case "rocm":
			return []*regexp.Regexp{regexp.MustCompile(`^sd-.*-bin-Linux-.*-x86_64-rocm-[\d.]+\.zip$`)}, nil
		case "cuda":
			return nil, errors.New("Upstream publishes no CUDA build for Linux. Choose vulkan, which runs on NVIDIA cards through the graphics driver.")
		}
	case "windows":
		if goarch != "amd64" {
			return nil, fmt.Errorf("No stable-diffusion.cpp release exists for Windows on %s.", goarch)
		}
		switch build {
		case "cpu":
			return []*regexp.Regexp{regexp.MustCompile(`^sd-.*-bin-win-cpu-x64\.zip$`)}, nil
		case "vulkan":
			return []*regexp.Regexp{regexp.MustCompile(`^sd-.*-bin-win-vulkan-x64\.zip$`)}, nil
		case "rocm":
			return []*regexp.Regexp{regexp.MustCompile(`^sd-.*-bin-win-rocm-[\d.]+-x64\.zip$`)}, nil
		case "cuda":
			return []*regexp.Regexp{
				regexp.MustCompile(`^sd-.*-bin-win-cuda12-x64\.zip$`),
				regexp.MustCompile(`^cudart-sd-bin-win-cu12-x64\.zip$`),
			}, nil
		}
	case "darwin":
		if goarch != "arm64" {
			return nil, errors.New("Upstream publishes stable-diffusion.cpp for Apple silicon only.")
		}
		if build != "cpu" {
			// The one macOS archive uses Metal through ggml; there is nothing
			// else to choose, so every build name resolves to it.
			build = "cpu"
		}
		return []*regexp.Regexp{regexp.MustCompile(`^sd-.*-bin-Darwin-macOS-.*-arm64\.zip$`)}, nil
	}
	return nil, fmt.Errorf("No stable-diffusion.cpp build called %q for %s.", build, goos)
}

type releaseAsset struct {
	Name   string `json:"name"`
	URL    string `json:"browser_download_url"`
	Size   int64  `json:"size"`
	Digest string `json:"digest"`
}

type release struct {
	Tag    string         `json:"tag_name"`
	Assets []releaseAsset `json:"assets"`
}

func fetchLatestRelease(client *http.Client) (*release, error) {
	req, err := http.NewRequest(http.MethodGet, sdcppReleaseAPI, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "rippel-agent/"+AgentVersion)
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("could not reach GitHub for the stable-diffusion.cpp release list: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub answered %d for the stable-diffusion.cpp release list", res.StatusCode)
	}
	var rel release
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&rel); err != nil {
		return nil, fmt.Errorf("could not read the release list: %w", err)
	}
	if rel.Tag == "" || len(rel.Assets) == 0 {
		return nil, errors.New("the latest stable-diffusion.cpp release has no downloadable files")
	}
	return &rel, nil
}

// pickAssets resolves each pattern to exactly one asset. Two matches is a
// release layout we do not understand, and guessing would install the wrong
// build with no error until the first image.
func pickAssets(rel *release, patterns []*regexp.Regexp) ([]releaseAsset, error) {
	picked := []releaseAsset{}
	for _, pattern := range patterns {
		var matches []releaseAsset
		for _, asset := range rel.Assets {
			if pattern.MatchString(asset.Name) {
				matches = append(matches, asset)
			}
		}
		if len(matches) != 1 {
			return nil, fmt.Errorf("release %s has %d files matching %s; expected one", rel.Tag, len(matches), pattern)
		}
		picked = append(picked, matches[0])
	}
	return picked, nil
}

// downloadAsset fetches one archive to a temp file, checking its SHA-256 when
// the release says what it should be. GitHub has published digests since 2025;
// a release without one is accepted with a note rather than refused, because
// the alternative is an install path that stops working the day the field is
// renamed.
func downloadAsset(client *http.Client, task *Task, asset releaseAsset, dir string) (string, error) {
	if asset.Size > maxSdcppArchive {
		return "", fmt.Errorf("%s is %d bytes, more than this agent will download", asset.Name, asset.Size)
	}
	req, err := http.NewRequest(http.MethodGet, asset.URL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "rippel-agent/"+AgentVersion)
	res, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("could not download %s: %w", asset.Name, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("downloading %s answered %d", asset.Name, res.StatusCode)
	}

	file, err := os.CreateTemp(dir, ".sdcpp-*.zip")
	if err != nil {
		return "", err
	}
	path := file.Name()
	ok := false
	defer func() {
		file.Close()
		if !ok {
			os.Remove(path)
		}
	}()

	hash := sha256.New()
	total := res.ContentLength
	if total <= 0 {
		total = asset.Size
	}
	var sink io.Writer = io.MultiWriter(file, hash)
	sink = &progressWriter{inner: sink, total: total, report: task.setBytes}
	count, err := io.Copy(sink, io.LimitReader(res.Body, maxSdcppArchive+1))
	if err != nil {
		return "", fmt.Errorf("download of %s interrupted: %w", asset.Name, err)
	}
	if count == 0 || count > maxSdcppArchive {
		return "", fmt.Errorf("%s has an unusable size", asset.Name)
	}
	if err := file.Close(); err != nil {
		return "", err
	}

	got := hex.EncodeToString(hash.Sum(nil))
	if want, found := strings.CutPrefix(strings.ToLower(asset.Digest), "sha256:"); found {
		if got != want {
			return "", fmt.Errorf("%s did not match the SHA-256 GitHub published for it", asset.Name)
		}
		task.Appendf("%s: %d bytes, SHA-256 verified", asset.Name, count)
	} else {
		task.Appendf("%s: %d bytes (the release published no digest to check it against)", asset.Name, count)
	}
	ok = true
	return path, nil
}

// unzipInto extracts one archive flat into dest.
//
// Every entry is checked before anything is written: the names come from a
// download, and a name with `..` or a leading separator in it must not reach
// the filesystem as a path. Release archives have no top-level folder, so the
// files land beside each other exactly as upstream laid them out.
func unzipInto(task *Task, archive, dest string) (int, error) {
	reader, err := zip.OpenReader(archive)
	if err != nil {
		return 0, fmt.Errorf("could not open the archive: %w", err)
	}
	defer reader.Close()

	written := 0
	for _, entry := range reader.File {
		name := filepath.ToSlash(entry.Name)
		if name == "" || strings.HasPrefix(name, "/") || strings.Contains(name, "..") || strings.ContainsAny(name, ":\x00") {
			return written, fmt.Errorf("refusing to extract %q", entry.Name)
		}
		target := filepath.Join(dest, filepath.FromSlash(name))
		if entry.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return written, err
			}
			continue
		}
		if entry.Mode()&os.ModeSymlink != 0 {
			// Nothing in a release needs one, and a link is the one entry
			// type that can point outside dest after the name check passes.
			task.Appendf("skipping symlink %s", name)
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return written, err
		}
		if err := copyZipEntry(entry, target); err != nil {
			return written, err
		}
		written++
	}
	return written, nil
}

func copyZipEntry(entry *zip.File, target string) error {
	in, err := entry.Open()
	if err != nil {
		return err
	}
	defer in.Close()
	mode := entry.Mode().Perm()
	if mode == 0 {
		mode = 0o644
	}
	// Executables in the archive carry their bit on Linux and macOS; Windows
	// does not care. Files that are being replaced are truncated, not renamed
	// around, because sd-server is stopped before an install begins.
	out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return os.Chmod(target, mode)
}

// InstallSdcpp downloads the latest upstream release for this machine and
// unpacks it. Idempotent: a re-run replaces the program files and leaves the
// models folder alone, so it doubles as "update".
func InstallSdcpp(cfg *Config, task *Task, build string, client *http.Client) (string, error) {
	if build == "" || build == "auto" {
		build = DetectSdcppBuild(runtime.GOOS, DetectAccelerator())
	}
	patterns, err := sdcppAssetPatterns(runtime.GOOS, runtime.GOARCH, build)
	if err != nil {
		return "", err
	}
	if SdcppStatus(cfg).Running {
		return "", errors.New("stable-diffusion.cpp is running on this machine. Stop it before installing or updating it.")
	}
	task.Appendf("installing stable-diffusion.cpp (%s build) into %s", build, cfg.SdcppPath)

	if client == nil {
		client = &http.Client{Timeout: 2 * time.Hour}
	}
	rel, err := fetchLatestRelease(client)
	if err != nil {
		return "", err
	}
	assets, err := pickAssets(rel, patterns)
	if err != nil {
		return "", err
	}
	task.Appendf("release %s", rel.Tag)

	if err := os.MkdirAll(cfg.SdcppPath, 0o755); err != nil {
		return "", err
	}
	for _, asset := range assets {
		task.Appendf("downloading %s", asset.Name)
		archive, err := downloadAsset(client, task, asset, cfg.SdcppPath)
		if err != nil {
			return "", err
		}
		count, err := unzipInto(task, archive, cfg.SdcppPath)
		_ = os.Remove(archive)
		if err != nil {
			return "", err
		}
		task.Appendf("unpacked %d files", count)
	}
	if !exists(sdcppBinary(cfg)) {
		return "", fmt.Errorf("the archive did not contain %s", filepath.Base(sdcppBinary(cfg)))
	}
	if err := os.MkdirAll(sdcppOwnModels(cfg), 0o755); err != nil {
		return "", err
	}

	info, _ := json.MarshalIndent(sdcppInstall{Version: strings.TrimPrefix(rel.Tag, "v"), Build: build, Asset: assets[0].Name}, "", "  ")
	if err := os.WriteFile(sdcppInstallFile(cfg), append(info, '\n'), 0o644); err != nil {
		return "", err
	}
	task.Append("stable-diffusion.cpp installed.")
	return build, nil
}

// ---------------------------------------------------------------- run control

// sdcppArgs is the command line sd-server is started with.
//
// --listen-ip 0.0.0.0 for the same reason ComfyUI gets --listen: rippel may be
// on another machine and reach this one directly rather than through the
// tunnel. sd-server has no authentication, so it belongs on a LAN.
func sdcppArgs(cfg *Config) []string {
	args := []string{"--listen-ip", "0.0.0.0", "--listen-port", strconv.Itoa(cfg.SdcppPort)}
	for _, dir := range sdcppModelDirs(cfg) {
		args = append(args, "--model-dir", dir)
	}
	if extra := strings.Fields(cfg.SdcppArgs); len(extra) > 0 {
		args = append(args, extra...)
	}
	return args
}

// StartSdcpp spawns sd-server detached.
func StartSdcpp(cfg *Config) (PowerResult, error) {
	if !exists(sdcppBinary(cfg)) {
		return PowerResult{}, fmt.Errorf("No stable-diffusion.cpp at %s. Install it first.", cfg.SdcppPath)
	}
	if SdcppStatus(cfg).Running {
		return PowerResult{Started: no(), Reason: "already running"}, nil
	}
	if err := os.MkdirAll(cfg.Home, 0o700); err != nil {
		return PowerResult{}, err
	}
	if err := os.MkdirAll(sdcppOwnModels(cfg), 0o755); err != nil {
		return PowerResult{}, err
	}
	logFile, err := os.OpenFile(SdcppLogFile(cfg), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return PowerResult{}, fmt.Errorf("could not open %s: %w", SdcppLogFile(cfg), err)
	}
	defer logFile.Close()

	cmd := exec.Command(sdcppBinary(cfg), sdcppArgs(cfg)...)
	cmd.Dir = cfg.SdcppPath
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.Env = os.Environ()
	detach(cmd)

	if err := cmd.Start(); err != nil {
		return PowerResult{}, fmt.Errorf("could not start sd-server: %w", err)
	}
	pid := cmd.Process.Pid
	_ = cmd.Process.Release()
	if err := os.WriteFile(sdcppPidFile(cfg), []byte(strconv.Itoa(pid)), 0o600); err != nil {
		return PowerResult{}, err
	}
	return PowerResult{Started: yes(), PID: pid}, nil
}

// StopSdcpp stops it, politely first, with the same refusal as StopComfy for a
// server this agent did not start.
func StopSdcpp(cfg *Config, grace time.Duration) (PowerResult, error) {
	pid := readPidFrom(sdcppPidFile(cfg))
	if pid == 0 || !processAlive(pid) {
		_ = os.Remove(sdcppPidFile(cfg))
		if SdcppStatus(cfg).Running {
			return PowerResult{}, errors.New(
				"sd-server is answering on its port but was not started by this agent, " +
					"so the agent will not stop it. Stop it where it was started.")
		}
		return PowerResult{Stopped: no(), Reason: "not running"}, nil
	}
	terminateProcess(pid)
	deadline := time.Now().Add(grace)
	for processAlive(pid) && time.Now().Before(deadline) {
		time.Sleep(250 * time.Millisecond)
	}
	if processAlive(pid) {
		killProcess(pid)
	}
	_ = os.Remove(sdcppPidFile(cfg))
	return PowerResult{Stopped: yes(), PID: pid}, nil
}

func readPidFrom(path string) int {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil || pid <= 0 {
		return 0
	}
	return pid
}

// TailSdcppLog returns the last n lines of sd-server's output. Progress bars
// are drawn with carriage returns on one line, so those are split too.
func TailSdcppLog(cfg *Config, n int) []string {
	raw, err := os.ReadFile(SdcppLogFile(cfg))
	if err != nil {
		return []string{}
	}
	text := strings.ReplaceAll(string(raw), "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	lines := []string{}
	for _, line := range strings.Split(text, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		lines = append(lines, line)
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines
}

// ---------------------------------------------------------------- engine choice

// validEngine is the two names rippel's Engine type knows.
func validEngine(name string) bool { return name == "comfyui" || name == "sdcpp" }

// enginePort is the port the tunnel's "engine" target dials: whichever engine
// is active. This is what lets the backend row keep one URL across a switch.
func enginePort(cfg *Config) int {
	if cfg.Engine == "sdcpp" {
		return cfg.SdcppPort
	}
	return cfg.ComfyPort
}

// setEngine records which engine this machine runs. It does not start or stop
// anything: the panel does that explicitly, and an engine switch while a job
// is running is the operator's call to make visibly.
func (a *Agent) setEngine(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Engine string `json:"engine"`
	}
	if err := readBody(r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if !validEngine(body.Engine) {
		writeError(w, http.StatusBadRequest, "bad_request", "engine must be comfyui or sdcpp")
		return
	}
	a.mu.Lock()
	a.cfg.Engine = body.Engine
	a.mu.Unlock()
	if err := SaveConfig(map[string]any{"engine": body.Engine}); err != nil {
		writeError(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	a.changed()
	writeJSON(w, http.StatusOK, map[string]any{"engine": body.Engine})
}

// sdcppPower is start/stop/restart for sd-server, the sd.cpp half of power().
func (a *Agent) sdcppPower(w http.ResponseWriter, action string) {
	a.taskStartMu.Lock()
	defer a.taskStartMu.Unlock()
	if a.tasks.IsRunning("install-sdcpp") {
		writeError(w, http.StatusConflict, "busy", "stable-diffusion.cpp is being installed.")
		return
	}
	cfg := a.config()
	var result PowerResult
	var err error
	switch action {
	case "start":
		result, err = StartSdcpp(cfg)
	case "stop":
		result, err = StopSdcpp(cfg, 10*time.Second)
	case "restart":
		_, _ = StopSdcpp(cfg, 10*time.Second)
		result, err = StartSdcpp(cfg)
	}
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	a.changed()
	writeJSON(w, http.StatusOK, result)
}
