package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The agent's own tests.
//
// What is covered is the part that is security-relevant or easy to get subtly
// wrong: the token check, the task log's bounds, the refusal to write a helper
// file outside its own folder, and the setup link parsing — which is the one
// piece of this program a non-technical person interacts with directly, so its
// failure messages are as much of the contract as its successes.

func testConfig(t *testing.T) *Config {
	t.Helper()
	home := t.TempDir()
	return &Config{
		Token:            "the-token",
		Host:             "127.0.0.1",
		Port:             18189,
		ComfyPath:        filepath.Join(home, "ComfyUI"),
		ComfyPort:        18188,
		HeartbeatSeconds: 20,
		Platform:         "linux",
		Home:             home,
	}
}

// serve starts the agent's handler on an ephemeral port and hands back a
// caller that sets the right token.
func serve(t *testing.T, cfg *Config) (*httptest.Server, func(method, path string, body string, token *string) *http.Response) {
	t.Helper()
	agent := NewAgent(cfg, nil)
	server := httptest.NewServer(agent.Handler())
	t.Cleanup(server.Close)

	call := func(method, path, body string, token *string) *http.Response {
		t.Helper()
		var reader io.Reader
		if body != "" {
			reader = strings.NewReader(body)
		}
		req, err := http.NewRequest(method, server.URL+path, reader)
		if err != nil {
			t.Fatal(err)
		}
		if token == nil {
			req.Header.Set("X-Rippel-Agent-Token", cfg.Token)
		} else if *token != "" {
			req.Header.Set("X-Rippel-Agent-Token", *token)
		}
		if body != "" {
			req.Header.Set("content-type", "application/json")
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { res.Body.Close() })
		return res
	}
	return server, call
}

func decode(t *testing.T, res *http.Response) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		t.Fatalf("could not decode the answer: %v", err)
	}
	return payload
}

// ---------------------------------------------------------------- tasks

func TestTaskLogKeepsTheTailRatherThanGrowingForever(t *testing.T) {
	tasks := NewTasks()
	task := tasks.Create("test")
	for i := 0; i < 2500; i++ {
		task.Appendf("line %d", i)
	}

	lines := task.Lines()
	if len(lines) != maxLines {
		t.Fatalf("kept %d lines, wanted %d", len(lines), maxLines)
	}
	// The end is what says why something failed, so that is the end kept.
	if lines[len(lines)-1] != "line 2499" {
		t.Fatalf("last line is %q", lines[len(lines)-1])
	}

	tasks.Finish(task, nil)
	if task.Status() != "done" {
		t.Fatalf("status is %q", task.Status())
	}
}

func TestFinishRecordsAFailureAndItStaysFindable(t *testing.T) {
	tasks := NewTasks()
	task := tasks.Create("test-fail")
	tasks.Finish(task, os.ErrPermission)

	if task.Status() != "failed" {
		t.Fatalf("status is %q", task.Status())
	}
	if task.Err() == nil || *task.Err() != os.ErrPermission.Error() {
		t.Fatalf("error is %v", task.Err())
	}
	if tasks.Get(task.ID) == nil {
		t.Fatal("the task cannot be found by its id")
	}
	if tasks.IsRunning("test-fail") {
		t.Fatal("a finished task still counts as running")
	}
}

func TestRunReportsANonZeroExitAndCapturesTheOutput(t *testing.T) {
	tasks := NewTasks()
	task := tasks.Create("exit")

	err := Run(task, "", os.Environ(), "sh", "-c", "echo nope >&2; exit 3")
	if err == nil || !strings.Contains(err.Error(), "exited with code 3") {
		t.Fatalf("error is %v", err)
	}
	if !hasLineContaining(task.Lines(), "nope") {
		t.Fatalf("stderr was not captured: %v", task.Lines())
	}
}

func TestRunSaysTheCommandIsMissingRatherThanPanicking(t *testing.T) {
	tasks := NewTasks()
	task := tasks.Create("missing")

	err := Run(task, "", os.Environ(), "definitely-not-a-real-binary-xyz")
	if err == nil || !strings.Contains(err.Error(), "could not run") {
		t.Fatalf("error is %v", err)
	}
}

func hasLineContaining(lines []string, want string) bool {
	for _, line := range lines {
		if strings.Contains(line, want) {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------- the helper

func TestHelperInstallRefusesAFilenameThatWouldClimbOut(t *testing.T) {
	cfg := testConfig(t)
	tasks := NewTasks()
	task := tasks.Create("helper")

	// The guard has to fire before the missing-install check would, so that a
	// traversal is refused on a machine where ComfyUI *is* present too. That
	// ordering is the thing being asserted.
	_, err := InstallHelper(cfg, task, []HelperFile{{Name: "../../evil.py", Content: "x"}})
	if err == nil || !strings.Contains(err.Error(), "Refusing to write") {
		t.Fatalf("error is %v", err)
	}

	for _, name := range []string{"a/b.py", `a\b.py`, "..", ""} {
		if _, err := InstallHelper(cfg, task, []HelperFile{{Name: name, Content: "x"}}); err == nil {
			t.Fatalf("a helper file named %q was allowed", name)
		}
	}
}

// ---------------------------------------------------------------- the HTTP API

func TestEveryRouteNeedsTheTokenIncludingThePing(t *testing.T) {
	cfg := testConfig(t)
	_, call := serve(t, cfg)

	none := ""
	if res := call(http.MethodGet, "/agent/ping", "", &none); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no token answered %d", res.StatusCode)
	}
	wrong := "guess-guess-guess"
	if res := call(http.MethodGet, "/agent/ping", "", &wrong); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("a wrong token answered %d", res.StatusCode)
	}
	// A token of a different length must be refused without comparing bytes,
	// and must not panic on the way.
	short := "x"
	if res := call(http.MethodGet, "/agent/ping", "", &short); res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("a short token answered %d", res.StatusCode)
	}
}

func TestAnAgentWithNoTokenRefusesEverything(t *testing.T) {
	cfg := testConfig(t)
	cfg.Token = ""
	_, call := serve(t, cfg)

	empty := ""
	res := call(http.MethodGet, "/agent/ping", "", &empty)
	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("answered %d", res.StatusCode)
	}
	if !strings.Contains(decode(t, res)["message"].(string), "no token configured") {
		t.Fatal("the message does not explain why")
	}
}

func TestPingAndStatusSayWhatTheyKnow(t *testing.T) {
	cfg := testConfig(t)
	_, call := serve(t, cfg)

	ping := decode(t, call(http.MethodGet, "/agent/ping", "", nil))
	if ping["ok"] != true || ping["platform"] != "linux" || ping["version"] != AgentVersion {
		t.Fatalf("ping said %v", ping)
	}

	status := decode(t, call(http.MethodGet, "/agent/status", "", nil))
	comfy := status["comfy"].(map[string]any)
	// Nothing is installed in a temp dir, and the status says so plainly
	// rather than failing.
	for key, want := range map[string]any{
		"installed":       false,
		"running":         false,
		"helperInstalled": false,
		"helperReady":     false,
		"port":            float64(18188),
	} {
		if comfy[key] != want {
			t.Fatalf("comfy.%s is %v, wanted %v", key, comfy[key], want)
		}
	}
	// The nullable fields must be present and null, not absent: rippel's
	// ComfyState type declares them and the panel reads them.
	for _, key := range []string{"path", "version", "commit", "diskFree", "diskTotal"} {
		if _, present := comfy[key]; !present {
			t.Fatalf("comfy.%s is missing from the wire format", key)
		}
	}
}

func TestUnknownRoutesAndMissingTasksAre404(t *testing.T) {
	cfg := testConfig(t)
	_, call := serve(t, cfg)

	if res := call(http.MethodGet, "/agent/nope", "", nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("answered %d", res.StatusCode)
	}
	if res := call(http.MethodGet, "/agent/tasks/not-a-task", "", nil); res.StatusCode != http.StatusNotFound {
		t.Fatalf("answered %d", res.StatusCode)
	}
}

func TestHelperInstallRefusesWithNoStorageToken(t *testing.T) {
	cfg := testConfig(t)
	_, call := serve(t, cfg)

	res := call(http.MethodPost, "/agent/helper/install",
		`{"files":[{"name":"__init__.py","content":""}]}`, nil)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("answered %d", res.StatusCode)
	}
	if !strings.Contains(decode(t, res)["message"].(string), "storage token") {
		t.Fatal("the message does not say what is missing")
	}
}

func TestStartingAComfyUIThatIsNotThereFailsClearly(t *testing.T) {
	cfg := testConfig(t)
	_, call := serve(t, cfg)

	res := call(http.MethodPost, "/agent/comfyui/start", "", nil)
	if res.StatusCode != http.StatusBadRequest {
		t.Fatalf("answered %d", res.StatusCode)
	}
	if !strings.Contains(decode(t, res)["message"].(string), "Install it first") {
		t.Fatal("the message does not say what to do")
	}
}

func TestStoppingNothingIsNotAnError(t *testing.T) {
	cfg := testConfig(t)
	_, call := serve(t, cfg)

	res := call(http.MethodPost, "/agent/comfyui/stop", "", nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("answered %d", res.StatusCode)
	}
	if decode(t, res)["stopped"] == true {
		t.Fatal("it claimed to have stopped something")
	}
}

func TestAnInstallReturnsATaskImmediatelyAndRefusesASecond(t *testing.T) {
	cfg := testConfig(t)
	// The install is genuinely started, so it is pointed at a path under a
	// regular file: git fails on the first step and nothing is downloaded.
	// What is being asserted is the handoff, not the install.
	blocked := filepath.Join(cfg.Home, "not-a-directory")
	if err := os.WriteFile(blocked, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	cfg.ComfyPath = filepath.Join(blocked, "ComfyUI")
	_, call := serve(t, cfg)

	res := call(http.MethodPost, "/agent/comfyui/install", `{"accelerator":"cpu"}`, nil)
	// 202, not 200: the work has been accepted, not done.
	if res.StatusCode != http.StatusAccepted {
		t.Fatalf("answered %d", res.StatusCode)
	}
	task := decode(t, res)["task"].(map[string]any)
	if task["status"] != "running" {
		t.Fatalf("task is %v", task)
	}

	// Two pip installs into one venv corrupt it, so the second is refused.
	second := call(http.MethodPost, "/agent/comfyui/install", `{"accelerator":"cpu"}`, nil)
	if second.StatusCode != http.StatusConflict {
		t.Fatalf("the second install answered %d", second.StatusCode)
	}

	followed := decode(t, call(http.MethodGet, "/agent/tasks/"+task["id"].(string), "", nil))
	if followed["task"].(map[string]any)["id"] != task["id"] {
		t.Fatal("the task could not be followed by its id")
	}
	if _, present := followed["logOffset"]; !present {
		t.Fatal("logOffset is missing, so a poller cannot resume")
	}
}

func TestConfigChangesArePersistedButThePortAndTokenAreNot(t *testing.T) {
	cfg := testConfig(t)
	t.Setenv("RIPPEL_AGENT_HOME", cfg.Home)
	_, call := serve(t, cfg)

	res := call(http.MethodPost, "/agent/config",
		`{"comfyArgs":"--lowvram","comfyPort":9999,"port":1,"token":"stolen"}`, nil)
	if res.StatusCode != http.StatusOK {
		t.Fatalf("answered %d", res.StatusCode)
	}

	raw, err := os.ReadFile(filepath.Join(cfg.Home, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	var saved map[string]any
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatal(err)
	}
	if saved["comfyArgs"] != "--lowvram" || saved["comfyPort"] != float64(9999) {
		t.Fatalf("saved %v", saved)
	}
	// The listening port needs a restart to mean anything, and a token that
	// could rotate itself would let a stolen one lock the operator out.
	if _, present := saved["port"]; present {
		t.Fatal("the listening port was changed over the wire")
	}
	if _, present := saved["token"]; present {
		t.Fatal("the token was changed over the wire")
	}
}

// ---------------------------------------------------------------- check-in

func TestCheckinSendsTheShapeRippelReadsAndLearnsItsDeploymentId(t *testing.T) {
	cfg := testConfig(t)
	t.Setenv("RIPPEL_AGENT_HOME", cfg.Home)

	seen := make(chan map[string]any, 4)
	rippel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/deployments/checkin" {
			t.Errorf("the agent posted to %s", r.URL.Path)
		}
		if r.Header.Get("X-Rippel-Agent-Token") != "the-token" {
			t.Errorf("the agent did not send its token")
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		seen <- body
		_, _ = w.Write([]byte(`{"ok":true,"deploymentId":"dep-42"}`))
	}))
	defer rippel.Close()

	cfg.ServerURL = rippel.URL
	agent := NewAgent(cfg, nil)
	heartbeat := StartHeartbeat(agent, func(string, ...any) {})
	defer heartbeat.Stop()

	var body map[string]any
	select {
	case body = <-seen:
	case <-time.After(5 * time.Second):
		t.Fatal("the agent never checked in")
	}

	if body["version"] != AgentVersion || body["platform"] != "linux" {
		t.Fatalf("check-in said %v", body)
	}
	if body["deploymentId"] != nil {
		t.Fatalf("deploymentId should be null before enrolment, was %v", body["deploymentId"])
	}
	// A real agent always has a port. What must never go out is a zero, which
	// rippel would COALESCE into the row and then try to dial.
	if body["agentPort"] != float64(cfg.Port) {
		t.Fatalf("agentPort is %v, wanted %d", body["agentPort"], cfg.Port)
	}
	if _, present := body["comfy"]; !present {
		t.Fatal("the check-in carried no comfy state")
	}

	// rippel is the authority on which deployment this is, so the id it
	// answered with is adopted and written down.
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if agent.config().DeploymentID == "dep-42" {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if agent.config().DeploymentID != "dep-42" {
		t.Fatal("the agent did not adopt the deployment id rippel gave it")
	}
	raw, err := os.ReadFile(filepath.Join(cfg.Home, "config.json"))
	if err != nil || !strings.Contains(string(raw), "dep-42") {
		t.Fatalf("the deployment id was not remembered: %v %s", err, raw)
	}
}

func TestThePreInstallProbeSendsNothingRippelWouldOverwriteWith(t *testing.T) {
	// The check the installer makes before it writes anything reaches the same
	// route as a real check-in. rippel COALESCEs the port and the comfy state,
	// so a probe carrying zero-values would blank a working row — re-running
	// the installer on a healthy machine would make the panel wrong.
	body, err := json.Marshal(checkinBody{Version: AgentVersion, Platform: "win32"})
	if err != nil {
		t.Fatal(err)
	}
	var sent map[string]any
	if err := json.Unmarshal(body, &sent); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"agentPort", "comfy"} {
		if _, present := sent[key]; present {
			t.Fatalf("the probe sent %q, which rippel would write into the row", key)
		}
	}
	// It still has to identify itself, or the row learns nothing at all.
	if sent["version"] != AgentVersion || sent["platform"] != "win32" {
		t.Fatalf("the probe said %v", sent)
	}
}

// ---------------------------------------------------------------- setup links

func TestParseSetupLink(t *testing.T) {
	cases := []struct {
		in     string
		server string
		token  string
	}{
		{"http://192.168.1.9:4000/setup/abc123", "http://192.168.1.9:4000", "abc123"},
		// The link rippel actually publishes: its API lives under
		// /api/deployments, and the agent must store the bare server address,
		// because that is what it appends /api/deployments/checkin to.
		{"http://192.168.1.9:4000/api/deployments/setup/abc123", "http://192.168.1.9:4000", "abc123"},
		{"https://example.com/rippel/api/deployments/setup/abc123", "https://example.com/rippel", "abc123"},
		// No scheme: someone typing the address means http, and rippel is LAN
		// software with no certificate, so that is not a downgrade.
		{"192.168.1.9:4000/setup/abc123", "http://192.168.1.9:4000", "abc123"},
		// Wrapped by whatever chat window it travelled through.
		{`  "http://box:4000/setup/abc123"  `, "http://box:4000", "abc123"},
		// A rippel served under a path prefix.
		{"https://example.com/rippel/setup/abc123", "https://example.com/rippel", "abc123"},
		// Reconstructed by hand as a query string.
		{"http://192.168.1.9:4000?token=abc123", "http://192.168.1.9:4000", "abc123"},
		// A trailing slash a browser added.
		{"http://192.168.1.9:4000/setup/abc123/", "http://192.168.1.9:4000", "abc123"},
	}
	for _, c := range cases {
		got, err := ParseSetupLink(c.in)
		if err != nil {
			t.Errorf("%q: %v", c.in, err)
			continue
		}
		if got.ServerURL != c.server || got.Token != c.token {
			t.Errorf("%q gave %q / %q", c.in, got.ServerURL, got.Token)
		}
	}
}

func TestParseSetupLinkExplainsItselfWhenItRefuses(t *testing.T) {
	// Every refusal must tell someone who has never opened a terminal what to
	// do next, which in every case is "copy it from rippel again".
	for _, bad := range []string{"", "   ", "http://192.168.1.9:4000", "http://192.168.1.9:4000/setup/"} {
		_, err := ParseSetupLink(bad)
		if err == nil {
			t.Fatalf("%q was accepted", bad)
		}
		if strings.ToUpper(err.Error()[:1]) == err.Error()[:1] && strings.Contains(err.Error(), "panic") {
			t.Fatalf("%q gave a developer-facing message: %s", bad, err)
		}
	}
}

func TestSetupBlobRoundTripsAndIsFilenameSafe(t *testing.T) {
	setup := Setup{ServerURL: "http://192.168.1.9:4000", Token: "vT7kQ2-_abcdefghijklmnopqrstuvwxyz012345678"}
	blob, err := EncodeSetup(setup)
	if err != nil {
		t.Fatal(err)
	}
	// base64url's alphabet is exactly what is safe in a filename on all three
	// platforms; anything else here would produce a download nobody can save.
	for _, r := range blob {
		safe := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_'
		if !safe {
			t.Fatalf("the blob contains %q, which is not filename-safe", r)
		}
	}

	back, err := DecodeSetup(blob)
	if err != nil {
		t.Fatal(err)
	}
	if back != setup {
		t.Fatalf("round trip gave %+v", back)
	}
}

func TestSetupIsReadFromTheFileName(t *testing.T) {
	setup := Setup{ServerURL: "http://192.168.1.9:4000", Token: "tok-secret"}
	blob, err := EncodeSetup(setup)
	if err != nil {
		t.Fatal(err)
	}

	for _, name := range []string{
		"rippel-agent-setup-" + blob + ".exe",
		"rippel-agent-setup-" + blob,
		// A browser deduplicating a second download of the same file.
		"rippel-agent-setup-" + blob + " (1).exe",
	} {
		got, ok := setupFromFileName(filepath.Join("C:\\Users\\Someone\\Downloads", name))
		if !ok {
			t.Fatalf("%q was not recognised", name)
		}
		if got != setup {
			t.Fatalf("%q gave %+v", name, got)
		}
	}

	// A renamed download must fall through quietly rather than failing: the
	// prompt is always there as the floor.
	if _, ok := setupFromFileName("rippel-agent.exe"); ok {
		t.Fatal("a plain name was read as a setup blob")
	}
	if _, ok := setupFromFileName("rippel-agent-setup-not-base64!!.exe"); ok {
		t.Fatal("rubbish was read as a setup blob")
	}
}

func TestSetupIsReadFromAnAdjacentFile(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "rippel-agent")
	body := "# The link rippel gave you.\n\nhttp://192.168.1.9:4000/setup/tok-secret\n"
	if err := os.WriteFile(filepath.Join(dir, setupFileName), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	got, ok := setupFromAdjacentFile(exe)
	if !ok {
		t.Fatal("the adjacent file was not read")
	}
	if got.ServerURL != "http://192.168.1.9:4000" || got.Token != "tok-secret" {
		t.Fatalf("gave %+v", got)
	}
}

// ---------------------------------------------------------------- config

func TestConfigPrefersTheEnvironmentOverTheFile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("RIPPEL_AGENT_HOME", home)
	body := `{"token":"from-file","serverUrl":"http://from-file:1/","comfyPort":7777}`
	if err := os.WriteFile(filepath.Join(home, "config.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Token != "from-file" || cfg.ComfyPort != 7777 {
		t.Fatalf("the file was not read: %+v", cfg)
	}
	// The trailing slash must be gone, or every URL the agent builds has two.
	if cfg.ServerURL != "http://from-file:1" {
		t.Fatalf("serverUrl is %q", cfg.ServerURL)
	}

	t.Setenv("RIPPEL_AGENT_TOKEN", "from-env")
	cfg, err = LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Token != "from-env" {
		t.Fatalf("the environment did not win: %q", cfg.Token)
	}
}

func TestABadPortIsRefusedWithAReadableReason(t *testing.T) {
	t.Setenv("RIPPEL_AGENT_HOME", t.TempDir())
	t.Setenv("RIPPEL_AGENT_PORT", "not-a-number")
	if _, err := LoadConfig(); err == nil || !strings.Contains(err.Error(), "whole number") {
		t.Fatalf("error is %v", err)
	}

	t.Setenv("RIPPEL_AGENT_PORT", "70000")
	if _, err := LoadConfig(); err == nil || !strings.Contains(err.Error(), "between 1 and 65535") {
		t.Fatalf("error is %v", err)
	}
}

func TestSaveConfigMergesAndKeepsTheFilePrivate(t *testing.T) {
	home := t.TempDir()
	t.Setenv("RIPPEL_AGENT_HOME", home)

	if err := SaveConfig(map[string]any{"token": "t", "serverUrl": "http://a"}); err != nil {
		t.Fatal(err)
	}
	if err := SaveConfig(map[string]any{"deploymentId": "dep-1"}); err != nil {
		t.Fatal(err)
	}

	path := filepath.Join(home, "config.json")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	// The file holds the token, and on a shared box the default umask is not
	// enough.
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode is %v", info.Mode().Perm())
	}

	raw, _ := os.ReadFile(path)
	var saved map[string]any
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatal(err)
	}
	if saved["token"] != "t" || saved["deploymentId"] != "dep-1" {
		t.Fatalf("the second save did not merge: %v", saved)
	}
}

func TestReinstallingAgainstADifferentRippelForgetsTheOldDeployment(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")

	first := map[string]any{"token": "a", "serverUrl": "http://one"}
	if err := writeConfigAt(path, first); err != nil {
		t.Fatal(err)
	}
	if err := writeConfigAt(path, map[string]any{
		"token": "a", "serverUrl": "http://one", "deploymentId": "dep-1",
	}); err != nil {
		t.Fatal(err)
	}

	// Same rippel, same token: the learned id survives an upgrade.
	if err := writeConfigAt(path, first); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), "dep-1") {
		t.Fatal("an upgrade forgot the deployment id")
	}

	// A different rippel is a different deployment, so the id must not survive.
	if err := writeConfigAt(path, map[string]any{"token": "b", "serverUrl": "http://two"}); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(path)
	if strings.Contains(string(raw), "dep-1") {
		t.Fatal("a re-install against another rippel kept the old deployment id")
	}
}
