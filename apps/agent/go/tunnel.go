package main

// The agent initiates the only network connection. Multiplexed channels can
// reach just the local agent API and the active engine, never an arbitrary host or port.
import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type tunnelFrame struct {
	Type   string `json:"type"`
	ID     string `json:"id"`
	Target string `json:"target,omitempty"`
	Data   string `json:"data,omitempty"`
	Error  string `json:"error,omitempty"`
}
type tunnelChannel struct {
	conn  net.Conn
	input chan []byte
	ack   chan struct{}
	done  chan struct{}
	once  sync.Once
}

func (c *tunnelChannel) close() { c.once.Do(func() { close(c.done); _ = c.conn.Close() }) }
func tunnelAddress(server string) (string, error) {
	u, err := url.Parse(server)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("invalid rippel URL")
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		u.Scheme = "ws"
	default:
		return "", fmt.Errorf("rippel URL must use HTTP or HTTPS")
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/api/deployments/tunnel"
	return u.String(), nil
}
func StartTunnel(a *Agent, log func(string, ...any)) func() {
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		delay := time.Second
		for ctx.Err() == nil {
			cfg := a.config()
			if cfg.ServerURL == "" {
				return
			}
			address, err := tunnelAddress(cfg.ServerURL)
			if err != nil {
				log("tunnel: %s", err)
				return
			}
			dialer := websocket.Dialer{HandshakeTimeout: 15 * time.Second, Proxy: http.ProxyFromEnvironment}
			ws, response, err := dialer.DialContext(ctx, address, http.Header{"X-Rippel-Agent-Token": []string{cfg.Token}})
			if err == nil {
				delay = time.Second
				log("two-way connection established with rippel")
				runTunnel(ctx, ws, a.config)
				log("two-way connection closed; reconnecting")
			} else if response != nil && response.Body != nil {
				_ = response.Body.Close()
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(delay):
			}
			if delay < 30*time.Second {
				delay *= 2
			}
		}
	}()
	return cancel
}
func runTunnel(ctx context.Context, ws *websocket.Conn, config func() *Config) {
	defer ws.Close()
	ws.SetReadLimit(96 * 1024)
	var writeMu, channelsMu sync.Mutex
	channels := map[string]*tunnelChannel{}
	closed := make(chan struct{})
	defer close(closed)
	go func() {
		select {
		case <-ctx.Done():
			_ = ws.Close()
		case <-closed:
		}
	}()
	send := func(frame tunnelFrame) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = ws.SetWriteDeadline(time.Now().Add(30 * time.Second))
		return ws.WriteJSON(frame)
	}
	drop := func(id string) {
		channelsMu.Lock()
		ch := channels[id]
		delete(channels, id)
		channelsMu.Unlock()
		if ch != nil {
			ch.close()
		}
	}
	defer func() {
		channelsMu.Lock()
		defer channelsMu.Unlock()
		for _, ch := range channels {
			ch.close()
		}
	}()
	_ = ws.SetReadDeadline(time.Now().Add(60 * time.Second))
	ws.SetPingHandler(func(data string) error {
		_ = ws.SetReadDeadline(time.Now().Add(60 * time.Second))
		return ws.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(10*time.Second))
	})
	for {
		var frame tunnelFrame
		if err := ws.ReadJSON(&frame); err != nil {
			return
		}
		if frame.ID == "" || len(frame.ID) > 100 {
			return
		}
		channelsMu.Lock()
		ch := channels[frame.ID]
		count := len(channels)
		channelsMu.Unlock()
		switch frame.Type {
		case "open":
			if ch != nil || count >= 64 {
				_ = send(tunnelFrame{Type: "close", ID: frame.ID, Error: "Tunnel channel was refused"})
				continue
			}
			cfg := config()
			port := 0
			switch frame.Target {
			case "agent":
				port = cfg.Port
			case "engine":
				port = enginePort(cfg)
			default:
				_ = send(tunnelFrame{Type: "close", ID: frame.ID})
				continue
			}
			conn, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), 5*time.Second)
			if err != nil {
				_ = send(tunnelFrame{Type: "close", ID: frame.ID, Error: "Local connection failed: " + err.Error()})
				continue
			}
			ch = &tunnelChannel{conn: conn, input: make(chan []byte, 1), ack: make(chan struct{}, 1), done: make(chan struct{})}
			channelsMu.Lock()
			channels[frame.ID] = ch
			channelsMu.Unlock()
			if err = send(tunnelFrame{Type: "opened", ID: frame.ID}); err != nil {
				return
			}
			go func(id string, ch *tunnelChannel) {
				for {
					select {
					case <-ch.done:
						return
					case data := <-ch.input:
						_ = ch.conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
						if _, err := ch.conn.Write(data); err != nil {
							drop(id)
							_ = send(tunnelFrame{Type: "close", ID: id})
							return
						}
						if err := send(tunnelFrame{Type: "ack", ID: id}); err != nil {
							_ = ws.Close()
							return
						}
					}
				}
			}(frame.ID, ch)
			go func(id string, ch *tunnelChannel) {
				defer drop(id)
				buffer := make([]byte, 32*1024)
				for {
					n, err := ch.conn.Read(buffer)
					if n > 0 {
						if send(tunnelFrame{Type: "data", ID: id, Data: base64.StdEncoding.EncodeToString(buffer[:n])}) != nil {
							_ = ws.Close()
							return
						}
						select {
						case <-ch.ack:
						case <-ch.done:
							return
						case <-ctx.Done():
							return
						case <-time.After(120 * time.Second):
							_ = send(tunnelFrame{Type: "close", ID: id})
							return
						}
					}
					if err != nil {
						kind := "close"
						if err == io.EOF {
							kind = "end"
						}
						_ = send(tunnelFrame{Type: kind, ID: id})
						return
					}
				}
			}(frame.ID, ch)
		case "data":
			if ch == nil {
				continue
			}
			if len(frame.Data) > 48*1024 {
				return
			}
			data, err := base64.StdEncoding.DecodeString(frame.Data)
			if err != nil || len(data) > 32*1024 {
				return
			}
			select {
			case ch.input <- data:
			case <-ch.done:
			default:
				drop(frame.ID)
				_ = send(tunnelFrame{Type: "close", ID: frame.ID})
			}
		case "ack":
			if ch != nil {
				select {
				case ch.ack <- struct{}{}:
				default:
				}
			}
		case "end":
			if ch != nil {
				if tcp, ok := ch.conn.(*net.TCPConn); ok {
					_ = tcp.CloseWrite()
				}
			}
		case "close":
			drop(frame.ID)
		default:
			return
		}
	}
}
