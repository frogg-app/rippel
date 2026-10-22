// Downloads the newest successful Windows tray build (the `tray` workflow) into
// go/traybin/, where the agent embeds it. Run before `npm run build:release`.
//
//   node scripts/fetch-tray.mjs [branch] [--dry-run]   (default: the current branch)
//
// --dry-run names the run and artifact it would fetch and downloads nothing.
//
// The run is found through the REST API and filtered here. `gh run list` with
// --branch and --status together came back empty on gh 2.45 while plain
// listings showed successful runs, which stopped a release with "No
// successful tray build"; asking for the recent runs and picking the newest
// completed success ourselves does not depend on how gh combines filters.
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = 'frogg-app/rippel';
const artifact = 'rippel-tray-windows';
const dir = fileURLToPath(new URL('../go/traybin', import.meta.url));
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' }).trim();

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const branch =
  args.find((arg) => !arg.startsWith('--')) ??
  execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();

const { workflow_runs: runs } = JSON.parse(
  gh('api', `repos/${repo}/actions/workflows/tray.yml/runs?branch=${encodeURIComponent(branch)}&per_page=30`),
);
const run = runs.find((r) => r.status === 'completed' && r.conclusion === 'success');
if (!run) {
  console.error(`No successful tray build on ${branch} in the last ${runs.length} runs. Push apps/tray, or run the workflow by hand.`);
  process.exit(1);
}

const { artifacts } = JSON.parse(gh('api', `repos/${repo}/actions/runs/${run.id}/artifacts`));
const found = artifacts.find((a) => a.name === artifact);
if (!found || found.expired) {
  console.error(`Run ${run.id} (${run.head_sha.slice(0, 7)}) has no ${artifact} artifact${found ? ' (expired)' : ''}. Re-run the tray workflow.`);
  process.exit(1);
}

const label = `run ${run.id} (${run.head_sha.slice(0, 7)}, ${run.created_at})`;
if (dryRun) {
  console.log(`Would fetch ${artifact} (${found.size_in_bytes} bytes) from ${label}. Dry run: nothing downloaded.`);
  process.exit(0);
}

const exe = `${dir}/rippel-tray.exe`;
if (existsSync(exe)) rmSync(exe);
gh('run', 'download', String(run.id), '--repo', repo, '--name', artifact, '--dir', dir);
console.log(`Fetched rippel-tray.exe from ${label} into go/traybin/.`);
