package main

import (
	"encoding/json"
	"fmt"
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
// file outside its own folder, and the pairing input — which is the one piece of
// this program a non-technical person interacts with directly, so its failure
// messages are as much of the contract as its successes.

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
	// A real agent always has a port. What must never go out is a zero, which
	// rippel would COALESCE into the row and then try to dial.
	if body["agentPort"] != float64(cfg.Port) {
		t.Fatalf("agentPort is %v, wanted %d", body["agentPort"], cfg.Port)
	}
	if _, present := body["comfy"]; !present {
		t.Fatal("the check-in carried no comfy state")
	}

	// rippel remains the authority on which deployment this is, even though
	// pairing already told the agent: if the two ever disagree, rippel wins.
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

func TestAPartialCheckinBodyOmitsWhatRippelWouldOverwriteWith(t *testing.T) {
	// rippel COALESCEs the port and the comfy state, so a body carrying
	// zero-values would blank a working row. The struct tags are what prevent
	// that, and they are easy to remove by accident.
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
			t.Fatalf("a partial check-in sent %q, which rippel would write into the row", key)
		}
	}
	if sent["version"] != AgentVersion || sent["platform"] != "win32" {
		t.Fatalf("it said %v", sent)
	}
}

// ---------------------------------------------------------------- pairing

func TestNormaliseServerURL(t *testing.T) {
	cases := []struct{ in, want string }{
		{"http://192.168.1.9:4000", "http://192.168.1.9:4000"},
		// No scheme: someone typing the address means http, and rippel is LAN
		// software with no certificate, so that is not a downgrade.
		{"192.168.1.9:4000", "http://192.168.1.9:4000"},
		// A trailing slash a browser added.
		{"http://192.168.1.9:4000/", "http://192.168.1.9:4000"},
		// Wrapped by whatever chat window it travelled through.
		{`  "http://box:4000"  `, "http://box:4000"},
		// A rippel served under a path prefix.
		{"https://example.com/rippel", "https://example.com/rippel"},
		// Someone who pasted an API URL meant the server. The agent must store
		// the bare address, because that is what it appends
		// /api/deployments/pair and /api/deployments/checkin to — failing to
		// strip this sends every call to /api/deployments/api/deployments/...,
		// a 404 that looks exactly like "this is not a rippel".
		{"http://192.168.1.9:4000/api/deployments", "http://192.168.1.9:4000"},
		{"http://192.168.1.9:4000/api", "http://192.168.1.9:4000"},
		{"https://example.com/rippel/api/deployments", "https://example.com/rippel"},
	}
	for _, c := range cases {
		got, err := NormaliseServerURL(c.in)
		if err != nil {
			t.Errorf("%q: %v", c.in, err)
			continue
		}
		if got != c.want {
			t.Errorf("%q gave %q, wanted %q", c.in, got, c.want)
		}
	}
}

func TestNormaliseServerURLExplainsItselfWhenItRefuses(t *testing.T) {
	for _, bad := range []string{"", "   ", "ftp://192.168.1.9", "http://"} {
		if _, err := NormaliseServerURL(bad); err == nil {
			t.Fatalf("%q was accepted", bad)
		}
	}
}

func TestNormalisePairingCodeTakesWhatAPersonActuallyTypes(t *testing.T) {
	// The same code, written down the ways people write things down.
	for _, in := range []string{
		"K7QM4XTB",
		"k7qm4xtb",
		"K7QM-4XTB",
		"K7QM 4XTB",
		" k7qm4xtb ",
		`"K7QM4XTB"`,
		"K7QM_4XTB",
	} {
		got, err := NormalisePairingCode(in)
		if err != nil {
			t.Errorf("%q: %v", in, err)
			continue
		}
		if got != "K7QM4XTB" {
			t.Errorf("%q gave %q", in, got)
		}
	}
}

func TestNormalisePairingCodeRefusesTheAmbiguousCharactersByName(t *testing.T) {
	// The alphabet has no O/0 and no I/1/L precisely so a person never has to
	// tell them apart. A code containing one is therefore a misreading, and
	// saying which character is wrong is more use than "invalid code".
	for _, bad := range []string{"K7QM4XTO", "K7QM4XT0", "K7QM4XTI", "K7QM4XT1", "K7QM4XTL"} {
		_, err := NormalisePairingCode(bad)
		if err == nil {
			t.Fatalf("%q was accepted", bad)
		}
		if !strings.Contains(err.Error(), "not part of a pairing code") {
			t.Fatalf("%q gave an unhelpful message: %s", bad, err)
		}
	}

	// Wrong length says so, with both numbers.
	if _, err := NormalisePairingCode("K7QM4XT"); err == nil ||
		!strings.Contains(err.Error(), "8 characters") {
		t.Fatalf("a short code gave %v", err)
	}
	if _, err := NormalisePairingCode(""); err == nil {
		t.Fatal("an empty code was accepted")
	}
}

func TestPairSendsTheCodeAndKeepsWhatComesBack(t *testing.T) {
	var seenPath, seenCode string
	rippel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		var body struct {
			Code string `json:"code"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		seenCode = body.Code
		_, _ = w.Write([]byte(
			`{"deploymentId":"dep-7","token":"tok-abc","serverUrl":"http://canonical:4000"}`))
	}))
	defer rippel.Close()

	setup, err := Pair(rippel.URL, "K7QM4XTB")
	if err != nil {
		t.Fatal(err)
	}
	if seenPath != "/api/deployments/pair" {
		t.Fatalf("the agent posted to %s", seenPath)
	}
	if seenCode != "K7QM4XTB" {
		t.Fatalf("it sent the code as %q", seenCode)
	}
	if setup.Token != "tok-abc" || setup.DeploymentID != "dep-7" {
		t.Fatalf("pairing gave %+v", setup)
	}
	// rippel knows which address really reached it, and that beats what was
	// typed — an agent set up via one name must check in to one that works.
	if setup.ServerURL != "http://canonical:4000" {
		t.Fatalf("serverUrl is %q", setup.ServerURL)
	}
}

func TestPairShowsRippelsOwnRefusalRatherThanAGenericOne(t *testing.T) {
	// rippel writes these for exactly this audience — someone standing at a
	// machine with a code that will not work — so they must not be swallowed.
	for _, c := range []struct {
		status  int
		body    string
		wanting string
	}{
		{http.StatusConflict, `{"error":"code_used","message":"That pairing code has already been used."}`, "already been used"},
		{http.StatusGone, `{"error":"code_expired","message":"That pairing code has expired."}`, "expired"},
		{http.StatusTooManyRequests, `{"error":"rate_limited","message":"Too many pairing attempts from this address."}`, "Too many"},
	} {
		rippel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("content-type", "application/json")
			w.WriteHeader(c.status)
			_, _ = w.Write([]byte(c.body))
		}))
		_, err := Pair(rippel.URL, "K7QM4XTB")
		rippel.Close()
		if err == nil || !strings.Contains(err.Error(), c.wanting) {
			t.Fatalf("status %d gave %v", c.status, err)
		}
	}
}

func TestPairRefusesAnAnswerThatIsNotRippels(t *testing.T) {
	// Something answered, but it was not rippel. Installing from this would
	// produce an agent with no credentials that never appears.
	rippel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`<html>hello</html>`))
	}))
	defer rippel.Close()

	if _, err := Pair(rippel.URL, "K7QM4XTB"); err == nil {
		t.Fatal("a non-rippel answer was accepted")
	}

	// Valid JSON, but no credentials in it.
	empty := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"deploymentId":"dep-7"}`))
	}))
	defer empty.Close()
	if _, err := Pair(empty.URL, "K7QM4XTB"); err == nil {
		t.Fatal("an answer with no token was accepted")
	}
}

func TestParseInstallFlags(t *testing.T) {
	for _, c := range []struct{ args []string }{
		{[]string{"--server", "http://a:4000", "--code", "K7QM4XTB"}},
		{[]string{"--server=http://a:4000", "--code=K7QM4XTB"}},
		{[]string{"--code", "K7QM4XTB", "--server", "http://a:4000"}},
	} {
		server, code, err := parseInstallFlags(c.args)
		if err != nil {
			t.Fatalf("%v: %v", c.args, err)
		}
		if server != "http://a:4000" || code != "K7QM4XTB" {
			t.Fatalf("%v gave %q / %q", c.args, server, code)
		}
	}

	// A flag with nothing after it, and an unknown flag, are both named rather
	// than ignored: silently dropping one sends the agent to the prompt and
	// looks like the flags did not work.
	if _, _, err := parseInstallFlags([]string{"--server"}); err == nil {
		t.Fatal("a dangling --server was accepted")
	}
	if _, _, err := parseInstallFlags([]string{"--wat", "x"}); err == nil {
		t.Fatal("an unknown flag was accepted")
	}
}

// ---------------------------------------------------------------- autostart

func TestTheWindowsStartupEntryNeedsNoAdministrator(t *testing.T) {
	// This is the bug the rewrite exists for: schtasks /Create answered
	// "Access is denied" on a real machine. Neither branch can be *executed*
	// here, so what is asserted is the shape of what would be run — that it is
	// the per-user hive and not the machine-wide one, and that a path with a
	// space in it stays quoted.
	if !strings.HasPrefix(windowsRunKey, `HKCU\`) {
		t.Fatalf("the Run key is %q, which is not the per-user hive", windowsRunKey)
	}
	if strings.Contains(strings.ToUpper(windowsRunKey), "HKLM") ||
		strings.Contains(strings.ToUpper(windowsRunKey), "LOCAL_MACHINE") {
		t.Fatal("the machine-wide Run key needs administrator rights")
	}

	exe := `C:\Users\Steve Hughes\.rippel-agent\rippel-agent.exe`
	command := windowsRunCommand(exe)
	if !strings.HasPrefix(command, `"`+exe+`"`) {
		t.Fatalf("the command does not quote the path: %s", command)
	}
	if !strings.HasSuffix(command, " run") {
		t.Fatalf("the command does not run the agent: %s", command)
	}

	// The fallback is a plain text file, so it can be written without COM.
	shim := startupShimBody(exe)
	if !strings.Contains(shim, `start "" /b "`+exe+`" run`) {
		t.Fatalf("the startup script would not launch the agent: %q", shim)
	}
	// start's first quoted argument is the window title. Without the empty
	// pair, a quoted path is read as a title and nothing launches at all.
	if !strings.Contains(shim, `start ""`) {
		t.Fatal("start has no title argument, so the quoted path would be taken as one")
	}
	if !strings.HasSuffix(shim, "\r\n") {
		t.Fatal("a .cmd file wants CRLF line endings")
	}
}

func TestAFailedStartupEntryIsReportedWithoutUndoingTheInstall(t *testing.T) {
	// The owner's machine ended up installed-but-not-starting and was told
	// almost nothing. The message has to name what worked, what did not, and
	// the exact command that finishes the job.
	var out strings.Builder
	say := func(format string, a ...any) {
		out.WriteString(fmt.Sprintf(format, a...) + "\n")
	}
	reportPartialInstall(&AutostartError{
		Detail: "ERROR: Access is denied.",
		Exe:    `C:\Users\steve\.rippel-agent\rippel-agent.exe`,
	}, say)

	text := out.String()
	for _, want := range []string{
		"What worked:",
		"What did not:",
		"ERROR: Access is denied.",
		`C:\Users\steve\.rippel-agent\rippel-agent.exe run`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("the report does not mention %q:\n%s", want, text)
		}
	}
}

// ---------------------------------------------------------------- install

func TestAFailedInstallLeavesNothingBehind(t *testing.T) {
	// The half-installed state is the failure this ordering exists to prevent:
	// a binary and a config on disk and no way to tell. A run that creates the
	// home directory and then fails must take it away again.
	home := filepath.Join(t.TempDir(), "agent-home")
	t.Setenv("RIPPEL_AGENT_HOME", home)
	t.Setenv(skipServiceEnv, "1")

	// A config path that cannot be written: the home is created, the binary is
	// copied, and then writing the config fails.
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(home, "config.json"), 0o700); err != nil {
		t.Fatal(err)
	}

	err := Install(Setup{ServerURL: "http://x:4000", Token: "t", DeploymentID: "d"},
		func(string, ...any) {})
	if err == nil {
		t.Fatal("the install claimed to succeed")
	}
	// The binary this run copied in must be gone again.
	if _, statErr := os.Stat(InstalledPath()); statErr == nil {
		t.Fatal("a failed install left its binary behind")
	}
}

func TestInstallWritesTheDeploymentIdPairingGaveIt(t *testing.T) {
	home := filepath.Join(t.TempDir(), "agent-home")
	t.Setenv("RIPPEL_AGENT_HOME", home)
	t.Setenv(skipServiceEnv, "1")

	setup := Setup{ServerURL: "http://rippel:4000", Token: "tok-abc", DeploymentID: "dep-7"}
	if err := Install(setup, func(string, ...any) {}); err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(filepath.Join(home, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	var saved map[string]any
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatal(err)
	}
	// Pairing knows the id up front, unlike the setup link it replaced, so it
	// is written now rather than learned on the first check-in.
	if saved["deploymentId"] != "dep-7" || saved["token"] != "tok-abc" {
		t.Fatalf("config is %v", saved)
	}
	info, err := os.Stat(filepath.Join(home, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	// It holds the token, and on a shared box the default umask is not enough.
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode is %v", info.Mode().Perm())
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
