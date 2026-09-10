/**
 * The install scripts, generated per deployment.
 *
 * These used to be two long programs — 250 lines of bash and PowerShell whose
 * entire job was to find or plant a Node.js runtime, download six `.mjs` files
 * one at a time, write a config file and register a service. All of that is now
 * inside the agent, which is one static binary: it copies itself, writes its
 * own config and registers its own service, and it does so identically however
 * it was started.
 *
 * So what is left here is a bootstrap, and it is deliberately short enough to
 * read in one breath: download one file, make it executable, run it with the
 * setup link. Two commands and a check. Everything a person can go wrong on has
 * moved into a compiled program that can give them a sentence instead of a
 * shell error.
 *
 * These exist at all because a headless box cannot click a download link — the
 * managed SSH install runs one of these, and so does an operator on a machine
 * with no desktop. On Windows with a screen, nobody should be pasting anything:
 * the download is a pre-named exe, and opening it is the whole install.
 */

import type { AgentPlatform } from '@comfy/shared';
import { defaultBinaryFor, setupLink } from './binaries.js';

export interface ScriptParams {
  /** Where the agent fetches itself and checks in, e.g. http://192.168.1.9:4000 */
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
 * The URL a script downloads the binary from.
 *
 * The token goes in the query string because the thing fetching this is `curl`
 * or `Invoke-WebRequest` inside a script that was itself fetched by a one-liner
 * — there is no header to spare and no cookie to send.
 */
export function downloadUrl(p: ScriptParams, platform: AgentPlatform): string {
  const binary = defaultBinaryFor(platform);
  return (
    `${p.serverUrl}/api/deployments/${p.deploymentId}/agent/${binary.target}` +
    `?token=${encodeURIComponent(p.token)}`
  );
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
# runs it. The agent then installs itself into ~/.rippel-agent and registers a
# user service. Re-running this upgrades in place.
#
# It touches nothing outside ~/.rippel-agent and the user service directory,
# and it needs no root.
set -euo pipefail

SERVER=${sh(p.serverUrl)}
DEPLOYMENT=${sh(p.deploymentId)}
TOKEN=${sh(p.token)}
SETUP_LINK=${sh(setupLink(p.serverUrl, p.token))}

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
curl -fsSL -o "$BINARY" \\
  "$SERVER/api/deployments/$DEPLOYMENT/agent/$TARGET?token=$TOKEN" \\
  || die "could not download the agent from $SERVER. Check the address, and that rippel is running."

chmod +x "$BINARY"

# The agent does the rest: it checks the token with rippel before it writes
# anything, copies itself into place, writes its config and registers the
# service. Any failure from here on is its own, and it explains itself.
exec "$BINARY" install "$SETUP_LINK"
`;
}

/**
 * Windows.
 *
 * Only for a machine nobody is sitting at — a headless box, or the managed SSH
 * install. Anyone with a screen should be downloading the exe from rippel and
 * opening it, which is one click and needs no execution policy, no PowerShell
 * version and no pasted command.
 */
export function powershellInstaller(p: ScriptParams): string {
  return `#requires -version 5
<#
  rippel agent installer.

  Downloads the rippel agent — one file, no runtime, nothing to unzip — and runs
  it. The agent then installs itself into %USERPROFILE%\\.rippel-agent and
  registers a scheduled task that starts it at logon. Re-running upgrades in
  place.

  If you are sitting at this machine, you do not need this script: download the
  agent from rippel's Deployment screen and double-click it.
#>
$ErrorActionPreference = 'Stop'

$Server     = ${ps(p.serverUrl)}
$Deployment = ${ps(p.deploymentId)}
$Token      = ${ps(p.token)}
$SetupLink  = ${ps(setupLink(p.serverUrl, p.token))}

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
    -Uri "$Server/api/deployments/$Deployment/agent/windows-amd64?token=$Token" \`
    -OutFile $Binary
} catch {
  throw "Could not download the agent from $Server. Check the address, and that rippel is running. ($($_.Exception.Message))"
}

# The agent does the rest: it checks the token with rippel before it writes
# anything, copies itself into place, writes its config and registers the
# scheduled task. Any failure from here on is its own, and it explains itself.
& $Binary install $SetupLink
$code = $LASTEXITCODE

Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
if ($code -ne 0) { throw "The agent's installer exited with code $code." }
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

export function installerFor(
  platform: AgentPlatform,
  p: ScriptParams,
): { body: string; contentType: string } {
  return platform === 'win32'
    ? { body: powershellInstaller(p), contentType: 'text/plain; charset=utf-8' }
    : { body: bashInstaller(p), contentType: 'text/x-shellscript; charset=utf-8' };
}
