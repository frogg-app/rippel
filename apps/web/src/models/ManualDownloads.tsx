/**
 * The files a person has to fetch by hand, laid out so they can.
 *
 * Until 2026-09-12 a "Needs another model" verdict came with an Install button,
 * because ComfyUI-Manager on the backend could do the fetching. Manager is gone
 * from the reference machine and nothing else can write to its disk, so the
 * honest remedy is a list — and a list is only useful if it answers all four
 * questions someone at that machine has: which file, which folder, how big, and
 * from where. Leave out the folder and a text encoder lands in `checkpoints/`,
 * which produces the very "Wrong folder" card this was meant to clear.
 *
 * The path is shown as `models/<folder>/<file>` because that is what gets typed
 * into a file manager, and a source that is a *different build* from the one the
 * verdict named (the fp8 T5 where the graph names fp16) says so, since a person
 * comparing filenames would otherwise think the link was wrong.
 */
import type { MissingCompanion } from '@comfy/shared';
import { formatBytes } from './catalogue';
import { LinkIcon } from './icons';
import styles from './ModelsPanels.module.css';

export function ManualDownloads({ missing }: { missing: readonly MissingCompanion[] }) {
  const known = missing.filter((m) => m.source);
  const unknown = missing.filter((m) => !m.source);
  if (missing.length === 0) return null;

  const total = known.reduce((sum, m) => sum + (m.source!.approxBytes ?? 0), 0);

  return (
    <div className={styles.downloads} aria-label="Files to download by hand">
      {known.length > 0 ? (
        <ul className={styles.downloadList}>
          {known.map((m) => {
            const source = m.source!;
            const substitute = source.filename.toLowerCase() !== basename(m.filename).toLowerCase();
            return (
              <li key={`${m.loader}:${m.filename}`} className={styles.downloadItem}>
                <span className={`mono ${styles.downloadPath}`}>
                  models/{source.folder}/{source.filename}
                </span>
                <span className={styles.downloadMeta}>
                  {m.purpose ? <span>{m.purpose}</span> : null}
                  {source.approxBytes ? <span>about {formatBytes(source.approxBytes)}</span> : null}
                  <a className={styles.sourceLink} href={source.url} target="_blank" rel="noreferrer noopener">
                    Download <LinkIcon size={10} />
                  </a>
                </span>
                {substitute ? (
                  <span className={styles.downloadNote}>
                    Recommended instead of {basename(m.filename)}; the workflow accepts either.
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {unknown.length > 0 ? (
        <p className={styles.downloadNote}>
          rippel has no known source for {unknown.map((m) => basename(m.filename)).join(', ')}. It
          belongs in the folder the {unknown.map((m) => m.loader).join(' / ')} loader reads.
        </p>
      ) : null}
      {known.length > 1 && total > 0 ? (
        <p className={styles.downloadNote}>About {formatBytes(total)} in all.</p>
      ) : null}
    </div>
  );
}

function basename(filename: string): string {
  return filename.split(/[\\/]/).pop() ?? filename;
}
