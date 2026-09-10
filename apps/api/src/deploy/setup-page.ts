/**
 * The page behind a setup link.
 *
 * This is the whole non-technical install path, and it is one page on purpose.
 * An operator copies one link out of rippel and sends it to whoever is sitting
 * at the GPU machine — by chat, by email, written on a sticky note. That person
 * opens it, clicks the button for their computer, and opens the file that
 * downloads. There is no terminal, no unzipping, no pasted command, and nothing
 * to type: the download is named after this deployment's own setup code, so the
 * agent reads its credentials off its own filename.
 *
 * It is deliberately hand-written HTML with no build step and no assets. This
 * page has to render on a machine that has nothing installed yet, possibly on a
 * LAN with no route to the internet, and possibly in whatever browser shipped
 * with Windows — so it is one file, inline styles, no scripts, no fonts.
 *
 * It also has to be safe to hand around: the token is in the URL, so opening
 * the page is already proof of holding it, and the page says plainly what that
 * token permits.
 */

import type { AgentBinary } from './binaries.js';
import { downloadFileName, type SetupDetails } from './binaries.js';

/** HTML-escape. Everything interpolated below goes through this. */
function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function bytes(size: number): string {
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export interface SetupPageInput {
  deploymentName: string;
  deploymentId: string;
  serverUrl: string;
  token: string;
  setup: SetupDetails;
  /** Only the binaries this rippel actually has on disk. */
  available: (AgentBinary & { sizeBytes: number })[];
}

/**
 * One download button per binary that exists.
 *
 * The href carries the token because this page was reached with it; the
 * `download` attribute carries the setup-bearing filename, so the browser saves
 * it under the name the agent knows how to read even if a proxy rewrote the
 * Content-Disposition header on the way.
 */
function button(input: SetupPageInput, binary: AgentBinary & { sizeBytes: number }): string {
  const href =
    `/api/deployments/${encodeURIComponent(input.deploymentId)}/agent/${binary.target}` +
    `?token=${encodeURIComponent(input.token)}`;
  return `      <a class="download" href="${escape(href)}" download="${escape(
    downloadFileName(binary, input.setup),
  )}">
        <span class="what">Download for ${escape(binary.label)}</span>
        <span class="size">${escape(bytes(binary.sizeBytes))}</span>
      </a>`;
}

export function setupPage(input: SetupPageInput): string {
  const downloads = input.available.map((binary) => button(input, binary)).join('\n');

  // Nothing built means a rippel running from a checkout where nobody has run
  // the build yet. Saying so beats four dead links.
  const body = input.available.length
    ? `    <div class="downloads">
${downloads}
    </div>

    <ol>
      <li>Click the button for the kind of computer you are using.</li>
      <li>Open the file it downloads. On Windows, Microsoft Defender may ask
          whether you are sure — choose <b>More info</b>, then <b>Run anyway</b>.</li>
      <li>A window opens, sets this computer up, and tells you when it is done.
          You can close it afterwards.</li>
    </ol>

    <p class="quiet">There is nothing else to install. The file you download is
    the whole program, and it already knows which rippel it belongs to.</p>`
    : `    <p class="warn">This rippel has no agent downloads on disk yet.</p>
    <p class="quiet">Whoever runs this rippel needs to build them
    (<code>npm run build:release -w @comfy/agent</code>) or install a rippel
    release that carries them. Until then, use the install command on rippel's
    Deployment screen instead.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Set up ${escape(input.deploymentName)} — rippel</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 40px 20px;
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #faf4ed; color: #575279;
  }
  main { max-width: 34rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; color: #575279; }
  .machine { font-size: 1rem; color: #797593; margin: 0 0 2rem; }
  .downloads { display: flex; flex-direction: column; gap: .5rem; margin: 0 0 2rem; }
  .download {
    display: flex; justify-content: space-between; align-items: center; gap: 1rem;
    padding: .85rem 1.1rem; border-radius: 8px; text-decoration: none;
    background: #286983; color: #faf4ed; font-weight: 600;
  }
  .download:hover { background: #1f5468; }
  .download .size { font-weight: 400; opacity: .8; font-size: .875rem; }
  .download + .download { background: #f2e9e1; color: #575279; }
  .download + .download:hover { background: #ebdfd6; }
  ol { padding-left: 1.2rem; margin: 0 0 1.5rem; }
  li { margin-bottom: .5rem; }
  .quiet { color: #797593; font-size: .9rem; }
  .warn { color: #b4637a; font-weight: 600; }
  code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: .875em; }
  hr { border: 0; border-top: 1px solid #dfdad9; margin: 2rem 0 1.25rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #191724; color: #e0def4; }
    h1 { color: #e0def4; }
    .machine, .quiet { color: #908caa; }
    .download { background: #31748f; color: #e0def4; }
    .download:hover { background: #3e8ba8; }
    .download + .download { background: #26233a; color: #e0def4; }
    .download + .download:hover { background: #2f2b45; }
    .warn { color: #eb6f92; }
    hr { border-top-color: #26233a; }
  }
</style>
</head>
<body>
<main>
  <h1>Set up the rippel agent</h1>
  <p class="machine">on <b>${escape(input.deploymentName)}</b></p>

${body}

  <hr>
  <p class="quiet">
    This link is a password. Anyone who has it can install software on
    ${escape(input.deploymentName)}. Do not post it anywhere public — and if it
    gets out, remove this deployment in rippel and add it again.
  </p>
</main>
</body>
</html>
`;
}
