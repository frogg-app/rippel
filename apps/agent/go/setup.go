package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// How the agent learns which rippel it belongs to, without anyone editing a
// file.
//
// There are three ways in, in the order they are tried, and they exist because
// a non-technical person's path through this has three shapes:
//
//  1. The download itself carried it. rippel names the file it serves
//     `rippel-agent-setup-<blob>.exe`, where the blob is this deployment's
//     server address and token. Double-clicking that is genuinely one click:
//     the exe reads its own filename and needs nothing else. If a browser or a
//     tidy-minded user renames it, nothing breaks — we simply fall through.
//  2. A `rippel-setup.txt` sitting next to the exe, holding the setup link. That
//     is what an operator gets if they unzip a folder, and what someone who
//     "saved the link somewhere" can be told to do.
//  3. The setup link pasted at the prompt, which is the floor: it always works,
//     it is one line, and it is what rippel's Deployment screen shows.

// SetupLinkPrefix is the path rippel publishes setup links under.
const SetupLinkPrefix = "/setup/"

// apiPrefixes are stripped from whatever precedes /setup/ to recover the server
// address the agent should check in to.
//
// rippel serves its whole API under /api, and this route under
// /api/deployments, so the published link is
// <serverUrl>/api/deployments/setup/<token> — while what the agent needs to
// store is <serverUrl>, because that is what it appends
// /api/deployments/checkin to. Stripping a known suffix is the whole
// conversion, and it is done here rather than by the person pasting the link.
var apiPrefixes = []string{"/api/deployments", "/api"}

// setupFileName is the file the agent looks for beside itself, as an
// alternative to a name-carried blob.
const setupFileName = "rippel-setup.txt"

// Setup is everything the agent needs to enrol: which rippel, and the token
// that proves it belongs there.
type Setup struct {
	ServerURL string `json:"s"`
	Token     string `json:"t"`
	// Optional, and normally absent: the defaults are right on almost every
	// machine, and a blob that carries fewer fields makes a shorter filename.
	AgentPort int `json:"p,omitempty"`
	ComfyPort int `json:"c,omitempty"`
}

// EncodeSetup packs a setup into the base64url blob that goes in a filename.
// base64url's alphabet is exactly the characters that are safe in a filename on
// all three platforms, which is why it is the encoding and not, say, hex of
// JSON with punctuation in it.
func EncodeSetup(s Setup) (string, error) {
	body, err := json.Marshal(s)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(body), nil
}

// DecodeSetup unpacks that blob.
func DecodeSetup(blob string) (Setup, error) {
	raw, err := base64.RawURLEncoding.DecodeString(blob)
	if err != nil {
		return Setup{}, errors.New("that is not a setup code")
	}
	var s Setup
	if err := json.Unmarshal(raw, &s); err != nil {
		return Setup{}, errors.New("that setup code is damaged")
	}
	if s.ServerURL == "" || s.Token == "" {
		return Setup{}, errors.New("that setup code is missing the server address or the token")
	}
	return s, nil
}

// ParseSetupLink reads the link rippel's Deployment screen shows:
//
//	http://192.168.1.9:4000/setup/AbC123...
//
// The server address is everything before /setup/, so a rippel served under a
// path prefix works without a special case. It also accepts a bare
// `<url>?token=<token>`, because that is what someone reconstructing the link
// by hand tends to produce, and refusing it would be pedantry.
func ParseSetupLink(link string) (Setup, error) {
	text := strings.TrimSpace(link)
	// A pasted link often arrives wrapped in quotes or angle brackets by
	// whatever chat window it travelled through.
	text = strings.Trim(text, `"'<>`)
	if text == "" {
		return Setup{}, errors.New("that was empty")
	}
	// Someone who types the address without a scheme means http; rippel has no
	// certificate and is LAN software, so this is not a downgrade.
	if !strings.Contains(text, "://") {
		text = "http://" + text
	}

	parsed, err := url.Parse(text)
	if err != nil || parsed.Host == "" {
		return Setup{}, fmt.Errorf(
			"that does not look like a link. It should look like " +
				"http://192.168.1.9:4000/setup/xxxxxxxx — copy it from rippel's Deployment screen.")
	}

	if token := parsed.Query().Get("token"); token != "" {
		base := strings.TrimRight(parsed.Path, "/")
		for _, prefix := range apiPrefixes {
			if strings.HasSuffix(base, prefix) {
				base = strings.TrimSuffix(base, prefix)
				break
			}
		}
		return Setup{
			ServerURL: strings.TrimRight(parsed.Scheme+"://"+parsed.Host+base, "/"),
			Token:     token,
		}, nil
	}

	index := strings.LastIndex(parsed.Path, SetupLinkPrefix)
	if index < 0 {
		return Setup{}, errors.New(
			"that link has no setup code in it. Copy the whole line from rippel's " +
				"Deployment screen — it ends with /setup/ and a long code.")
	}
	token := strings.Trim(parsed.Path[index+len(SetupLinkPrefix):], "/")
	if token == "" {
		return Setup{}, errors.New("that link ends at /setup/ with no code after it")
	}
	base := strings.TrimRight(parsed.Path[:index], "/")
	for _, prefix := range apiPrefixes {
		if strings.HasSuffix(base, prefix) {
			base = strings.TrimSuffix(base, prefix)
			break
		}
	}
	return Setup{
		ServerURL: strings.TrimRight(parsed.Scheme+"://"+parsed.Host+base, "/"),
		Token:     token,
	}, nil
}

// setupFromFileName reads the blob out of the executable's own name, which is
// how a one-click download carries its credentials.
func setupFromFileName(path string) (Setup, bool) {
	name := filepath.Base(path)
	name = strings.TrimSuffix(name, filepath.Ext(name))
	// Browsers deduplicate downloads by appending " (1)" or "-1"; strip a
	// trailing parenthesised or dashed counter before looking at the blob.
	if open := strings.LastIndex(name, " ("); open > 0 && strings.HasSuffix(name, ")") {
		name = name[:open]
	}
	name = strings.TrimSpace(name)

	const marker = "rippel-agent-setup-"
	index := strings.Index(name, marker)
	if index < 0 {
		return Setup{}, false
	}
	setup, err := DecodeSetup(name[index+len(marker):])
	if err != nil {
		return Setup{}, false
	}
	return setup, true
}

// setupFromAdjacentFile reads rippel-setup.txt from beside the executable. The
// file holds the setup link, one line, and anything starting with # is a
// comment so the file can explain itself.
func setupFromAdjacentFile(exePath string) (Setup, bool) {
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(exePath), setupFileName))
	if err != nil {
		return Setup{}, false
	}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if setup, err := ParseSetupLink(line); err == nil {
			return setup, true
		}
	}
	return Setup{}, false
}

// DiscoverSetup tries the two zero-typing routes, in order. It returns false
// when neither found anything, which is the cue to ask.
func DiscoverSetup() (Setup, string, bool) {
	exe, err := os.Executable()
	if err != nil {
		return Setup{}, "", false
	}
	if setup, ok := setupFromFileName(exe); ok {
		return setup, "the name of this file", true
	}
	if setup, ok := setupFromAdjacentFile(exe); ok {
		return setup, setupFileName + " next to it", true
	}
	return Setup{}, "", false
}
