# Development server on this host

`https://dev.rippel.app` uses the existing Cloudflare tunnel, which forwards to
`http://192.168.1.9:5173`. Vite proxies `/api` to `http://127.0.0.1:4000`.

The API, web server, and tunnel run as `codex` user services:

```sh
systemctl --user status rippel-api rippel-web rippel-tunnel
systemctl --user restart rippel-api
journalctl --user -u rippel-api -n 50
curl --fail https://dev.rippel.app/api/health
```

The API loads TypeScript directly; restart its service after API changes.
Vite reloads web changes automatically. Units are installed in
`~/.config/systemd/user/`, use `Restart=always`, and are enabled. User lingering
is enabled so the services start at boot without an interactive login.
The existing `comfy-dev-pg` database container uses `unless-stopped` restart
policy. A reboot has not been performed as part of this verification.

The API environment and tunnel token are protected files under
`~/.cache/rippel/`, referenced by the service units. Do not commit or print
these credentials. This setup depends on those files remaining present.

Verification on 2026-09-12: public homepage returned HTTP 200, the public API
health check returned `{"ok":true}`, and Chromium rendered the sign-in page.
Those checks do not prove connectivity from every client network. If a user
still cannot reach the site, record the exact browser/Cloudflare error and
URL before changing DNS or tunnel routing.
