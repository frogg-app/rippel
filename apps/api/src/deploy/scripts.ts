/**
 * The install scripts, generated per deployment.
 *
 * They are generated rather than shipped static because everything that makes
 * an install specific — this rippel's address, this deployment's id, its token,
 * the port to listen on — would otherwise be four things an operator has to
 * type correctly into a config file on a machine they are probably SSH'd into.
 * Generated, the manual path is one line to paste, and it is the same line the
 * managed SSH install runs, so there is one install to keep working rather
 * than two.
 *
 * Both scripts are written to be read before they are run: no minification, no
 * `set -e` cleverness that hides which step failed, and every destructive act
 * confined to the agent's own directory.
 */

import type { AgentPlatform } from '@comfy/shared';

export interface ScriptParams {
  /** Where the agent fetches its files and checks in, e.g. http://192.168.1.9:4000 */
  serverUrl: string;
  deploymentId: string;
  token: string;
  agentPort: number;
  /** Port the agent will run ComfyUI on. */
  comfyPort: number;
}

/** Single-quote a value for POSIX sh. */
function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Single-quote a value for PowerShell. */
function ps(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Linux and macOS.
 *
 * A user-level service, not a system one: the agent needs no privilege it does
 * not already have as the user who will own the ComfyUI checkout, and asking
 * for root to run a GPU process as root is how a checkout ends up unwritable by
 * the person maintaining it. systemd gets a --user unit with linger enabled so
 * it survives logout; macOS gets a LaunchAgent; anything else is told plainly
 * that it is on its own for supervision and started in the foreground.
 */
export function bashInstaller(p: ScriptParams): string {
  return `#!/usr/bin/env bash
# rippel agent installer.
#
# Installs the rippel agent into ~/.rippel-agent and starts it as a user
# service. Re-running it upgrades in place: the agent files are replaced, the
# config is kept, the service is restarted.
#
# It touches nothing outside ~/.rippel-agent and the user service directory.
set -euo pipefail

SERVER=${sh(p.serverUrl)}
TOKEN=${sh(p.token)}
DEPLOYMENT=${sh(p.deploymentId)}
AGENT_PORT=${sh(String(p.agentPort))}
COMFY_PORT=${sh(String(p.comfyPort))}
HOME_DIR="\${RIPPEL_AGENT_HOME:-$HOME/.rippel-agent}"

say() { printf 'rippel: %s\\n' "$1"; }
die() { printf 'rippel: %s\\n' "$1" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required."
command -v node >/dev/null 2>&1 || die "Node.js 20 or newer is required. Install it, then re-run this."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20 or newer is required; this machine has $(node -v)."

# git and python are what ComfyUI itself needs. The agent can install without
# them, but the first ComfyUI install would fail, so say so now rather than
# after a download.
for tool in git python3; do
  command -v "$tool" >/dev/null 2>&1 || say "warning: $tool is not installed. Installing ComfyUI will need it."
done

# Debian and Ubuntu ship python3 without ensurepip, so \`python3 -m venv\` fails
# after the ComfyUI clone has already been downloaded. Cheaper to say now.
if command -v python3 >/dev/null 2>&1 && ! python3 -c 'import ensurepip' >/dev/null 2>&1; then
  say "warning: python3 has no ensurepip, so ComfyUI's virtual environment will fail to build."
  say "         on Debian or Ubuntu: sudo apt install python3-venv"
fi

say "installing into $HOME_DIR"
mkdir -p "$HOME_DIR/src"

fetch() {
  curl -fsSL -H "X-Rippel-Agent-Token: $TOKEN" "$1"
}

say "fetching the agent from $SERVER"
MANIFEST="$(fetch "$SERVER/api/deployments/agent/manifest")" || die "could not reach $SERVER. Check the address and that rippel is running."
[ -n "$MANIFEST" ] || die "the server sent an empty file list."

while IFS= read -r name; do
  [ -n "$name" ] || continue
  fetch "$SERVER/api/deployments/agent/file/$name" > "$HOME_DIR/src/$name" \\
    || die "could not download $name."
  say "  $name"
done <<< "$MANIFEST"

# The config carries the token, so it is written before anything can read the
# directory and with a mode that keeps it to this user.
umask 077
cat > "$HOME_DIR/config.json" <<JSON
{
  "token": "$TOKEN",
  "serverUrl": "$SERVER",
  "deploymentId": "$DEPLOYMENT",
  "port": $AGENT_PORT,
  "comfyPort": $COMFY_PORT,
  "comfyPath": "$HOME_DIR/ComfyUI"
}
JSON
chmod 600 "$HOME_DIR/config.json"
umask 022

UNAME="$(uname -s)"

if [ "$UNAME" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/app.rippel.agent.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>app.rippel.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(command -v node)</string>
    <string>$HOME_DIR/src/main.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME_DIR/agent.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/agent.log</string>
</dict>
</plist>
PLISTEOF
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  launchctl load "$PLIST"
  say "started as a LaunchAgent. Logs: $HOME_DIR/agent.log"

elif command -v systemctl >/dev/null 2>&1; then
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/rippel-agent.service" <<UNIT
[Unit]
Description=rippel agent
After=network-online.target

[Service]
ExecStart=$(command -v node) $HOME_DIR/src/main.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable rippel-agent.service
  # restart, not \`enable --now\`: on a re-run the service is already enabled and
  # running, and --now would leave the old code in memory having just replaced
  # the files under it.
  systemctl --user restart rippel-agent.service
  # Without lingering the service stops when the SSH session ends, which for a
  # headless GPU box means the agent is only up while someone is logged in.
  loginctl enable-linger "$USER" >/dev/null 2>&1 \\
    || say "note: could not enable lingering; the agent will stop when you log out. Run: sudo loginctl enable-linger $USER"
  say "started as a systemd user service. Logs: journalctl --user -u rippel-agent -f"

else
  say "no systemd or launchd here, so nothing was installed as a service."
  say "start it yourself with: node $HOME_DIR/src/main.mjs"
fi

say "done. rippel should show this machine as online within a minute."
`;
}

/**
 * Windows.
 *
 * A Scheduled Task registered for the current user with a logon trigger, which
 * is the one supervision mechanism present on every Windows since 7 and needs
 * no service wrapper downloaded from anywhere. It is also the mechanism a
 * Windows administrator can see and stop without knowing anything about
 * rippel.
 */
export function powershellInstaller(p: ScriptParams): string {
  return `#requires -version 5
<#
  rippel agent installer.

  Installs the rippel agent into %USERPROFILE%\\.rippel-agent and registers a
  scheduled task that starts it at logon. Re-running upgrades in place.

  It touches nothing outside that folder and the scheduled task it creates.
#>
$ErrorActionPreference = 'Stop'

$Server     = ${ps(p.serverUrl)}
$Token      = ${ps(p.token)}
$Deployment = ${ps(p.deploymentId)}
$AgentPort  = ${p.agentPort}
$ComfyPort  = ${p.comfyPort}
$HomeDir    = if ($env:RIPPEL_AGENT_HOME) { $env:RIPPEL_AGENT_HOME } else { Join-Path $env:USERPROFILE '.rippel-agent' }

function Say($m) { Write-Host "rippel: $m" }

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 20 or newer is required. Install it from https://nodejs.org, then re-run this.' }
$major = [int](& node -p 'process.versions.node.split(".")[0]')
if ($major -lt 20) { throw "Node.js 20 or newer is required; this machine has $(& node -v)." }

foreach ($tool in 'git', 'python') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Say "warning: $tool is not installed. Installing ComfyUI will need it."
  }
}

Say "installing into $HomeDir"
New-Item -ItemType Directory -Force -Path (Join-Path $HomeDir 'src') | Out-Null

$headers = @{ 'X-Rippel-Agent-Token' = $Token }
Say "fetching the agent from $Server"
try {
  $manifest = (Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri "$Server/api/deployments/agent/manifest").Content
} catch {
  throw "Could not reach $Server. Check the address and that rippel is running. ($($_.Exception.Message))"
}

foreach ($name in ($manifest -split "\`n")) {
  $name = $name.Trim()
  if (-not $name) { continue }
  $target = Join-Path $HomeDir "src\\$name"
  Invoke-WebRequest -UseBasicParsing -Headers $headers -Uri "$Server/api/deployments/agent/file/$name" -OutFile $target
  Say "  $name"
}

$config = [ordered]@{
  token        = $Token
  serverUrl    = $Server
  deploymentId = $Deployment
  port         = $AgentPort
  comfyPort    = $ComfyPort
  comfyPath    = (Join-Path $HomeDir 'ComfyUI')
}
$configPath = Join-Path $HomeDir 'config.json'
# -Encoding utf8 on Windows PowerShell writes a BOM, which JSON.parse rejects.
[System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))

# The config holds the token: take the inherited ACL off and grant this user only.
$acl = Get-Acl $configPath
$acl.SetAccessRuleProtection($true, $false)
$acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) | Out-Null }
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
  "$env:USERDOMAIN\\$env:USERNAME", 'FullControl', 'Allow')))
Set-Acl -Path $configPath -AclObject $acl

$taskName = 'rippel-agent'
$action   = New-ScheduledTaskAction -Execute $node.Source -Argument "\`"$HomeDir\\src\\main.mjs\`""
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $taskName

Say "registered the scheduled task '$taskName' and started it."
Say 'done. rippel should show this machine as online within a minute.'
`;
}

/** The line an operator pastes into a shell on the target machine. */
export function oneLiner(platform: AgentPlatform, p: ScriptParams): string {
  const url = `${p.serverUrl}/api/deployments/${p.deploymentId}/install.${
    platform === 'win32' ? 'ps1' : 'sh'
  }?token=${encodeURIComponent(p.token)}`;
  if (platform === 'win32') {
    return `powershell -ExecutionPolicy Bypass -Command "irm '${url}' | iex"`;
  }
  return `curl -fsSL '${url}' | bash`;
}

export function installerFor(platform: AgentPlatform, p: ScriptParams): { body: string; contentType: string } {
  return platform === 'win32'
    ? { body: powershellInstaller(p), contentType: 'text/plain; charset=utf-8' }
    : { body: bashInstaller(p), contentType: 'text/x-shellscript; charset=utf-8' };
}
