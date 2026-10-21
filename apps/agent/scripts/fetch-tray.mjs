// Downloads the newest successful Windows tray build (the `tray` workflow) into
// go/traybin/, where the agent embeds it. Run before `npm run build:release`.
//
//   node scripts/fetch-tray.mjs [branch]     (default: the current branch)
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repo = 'frogg-app/rippel';
const dir = fileURLToPath(new URL('../go/traybin', import.meta.url));
const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' }).trim();

const branch = process.argv[2] ?? execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
const runs = JSON.parse(
  gh('run', 'list', '--repo', repo, '--workflow', 'tray.yml', '--branch', branch, '--status', 'success', '--limit', '1', '--json', 'databaseId,headSha'),
);
if (!runs.length) {
  console.error(`No successful tray build on ${branch}. Push apps/tray, or run the workflow by hand.`);
  process.exit(1);
}
const exe = `${dir}/rippel-tray.exe`;
if (existsSync(exe)) rmSync(exe);
gh('run', 'download', String(runs[0].databaseId), '--repo', repo, '--name', 'rippel-tray-windows', '--dir', dir);
console.log(`Fetched rippel-tray.exe from run ${runs[0].databaseId} (${runs[0].headSha.slice(0, 7)}) into go/traybin/.`);
