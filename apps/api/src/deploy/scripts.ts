/**
 * The install scripts, for a machine nobody is sitting at.
 *
 * These are a bootstrap and nothing more: download one file, make it
 * executable, run it with a server address and a pairing code. Everything a
 * person can go wrong on lives inside the agent, which is a compiled program
 * that can answer in sentences rather than in shell errors.
 *
 * Two things changed when pairing replaced the per-deployment binary, and both
 * make these scripts safer to hand around:
 *
 *  - The download URL is generic. It carries no deployment and no token, so the
 *    same line works for every machine and a leaked script leaks nothing.
 *  - What authorises the enrolment is a one-time code with a lifetime of
 *    minutes, passed to the agent as an argument. A script that is pasted into
 *    the wrong window, or ends up in a shell history, is worth nothing an hour
 *    later — which was never true of the deployment token these used to carry.
 *
 * They exist at all because a headless box cannot click a download link. Anyone
 * with a screen downloads the agent and opens it, and it asks them two questions.
 */

import type { AgentPlatform } from '@comfy/shared';
import { binaryDownloadPath, defaultBinaryFor } from './binaries.js';

export interface ScriptParams {
  /** Where the agent fetches itself and checks in, e.g. http://192.168.1.9:4000 */
  serverUrl: string;
  /** A one-time pairing code, already issued for the deployment being set up. */
  code: string;
  /** Port the agent will run ComfyUI on, when it is not the default. */
  comfyPort?: number;
}

/** Single-quote a value for POSIX sh. */
function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Single-quote a value for PowerShell. */
function ps(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The URL a script downloads the binary from — generic, unauthenticated. */
export function downloadUrl(serverUrl: string, platform: AgentPlatform): string {
  return `${serverUrl.replace(/\/+$/, '')}${binaryDownloadPath(defaultBinaryFor(platform).target)}`;
}

/**
 * Linux and macOS.
 *
 * The one thing this still has to decide is which macOS binary: a Mac is
 * genuinely still split between Apple silicon and Intel, and `uname -m` is the
 * only thing that knows. Everything else is a download and a run.
 */
export function bashInstaller(p: ScriptParams): string {
  return `#!/usr/bin/env bash
# rippel agent installer.
#
# Downloads the rippel agent — one file, no runtime, nothing to unpack — and
# pairs this machine with rippel using a one-time code. The agent then installs
# itself into ~/.rippel-agent and registers a user service. Re-running this
# upgrades in place.
#
# It touches nothing outside ~/.rippel-agent and the user service directory,
# and it needs no root.
set -euo pipefail

SERVER=${sh(p.serverUrl.replace(/\/+$/, ''))}
CODE=${sh(p.code)}

say() { printf 'rippel: %s\\n' "$1"; }
die() { printf 'rippel: %s\\n' "$1" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required, and this machine has none."

# A Mac is still genuinely split between Apple silicon and Intel, and the
# download has to be told which. Everything else we ship is x86-64.
TARGET="linux-amd64"
if [ "$(uname -s)" = "Darwin" ]; then
  case "$(uname -m)" in
    arm64) TARGET="macos-arm64" ;;
    *)     TARGET="macos-amd64" ;;
  esac
fi

# A temporary file, not the current directory: this may be run from somewhere
# read-only, or somewhere the operator would rather we did not litter.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BINARY="$WORK/rippel-agent"

say "downloading the agent ($TARGET) from $SERVER"
curl -fsSL -o "$BINARY" "$SERVER/api/deployments/agent/$TARGET" \\
  || die "could not download the agent from $SERVER. Check the address, and that rippel is running."

chmod +x "$BINARY"

# The agent does the rest: it redeems the code with rippel before it writes
# anything, copies itself into place, writes its config and registers the
# service. Any failure from here on is its own, and it explains itself.
exec "$BINARY" install --server "$SERVER" --code "$CODE"
`;
}

/**
 * Windows.
 *
 * Only for a machine nobody is sitting at — a headless box, or the managed SSH
 * install. Anyone with a screen should download the exe from rippel and open
 * it: it asks for the address and the code, and needs no execution policy, no
 * PowerShell version and no pasted command.
 */
export function powershellInstaller(p: ScriptParams): string {
  return `#requires -version 5
<#
  rippel agent installer.

  Downloads the rippel agent — one file, no runtime, nothing to unzip — and
  pairs this machine with rippel using a one-time code. The agent then installs
  itself into %USERPROFILE%\\.rippel-agent and registers a per-user startup
  entry. Re-running upgrades in place. It needs no administrator.

  If you are sitting at this machine, you do not need this script: download the
  agent from rippel's Deployment screen and double-click it.
#>
$ErrorActionPreference = 'Stop'

$Server = ${ps(p.serverUrl.replace(/\/+$/, ''))}
$Code   = ${ps(p.code)}

function Say($m) { Write-Host "rippel: $m" }

# A temporary folder, not the current directory: this may be run from a share,
# or from somewhere the operator would rather we did not litter.
$Work   = Join-Path ([System.IO.Path]::GetTempPath()) ("rippel-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $Work | Out-Null
$Binary = Join-Path $Work 'rippel-agent.exe'

# Windows PowerShell 5 defaults to TLS 1.0, which nothing accepts any more. A
# rippel on plain http does not care, one behind https very much does.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

Say "downloading the agent from $Server"
try {
  Invoke-WebRequest -UseBasicParsing \`
    -Uri "$Server/api/deployments/agent/windows-amd64" \`
    -OutFile $Binary
} catch {
  throw "Could not download the agent from $Server. Check the address, and that rippel is running. ($($_.Exception.Message))"
}

# The agent does the rest: it redeems the code with rippel before it writes
# anything, copies itself into place, writes its config and registers its
# startup entry. Any failure from here on is its own, and it explains itself.
& $Binary install --server $Server --code $Code
$code = $LASTEXITCODE

Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
if ($code -ne 0) { throw "The agent's installer exited with code $code." }
`;
}

/**
 * The line an operator pastes into a shell on the target machine.
 *
 * The code goes on the command line rather than in the fetched URL, so the
 * script itself stays generic and the credential is visible to whoever is
 * pasting it — which is the person it was issued to.
 */
export function oneLiner(platform: AgentPlatform, p: ScriptParams): string {
  const server = p.serverUrl.replace(/\/+$/, '');
  if (platform === 'win32') {
    return (
      `powershell -ExecutionPolicy Bypass -Command "& { ` +
      `iwr -UseBasicParsing '${server}/api/deployments/agent/windows-amd64' ` +
      `-OutFile \\"$env:TEMP\\rippel-agent.exe\\"; ` +
      `& \\"$env:TEMP\\rippel-agent.exe\\" install --server '${server}' --code '${p.code}' }"`
    );
  }
  const target = platform === 'darwin' ? 'macos-arm64' : 'linux-amd64';
  return (
    `curl -fsSL -o /tmp/rippel-agent '${server}/api/deployments/agent/${target}' && ` +
    `chmod +x /tmp/rippel-agent && ` +
    `/tmp/rippel-agent install --server '${server}' --code '${p.code}'`
  );
}

export function installerFor(
  platform: AgentPlatform,
  p: ScriptParams,
): { body: string; contentType: string } {
  return platform === 'win32'
    ? { body: powershellInstaller(p), contentType: 'text/plain; charset=utf-8' }
    : { body: bashInstaller(p), contentType: 'text/x-shellscript; charset=utf-8' };
}
