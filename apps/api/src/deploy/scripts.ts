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

# --- the runtime ------------------------------------------------------------
#
# The release archive carries an official Node build in node/, so a machine with
# no Node at all can still install. Preferred over a system Node because it is
# the version this agent was tested against; a system Node is the fallback for
# someone who cloned the repo or ran the one-liner outside the unpacked folder.
#
# Whichever wins, the binary ends up at $HOME_DIR/node/bin/node so the service
# unit points at a path that outlives the folder you unpacked into.

NODE_BIN=""
INSTALLED_NODE="$HOME_DIR/node/bin/node"

# With \`curl | bash\` there is no script on disk, so $0 is just "bash"; the
# unpacked folder is then the directory the operator ran the command from.
SCRIPT_DIR=""
case "$0" in
  */*) SCRIPT_DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || SCRIPT_DIR="" ;;
esac

ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) ARCH_SUFFIX="arm64" ;;
  x86_64|amd64)  ARCH_SUFFIX="x64" ;;
  *)             ARCH_SUFFIX="" ;;
esac

# A candidate is usable only if it actually runs: a macOS x64 binary on Apple
# silicon without Rosetta, or a bundle built for another libc, fails here rather
# than three steps later inside a service that will not start.
usable() {
  [ -n "$1" ] && [ -f "$1" ] || return 1
  # A tarball unpacked by something that dropped the mode, or a zip round trip,
  # leaves the binary non-executable. Fix it rather than reporting it missing.
  [ -x "$1" ] || chmod +x "$1" 2>/dev/null || return 1
  major="$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" || return 1
  [ -n "$major" ] && [ "$major" -ge 20 ] 2>/dev/null
}

for base in "\${RIPPEL_AGENT_BUNDLE:-}" "$INSTALLED_NODE" "$SCRIPT_DIR" "$PWD" "$HOME_DIR"; do
  [ -n "$base" ] || continue
  for candidate in \\
    "$base" \\
    "$base/node/bin/node" \\
    "$base/node/bin/node-$ARCH_SUFFIX" \\
    "$base/rippel-agent/node/bin/node" \\
    "$base/rippel-agent/node/bin/node-$ARCH_SUFFIX"
  do
    case "$candidate" in *"/node-") continue ;; esac
    if usable "$candidate"; then NODE_BIN="$candidate"; break 2; fi
  done
done

BUNDLED_NODE=""
if [ -n "$NODE_BIN" ]; then
  BUNDLED_NODE="$NODE_BIN"
  say "using the Node runtime bundled with this release ($("$NODE_BIN" -v))"
elif command -v node >/dev/null 2>&1 && usable "$(command -v node)"; then
  NODE_BIN="$(command -v node)"
  say "no bundled runtime here, using this machine's Node ($("$NODE_BIN" -v))"
else
  if command -v node >/dev/null 2>&1; then
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo '?')"
    die "Node.js 20 or newer is required; this machine has $(node -v) (major $NODE_MAJOR). Either upgrade it, or download the rippel agent release for this platform — it carries its own runtime — unpack it, and run this command from inside that folder."
  fi
  die "Node.js 20 or newer is required, and no bundled runtime was found. Download the rippel agent release for this platform — it carries its own runtime — unpack it, and re-run this command from inside that folder. Or install Node from https://nodejs.org and re-run this."
fi

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

# Keep the runtime next to the agent. The folder someone unpacked into is a
# Downloads directory they will delete; a service unit pointing into it would
# stop working the day they tidy up.
if [ -n "$BUNDLED_NODE" ] && [ "$BUNDLED_NODE" != "$INSTALLED_NODE" ]; then
  mkdir -p "$HOME_DIR/node/bin"
  cp -f "$BUNDLED_NODE" "$INSTALLED_NODE"
  chmod 755 "$INSTALLED_NODE"
  NODE_BIN="$INSTALLED_NODE"
  say "copied the runtime to $NODE_BIN"
fi

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
    <string>$NODE_BIN</string>
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
ExecStart=$NODE_BIN $HOME_DIR/src/main.mjs
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
  say "start it yourself with: \"$NODE_BIN\" $HOME_DIR/src/main.mjs"
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

# --- the runtime ------------------------------------------------------------
#
# The release zip carries node\\node.exe, an official Node build, so a Windows
# box with nothing but the Python that came with ComfyUI can still install. That
# is preferred over a system Node; a system Node is the fallback for someone who
# ran this one-liner outside the unpacked folder.
#
# Every path here is quoted at use: this lands in C:\\Users\\<name>\\... and a
# user folder with a space in it is the normal case, not the edge case.

$InstalledNode = Join-Path $HomeDir 'node\\node.exe'

function Test-NodeRuntime($path) {
  if (-not $path) { return $false }
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
  try {
    $reported = & "$path" -p 'process.versions.node.split(".")[0]' 2>$null
    return ([int]$reported -ge 20)
  } catch { return $false }
}

$bases = @()
if ($env:RIPPEL_AGENT_BUNDLE) { $bases += $env:RIPPEL_AGENT_BUNDLE }
$bases += $InstalledNode
if ($PSScriptRoot) { $bases += $PSScriptRoot }
$bases += (Get-Location).Path
$bases += $HomeDir

$nodeExe = $null
foreach ($base in $bases) {
  foreach ($rel in @('', 'node\\node.exe', 'rippel-agent\\node\\node.exe')) {
    $candidate = if ($rel) { Join-Path $base $rel } else { $base }
    if (Test-NodeRuntime $candidate) { $nodeExe = $candidate; break }
  }
  if ($nodeExe) { break }
}

$bundledNode = $null
if ($nodeExe) {
  $bundledNode = $nodeExe
  Say "using the Node runtime bundled with this release ($(& "$nodeExe" -v))"
} else {
  $system = Get-Command node -ErrorAction SilentlyContinue
  if ($system -and (Test-NodeRuntime $system.Source)) {
    $nodeExe = $system.Source
    Say "no bundled runtime here, using this machine's Node ($(& "$nodeExe" -v))"
  } elseif ($system) {
    throw "Node.js 20 or newer is required; this machine has $(& node -v). Either upgrade it, or download the rippel agent release for Windows — it carries its own runtime — unzip it, and run this command from inside that folder."
  } else {
    throw 'Node.js 20 or newer is required, and no bundled runtime was found next to this script. Download the rippel agent release for Windows — it carries its own runtime — unzip it, and re-run this command from inside that folder. Or install Node.js from https://nodejs.org, then re-run this.'
  }
}

foreach ($tool in 'git', 'python') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Say "warning: $tool is not installed. Installing ComfyUI will need it."
  }
}

Say "installing into $HomeDir"
New-Item -ItemType Directory -Force -Path (Join-Path $HomeDir 'src') | Out-Null

# Keep the runtime next to the agent: the folder this was unzipped into is a
# Downloads folder someone will delete, and a scheduled task pointing into it
# would stop working the day they tidy up.
if ($bundledNode -and ($bundledNode -ne $InstalledNode)) {
  New-Item -ItemType Directory -Force -Path (Join-Path $HomeDir 'node') | Out-Null
  Copy-Item -LiteralPath $bundledNode -Destination $InstalledNode -Force
  $nodeExe = $InstalledNode
  Say "copied the runtime to $nodeExe"
}

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
$action   = New-ScheduledTaskAction -Execute $nodeExe -Argument "\`"$HomeDir\\src\\main.mjs\`"" -WorkingDirectory $HomeDir
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
