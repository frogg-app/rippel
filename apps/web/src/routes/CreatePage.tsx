import { SparkIcon } from '../components/icons';
import styles from './CreatePage.module.css';

/**
 * The Create screen — layout only.
 *
 * PLAN.md §6 fixes the shape: a ~396px left panel holding *every* input with
 * Generate pinned to its bottom, and the right side given over to the running
 * job at full size. The controls themselves (prompt, references, model tiles,
 * quality, the Advanced drawer) are a parallel workstream; what is here is the
 * frame they drop into, with the scroll behaviour and the pinned footer already
 * settled so nobody has to re-litigate them later.
 */
export function CreatePage() {
  return (
    <div className={styles.workspace}>
      <section className={styles.panel} aria-label="Generation settings">
        <div className={styles.inputs}>
          <ControlPlaceholder label="Prompt" height={96} note="Prompt and negative prompt" />
          <ControlPlaceholder label="Reference images" height={84} note="Drop a file or pick from your library" />
          <ControlPlaceholder label="Model" height={70} note="Installed checkpoints, as tiles" />
          <ControlPlaceholder label="Quality" height={44} note="Fast · Balanced · High" />
          <ControlPlaceholder label="Advanced" height={120} note="Steps, guidance, sampler, seed, LoRA" />
        </div>

        {/* Pinned: it must not scroll away, however long the Advanced drawer
            gets. The footer is a flex sibling of the scroll area, not a
            position:sticky child of it, so it never overlaps the last control. */}
        <footer className={styles.footer}>
          <button type="button" className={styles.generate} disabled>
            <SparkIcon size={17} />
            Generate
          </button>
          <div className={styles.estimate}>Controls arrive in the next workstream</div>
        </footer>
      </section>

      <section className={styles.stage} aria-label="Current job">
        <div className={styles.glow} aria-hidden />
        <div className={styles.stageInner}>
          <div className={styles.canvas}>
            <div className={styles.empty}>
              <SparkIcon size={22} />
              <p className={styles.emptyTitle}>Nothing running</p>
              <p className={styles.emptyBody}>
                The job you start appears here at full size, with live preview, a variation strip
                and per-result actions.
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * A labelled hole of the right size. Keeping the real heights means the panel's
 * scroll behaviour is exercised now rather than discovered when the controls
 * land.
 */
function ControlPlaceholder({
  label,
  height,
  note,
}: {
  label: string;
  height: number;
  note: string;
}) {
  return (
    <div className={styles.group}>
      <div className="label">{label}</div>
      <div className={styles.placeholder} style={{ minHeight: height }}>
        {note}
      </div>
    </div>
  );
}
