/**
 * The model tiles.
 *
 * The artboard draws three 70px tiles across the panel with the name over a
 * bottom scrim, the selected one ringed in accent. Real installs have more than
 * three, so this is a wrapping grid of the same tile at the same height.
 *
 * The part that matters more than the look: a model whose *family* has no
 * workflow template cannot be generated with. `POST /jobs` answers that with a
 * 501 `no_template`, and finding out by pressing Generate is a bad way to learn
 * it. Those tiles are drawn dimmed, marked "No template", and are not
 * selectable — with the reason spelled out under the group rather than hidden
 * in a tooltip, because on this box two of the three installed checkpoints are
 * video models and the empty-handed state is the common one.
 */
import type { JobKind, Model } from '@comfy/shared';
import { type CapabilityMap, modelSupported } from '../lib/api-jobs';
import { WarningIcon } from './icons';
import styles from './modelPicker.module.css';

export function ModelPicker({
  models,
  kind,
  capabilities,
  loading,
  error,
  value,
  onChange,
}: {
  models: Model[];
  kind: JobKind;
  capabilities: CapabilityMap;
  loading: boolean;
  error: string | null;
  value: string | null;
  onChange: (modelId: string) => void;
}) {
  if (loading) {
    return (
      <div className={styles.grid} aria-busy>
        {[0, 1, 2].map((index) => (
          <div key={index} className={`${styles.tile} ${styles.skeleton}`} />
        ))}
      </div>
    );
  }

  if (error) {
    return <p className={styles.note}>{error}</p>;
  }

  if (models.length === 0) {
    return (
      <p className={styles.note}>
        No checkpoints discovered yet. The backend poller finds them
        automatically once a ComfyUI server with models on disk is online.
      </p>
    );
  }

  const blocked = models.filter((model) => !modelSupported(model, kind, capabilities)).length;

  return (
    <>
      <div className={styles.grid} role="radiogroup" aria-label="Model">
        {models.map((model) => {
          const supported = modelSupported(model, kind, capabilities);
          const selected = model.id === value;
          return (
            <button
              key={model.id}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={!supported}
              title={
                supported
                  ? `${model.displayName} · ${model.baseModel ?? 'unknown family'}`
                  : `${model.displayName}: no ${kind} template for ${model.baseModel ?? 'this family'} yet`
              }
              className={[
                styles.tile,
                selected ? styles.tileOn : '',
                supported ? '' : styles.tileBlocked,
              ]
                .filter(Boolean)
                .join(' ')}
              style={tileArt(model)}
              onClick={() => onChange(model.id)}
            >
              {model.previewUrl ? (
                <img className={styles.art} src={model.previewUrl} alt="" loading="lazy" />
              ) : null}
              <span className={styles.name}>{model.displayName}</span>
              {supported ? null : <span className={styles.badge}>No template</span>}
            </button>
          );
        })}
      </div>

      {blocked > 0 ? (
        <p className={styles.note}>
          <WarningIcon size={12} className={styles.noteIcon} />
          {blocked === models.length
            ? 'None of the installed checkpoints have a workflow template for this kind of job yet.'
            : `${blocked} ${blocked === 1 ? 'checkpoint has' : 'checkpoints have'} no workflow template for this kind of job yet.`}
        </p>
      ) : null}
    </>
  );
}

/**
 * A deterministic wash for a model with no preview image.
 *
 * Every discovered local model has `previewUrl: null` — nothing has downloaded
 * a Civitai card for it — so this is the *normal* case, not a fallback. The hue
 * is derived from the id so a given checkpoint keeps its colour between
 * sessions and becomes recognisable by it.
 */
function tileArt(model: Model): React.CSSProperties {
  let hash = 0;
  for (const char of model.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  return {
    background: `radial-gradient(120% 100% at 30% 20%, hsl(${hue} 85% 62%) 0%, hsl(${(hue + 40) % 360} 55% 32%) 55%, hsl(${(hue + 220) % 360} 45% 9%) 100%)`,
  };
}
