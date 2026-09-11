package main

// Model writes stay beneath an open models-directory handle, including during
// symlink races. Hard-link publication is atomic and refuses an existing name;
// unlike Rename, it cannot silently overwrite a user's file on Unix.
import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type ModelMove struct {
	From string `json:"from"`
	To   string `json:"to"`
}
type ModelDownload struct {
	URL       string `json:"url"`
	Path      string `json:"path"`
	SHA256    string `json:"sha256"`
	SizeBytes int64  `json:"sizeBytes,omitempty"`
}

func modelPath(name string) (string, error) {
	name = strings.ReplaceAll(name, "\\", "/")
	if name == "" || strings.ContainsAny(name, ":\x00") || strings.HasPrefix(name, "/") {
		return "", fmt.Errorf("model path must be relative to models")
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." {
			return "", fmt.Errorf("invalid model path component")
		}
	}
	local, err := filepath.Localize(name)
	if err != nil {
		return "", err
	}
	return local, nil
}

func modelRoot(cfg *Config) (*os.Root, error) {
	// Open models relative to the ComfyUI handle: a models symlink escaping the
	// ComfyUI installation is refused too. Never create a guessed install path.
	comfy, err := os.OpenRoot(cfg.ComfyPath)
	if err != nil {
		return nil, err
	}
	defer comfy.Close()
	return comfy.OpenRoot("models")
}

func ensureDestination(root *os.Root, name string) error {
	if _, err := root.Lstat(name); err == nil {
		return fmt.Errorf("destination already exists; refusing to replace it")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return root.MkdirAll(filepath.Dir(name), 0755)
}

func moveModel(cfg *Config, task *Task, body ModelMove) error {
	from, err := modelPath(body.From)
	if err != nil {
		return err
	}
	to, err := modelPath(body.To)
	if err != nil {
		return err
	}
	root, err := modelRoot(cfg)
	if err != nil {
		return err
	}
	defer root.Close()
	info, err := root.Lstat(from)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("source must be a regular file, not a symlink or directory")
	}
	if err := ensureDestination(root, to); err != nil {
		return err
	}
	task.Appendf("Moving %s to %s. No download.", body.From, body.To)
	if err := root.Link(from, to); err != nil {
		return fmt.Errorf("could not move on the same disk: %w", err)
	}
	if err := root.Remove(from); err != nil {
		// Keep both files if removal fails. Never risk deleting the only copy.
		return fmt.Errorf("destination created but source retained: %w", err)
	}
	return nil
}

func allowedModelURL(raw string, redirect bool) error {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" || (u.Port() != "" && u.Port() != "443") {
		return fmt.Errorf("model downloads require HTTPS without credentials, fragments or custom ports")
	}
	host := strings.ToLower(u.Hostname())
	allowed := host == "huggingface.co" || host == "civitai.com"
	// Hugging Face serves its signed blobs from its own Xet/CDN hosts.
	if redirect {
		allowed = allowed || host == "cdn-lfs.huggingface.co" || host == "cdn-lfs-us-1.huggingface.co" ||
			host == "cdn-lfs-eu-1.huggingface.co" || host == "cas-bridge.xethub.hf.co"
	}
	if !allowed {
		return fmt.Errorf("download host %q is not an approved model host", host)
	}
	return nil
}

func modelHTTPClient(transport http.RoundTripper) *http.Client {
	return &http.Client{Timeout: 12 * time.Hour, Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("too many download redirects")
			}
			return allowedModelURL(req.URL.String(), true)
		},
	}
}

func downloadModel(cfg *Config, task *Task, body ModelDownload, client *http.Client) error {
	dest, err := modelPath(body.Path)
	if err != nil {
		return err
	}
	if err := allowedModelURL(body.URL, false); err != nil {
		return err
	}
	hash, err := hex.DecodeString(body.SHA256)
	if err != nil || len(hash) != sha256.Size {
		return fmt.Errorf("a 64-character SHA-256 is required")
	}
	if body.SizeBytes < 0 {
		return fmt.Errorf("sizeBytes must not be negative")
	}
	root, err := modelRoot(cfg)
	if err != nil {
		return err
	}
	defer root.Close()
	if err := ensureDestination(root, dest); err != nil {
		return err
	}
	temp := filepath.Join(filepath.Dir(dest), ".rippel-"+newID()+".part")
	file, err := root.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	defer func() { file.Close(); root.Remove(temp) }()
	response, err := client.Get(body.URL)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("model download returned HTTP %d", response.StatusCode)
	}
	if body.SizeBytes > 0 && response.ContentLength >= 0 && response.ContentLength != body.SizeBytes {
		return fmt.Errorf("download size differs from the confirmed size")
	}
	total := response.ContentLength
	if body.SizeBytes > 0 {
		total = body.SizeBytes
	}
	task.setBytes(0, total)
	h := sha256.New()
	writer := io.MultiWriter(file, h)
	buf := make([]byte, 1024*1024)
	var received int64
	for {
		n, readErr := response.Body.Read(buf)
		if n > 0 {
			received += int64(n)
			if body.SizeBytes > 0 && received > body.SizeBytes {
				return fmt.Errorf("download exceeds confirmed size")
			}
			if _, err := writer.Write(buf[:n]); err != nil {
				return err
			}
			task.setBytes(received, total)
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	if body.SizeBytes > 0 && received != body.SizeBytes {
		return fmt.Errorf("download is incomplete")
	}
	if !strings.EqualFold(hex.EncodeToString(h.Sum(nil)), body.SHA256) {
		return fmt.Errorf("SHA-256 mismatch; discarded download")
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := root.Link(temp, dest); err != nil {
		return fmt.Errorf("refusing to replace destination: %w", err)
	}
	task.Appendf("Verified and installed %s (%d bytes)", body.Path, received)
	return nil
}

func (a *Agent) modelOperation(w http.ResponseWriter, r *http.Request, move bool) {
	cfg := a.config()
	if move {
		var body ModelMove
		if err := readBody(r, &body); err != nil {
			writeError(w, 400, "bad_request", err.Error())
			return
		}
		a.begin(w, "model-files", func(t *Task) error { err := moveModel(cfg, t, body); a.changed(); return err })
	} else {
		var body ModelDownload
		if err := readBody(r, &body); err != nil {
			writeError(w, 400, "bad_request", err.Error())
			return
		}
		a.begin(w, "model-files", func(t *Task) error { err := downloadModel(cfg, t, body, modelHTTPClient(nil)); a.changed(); return err })
	}
}
