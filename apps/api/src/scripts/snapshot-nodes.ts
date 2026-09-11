import { writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fetchSnapshot } from '../library/workflows/snapshot.js';

const [baseUrl, output] = process.argv.slice(2);
if (!baseUrl || !output) {
  process.stderr.write('Usage: npm run snapshot:nodes -w @comfy/api -- http://backend:8188 path/to/object-info.json\n');
  process.exitCode = 1;
} else {
  try {
    const info = await fetchSnapshot(baseUrl);
    const path = resolve(output);
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(info, null, 2) + '\n');
    await rename(temp, path);
    process.stdout.write(`Saved ${Object.keys(info).length} node specifications to ${path}\n`);
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : cause}\n`);
    process.exitCode = 1;
  }
}
