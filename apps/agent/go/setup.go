package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// How the agent learns which rippel it belongs to.
//
// Two questions, both answerable by a person reading a screen: where rippel is,
// and an eight-character code. Nothing else is asked, and in particular the
// deployment id is never asked for — it comes back from redeeming the code.
// Anything a human has to copy correctly is a place the setup fails.
//
// This replaces a scheme where the download's *filename* carried the server
// address and a long-lived token. That was one click when it worked, and an
// unexplainable failure when a browser renamed the file — and it forced every
// rippel to build and serve its own executable.

// Setup is everything the agent needs to run, once pairing has succeeded.
type Setup struct {
	ServerURL    string
	Token        string
	DeploymentID string
}

// NormaliseServerURL turns what a person typed into an address the agent can
// use, or explains why it cannot.
//
// It accepts more than it strictly should, because every rejection here is
// somebody at a keyboard who has been told to "paste the address from rippel":
// a missing scheme, a trailing slash, wrapping quotes from a chat window, and a
// pasted API path are all things that happen and none of them are ambiguous.
func NormaliseServerURL(raw string) (string, error) {
	text := strings.TrimSpace(raw)
	// A pasted address often arrives wrapped by whatever it travelled through.
	text = strings.Trim(text, `"'<>`)
	if text == "" {
		return "", errors.New("that was empty")
	}
	// Someone who types the address without a scheme means http; rippel has no
	// certificate and is LAN software, so this is not a downgrade.
	if !strings.Contains(text, "://") {
		text = "http://" + text
	}

	parsed, err := url.Parse(text)
	if err != nil || parsed.Host == "" {
		return "", errors.New(
			"that does not look like an address. It should look like " +
				"http://192.168.1.9:4000 — copy it from rippel's Deployment screen")
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("rippel is reached over http or https, not %q", parsed.Scheme)
	}

	// rippel serves its API under /api, and this route under /api/deployments.
	// Someone who pasted a full API URL meant the server, so the known suffixes
	// are stripped rather than refused — what the agent stores must be the bare
	// address, because that is what it appends /api/deployments/... to.
	base := strings.TrimRight(parsed.Path, "/")
	for _, prefix := range []string{"/api/deployments", "/api"} {
		if strings.HasSuffix(base, prefix) {
			base = strings.TrimSuffix(base, prefix)
			break
		}
	}
	return strings.TrimRight(parsed.Scheme+"://"+parsed.Host+base, "/"), nil
}

// pairingAlphabet must match ALPHABET in apps/api/src/deploy/pairing.ts.
//
// It has no O/0 and no I/1/L in it, so there is no ambiguous character for a
// person to get wrong in either direction. That also means there is nothing to
// fold one character onto at this end: a code containing one of the excluded
// characters is simply not a code, and saying so beats guessing.
const pairingAlphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

// PairingCodeLength must match CODE_LENGTH in pairing.ts.
const PairingCodeLength = 8

// NormalisePairingCode uppercases and removes the separators people add, then
// checks the result really is a code. The same normalisation runs on the server
// before hashing, so the two must agree character for character.
func NormalisePairingCode(raw string) (string, error) {
	text := strings.TrimSpace(raw)
	text = strings.Trim(text, `"'<>`)
	text = strings.ToUpper(text)
	// Whatever someone used to group the characters, and nothing else.
	var cleaned strings.Builder
	for _, r := range text {
		if r == ' ' || r == '-' || r == '_' || r == '\t' {
			continue
		}
		cleaned.WriteRune(r)
	}
	code := cleaned.String()

	if code == "" {
		return "", errors.New("that was empty")
	}
	if len(code) != PairingCodeLength {
		return "", fmt.Errorf(
			"a pairing code is %d characters, and that was %d", PairingCodeLength, len(code))
	}
	for _, r := range code {
		if !strings.ContainsRune(pairingAlphabet, r) {
			return "", fmt.Errorf(
				"%q is not part of a pairing code. Codes never contain the letter O or the "+
					"digit zero, nor I, L or the digit one — check it against rippel's screen", string(r))
		}
	}
	return code, nil
}

// pairResponse is the wire shape of POST /api/deployments/pair.
type pairResponse struct {
	DeploymentID string `json:"deploymentId"`
	Token        string `json:"token"`
	ServerURL    string `json:"serverUrl"`
}

// Pair redeems a one-time code and returns everything the agent needs.
//
// This is the one network call the install makes before touching the disk, and
// that ordering is the single most valuable thing the installer does for a
// non-technical person: a wrong address or a stale code is a sentence on screen
// with nothing changed, rather than a service that installs perfectly and never
// appears in rippel.
//
// A code is spent by the server whether or not what follows succeeds, so this
// is never retried automatically — a silent retry of a spent code produces a
// confusing second failure, and the honest answer is to ask for a new code.
func Pair(serverURL, code string) (Setup, error) {
	body, err := json.Marshal(map[string]string{"code": code})
	if err != nil {
		return Setup{}, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		serverURL+"/api/deployments/pair", bytes.NewReader(body))
	if err != nil {
		return Setup{}, err
	}
	req.Header.Set("content-type", "application/json")

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return Setup{}, fmt.Errorf(
			"Could not reach rippel.\n\n  %s\n\n"+
				"Check that this machine is on the same network as rippel, and that the "+
				"address you entered is right.",
			friendlyNetworkError(serverURL, err))
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 64*1024))

	if res.StatusCode < 200 || res.StatusCode > 299 {
		// rippel writes these messages for exactly this audience, so they are
		// shown as-is rather than replaced with a generic one.
		var failure struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		_ = json.Unmarshal(raw, &failure)
		if failure.Message != "" {
			return Setup{}, errors.New(failure.Message)
		}
		if res.StatusCode == http.StatusNotFound {
			return Setup{}, fmt.Errorf(
				"There is no rippel at %s — something answered, but it was not rippel.\n\n"+
					"Check the address you entered.", serverURL)
		}
		return Setup{}, fmt.Errorf("rippel answered %d: %s",
			res.StatusCode, strings.TrimSpace(string(raw)))
	}

	var payload pairResponse
	if err := json.Unmarshal(raw, &payload); err != nil {
		return Setup{}, fmt.Errorf(
			"rippel's answer could not be understood. Is %s really a rippel?", serverURL)
	}
	if payload.Token == "" || payload.DeploymentID == "" {
		return Setup{}, fmt.Errorf(
			"rippel accepted the code but did not send this machine's credentials. " +
				"Try again, or ask for a new code.")
	}

	// rippel knows which address actually reached it; prefer that over what was
	// typed, so an agent set up via one name checks in to the one that works.
	stored := payload.ServerURL
	if stored == "" {
		stored = serverURL
	}
	return Setup{
		ServerURL:    strings.TrimRight(stored, "/"),
		Token:        payload.Token,
		DeploymentID: payload.DeploymentID,
	}, nil
}
