package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"
)

// Long-running work, as something a poller can watch.
//
// Installing ComfyUI is minutes of pip output, and the request that asked for
// it must not be held open for those minutes — an HTTP client, a reverse proxy
// and a laptop lid all disagree about how long is too long. So a start returns
// a task id immediately and the output accumulates here, in memory, for
// GET /agent/tasks/:id to read.
//
// In memory is the right scope: a task that was running when the agent was
// restarted did not survive the restart either, and a log that outlived the
// process would claim otherwise.

// maxLines kept per task. Enough for a full pip install, bounded for a long one.
const maxLines = 2000

// keepFinished is how long a finished task stays readable before it is dropped,
// so the map cannot grow forever.
const keepFinished = time.Hour

// TaskView is the wire shape rippel's AgentTask type expects. The JSON tags are
// the contract; do not rename them without changing packages/shared.
//
// It is a separate type from Task on purpose: Task carries the lock that guards
// a log a goroutine is still writing to, and handing that struct to
// json.Marshal would both race with the writer and copy a mutex. A view is
// taken under the lock and is then nobody's but the caller's.
type TaskView struct {
	ID         string   `json:"id"`
	Kind       string   `json:"kind"`
	Status     string   `json:"status"`
	StartedAt  string   `json:"startedAt"`
	FinishedAt *string  `json:"finishedAt"`
	Log        []string `json:"log"`
	Error      *string  `json:"error"`
}

// Task is one piece of long-running work, as the agent holds it.
type Task struct {
	ID        string
	Kind      string
	StartedAt string

	mu         sync.Mutex
	status     string
	finishedAt *string
	log        []string
	err        *string
}

// snapshot copies a task under its lock, keeping the last `logTail` lines (a
// negative tail keeps all of them).
func (t *Task) snapshot(logTail int) TaskView {
	t.mu.Lock()
	defer t.mu.Unlock()

	lines := t.log
	if logTail >= 0 && len(lines) > logTail {
		lines = lines[len(lines)-logTail:]
	}
	return TaskView{
		ID:         t.ID,
		Kind:       t.Kind,
		Status:     t.status,
		StartedAt:  t.StartedAt,
		FinishedAt: t.finishedAt,
		Error:      t.err,
		Log:        append([]string{}, lines...),
	}
}

// Status is the task's state right now: running, done or failed.
func (t *Task) Status() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.status
}

// Err is the failure message, or nil.
func (t *Task) Err() *string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.err
}

// Lines is the whole log, copied.
func (t *Task) Lines() []string {
	lines, _ := t.logFrom(0)
	return lines
}

// logFrom copies the lines after `since`, which is how a poller asks only for
// what it has not seen: a long install does not re-send its whole log every two
// seconds. It also returns the total length, as the next `since`.
func (t *Task) logFrom(since int) ([]string, int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if since < 0 || since > len(t.log) {
		since = 0
	}
	return append([]string{}, t.log[since:]...), len(t.log)
}

// Tasks is the agent's in-memory registry of running and recent work.
type Tasks struct {
	mu    sync.Mutex
	byID  map[string]*Task
	clock func() time.Time
}

func NewTasks() *Tasks {
	return &Tasks{byID: map[string]*Task{}, clock: time.Now}
}

func newID() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand does not fail in practice, and a task id is not a
		// credential — a timestamp is a fine last resort.
		return fmt.Sprintf("task-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf)
}

func (ts *Tasks) Create(kind string) *Task {
	task := &Task{
		ID:        newID(),
		Kind:      kind,
		StartedAt: ts.clock().UTC().Format(time.RFC3339Nano),
		status:    "running",
		log:       []string{},
	}
	ts.mu.Lock()
	ts.byID[task.ID] = task
	ts.mu.Unlock()
	return task
}

func (ts *Tasks) Get(id string) *Task {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	return ts.byID[id]
}

// List is newest first, which is the order the panel shows them in.
func (ts *Tasks) List() []*Task {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	out := make([]*Task, 0, len(ts.byID))
	for _, task := range ts.byID {
		out = append(out, task)
	}
	sort.Slice(out, func(a, b int) bool { return out[a].StartedAt > out[b].StartedAt })
	return out
}

// IsRunning reports whether a task of this kind is already going. Two
// concurrent pip installs into one venv corrupt it in ways that look like a
// mystery import error hours later, so refusing the second is a real safety
// measure rather than tidiness.
func (ts *Tasks) IsRunning(kind string) bool {
	ts.mu.Lock()
	defer ts.mu.Unlock()
	for _, task := range ts.byID {
		task.mu.Lock()
		match := task.Kind == kind && task.status == "running"
		task.mu.Unlock()
		if match {
			return true
		}
	}
	return false
}

func (ts *Tasks) forget(id string) {
	ts.mu.Lock()
	delete(ts.byID, id)
	ts.mu.Unlock()
}

// Append adds text to a task's log, one entry per line, dropping blank ones.
func (t *Task) Append(text string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, line := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		t.log = append(t.log, line)
	}
	// Keep the tail: the end of a failing install says why, the start says what.
	if len(t.log) > maxLines {
		t.log = append([]string{}, t.log[len(t.log)-maxLines:]...)
	}
}

func (t *Task) Appendf(format string, args ...any) {
	t.Append(fmt.Sprintf(format, args...))
}

// Finish closes a task off, recording why if it failed.
func (ts *Tasks) Finish(task *Task, cause error) {
	now := ts.clock().UTC().Format(time.RFC3339Nano)
	task.mu.Lock()
	if cause != nil {
		message := cause.Error()
		task.status = "failed"
		task.err = &message
	} else {
		task.status = "done"
		task.err = nil
	}
	task.finishedAt = &now
	task.mu.Unlock()

	if cause != nil {
		task.Appendf("error: %s", cause.Error())
	}
	time.AfterFunc(keepFinished, func() { ts.forget(task.ID) })
}

// Run executes one command, streaming both its streams into the task log.
//
// It returns nil on exit code 0 and an error otherwise, so a sequence of steps
// reads as plain `if err := ...` and the first failure stops the rest. No shell
// is ever used: every argument is passed separately, so a path with a space in
// it — C:\Program Files\..., the common case on Windows — needs no quoting and
// nothing in a task's input can be read as a command.
func Run(task *Task, dir string, env []string, command string, args ...string) error {
	task.Appendf("$ %s %s", command, strings.Join(args, " "))

	cmd := exec.Command(command, args...)
	cmd.Dir = dir
	cmd.Env = env

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("could not run %s: %w", command, err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("could not run %s: %w", command, err)
	}

	if err := cmd.Start(); err != nil {
		// exec.ErrNotFound and a bad path both land here, and the message a
		// person needs is "that program is not on this machine".
		return fmt.Errorf("could not run %s: %w", command, err)
	}

	var wg sync.WaitGroup
	pump := func(stream io.Reader) {
		defer wg.Done()
		scanner := bufio.NewScanner(stream)
		// pip prints progress bars that are one very long line; the default
		// 64KB limit would turn that into an error rather than a log line.
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			task.Append(scanner.Text())
		}
	}
	wg.Add(2)
	go pump(stdout)
	go pump(stderr)
	wg.Wait()

	if err := cmd.Wait(); err != nil {
		var exit *exec.ExitError
		if ok := asExitError(err, &exit); ok {
			return fmt.Errorf("%s exited with code %d", command, exit.ExitCode())
		}
		return fmt.Errorf("%s failed: %w", command, err)
	}
	return nil
}

func asExitError(err error, target **exec.ExitError) bool {
	if exit, ok := err.(*exec.ExitError); ok {
		*target = exit
		return true
	}
	return false
}
