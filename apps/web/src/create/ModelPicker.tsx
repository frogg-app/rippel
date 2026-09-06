/**
 * The model tiles.
 *
 * The artboard draws three 70px tiles across the panel with the name over a
 * bottom scrim, the selected one ringed in accent. Real installs have more than
 * three, so this is a wrapping grid of the same tile at the same height.
 *
 * The part that matters more than the look: a model whose *family* has no
 * workflow template for the capability we are about to ask for cannot be
 * generated with. `POST /jobs` answers that with a 501 `no_template`, and
 * finding out by pressing Generate is a bad way to learn it.
 *
 * How that is *said* is the rest of the job here. The first version dimmed the
 * blocked tiles, badged them "No template" and put a count underneath, which
 * read — in the user's own words — as "I can't change models". On this box two
 * of the three checkpoints are video models, so for an image job the count was
 * "2 checkpoints have no workflow template", which is true, useless, and hides
 * the one fact that would help: those two are *video* models and there is a
 * mode toggle at the top of the window that makes them work. So every blocked
 * tile now carries its own reason, and the note under the grid offers the fix
 * when there is one.
 *
 * Blocked tiles use `aria-disabled` rather than `disabled`, deliberately. A
 * `disabled` button takes no focus, fires no events and shows no `title`
 * tooltip, so the explanation for why you cannot pick it is unreachable by
 * exactly the person asking. These take the click and answer it.
 */
import { useState } from 'react';
import type { JobKind, Model } from '@comfy/shared';
import { type CapabilityMap, isFallbackFamily, modelKinds, modelSupported } from '../lib/api-jobs';
import { WarningIcon } from './icons';
import type { CreateMode } from './mode';
import { modeOfKind } from './form';
import styles from './modelPicker.module.css';

export function ModelPicker({
  models,
  kind,
  capabilities,
  loading,
  error,
  value,
  onChange,
  onModeChange,
}: {
  models: Model[];
  /** The capability that will actually be submitted — see `effectiveKind`. */
  kind: JobKind;
  capabilities: CapabilityMap;
  loading: boolean;
  error: string | null;
  value: string | null;
  onChange: (modelId: string) => void;
  /**
   * Switch the Image/Video toggle. Given so the picker can *offer* the fix
   * ("these are video models") instead of only naming the problem.
   */
  onModeChange?: (mode: CreateMode) => void;
}) {
  // Which blocked tile the user last pressed. A click on a model you cannot
  // use has to answer, or the tile is the silent wall the report describes.
  const [explainedId, setExplainedId] = useState<string | null>(null);

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

  const mode = modeOfKind(kind);
  const otherMode: CreateMode = mode === 'image' ? 'video' : 'image';
  const runnable = models.filter((model) => modelSupported(model, kind, capabilities));

  // What could be run if the toggle were flipped — the sentence worth saying
  // when nothing here works.
  const otherModeModels = models.filter((model) =>
    modelKinds(model, capabilities).some((candidate) => modeOfKind(candidate) === otherMode),
  );

  const explained = models.find((model) => model.id === explainedId) ?? null;
  const explainedReason =
    explained && !modelSupported(explained, kind, capabilities)
      ? blockedReason(explained, kind, capabilities)
      : null;

  return (
    <>
      <div className={styles.grid} role="radiogroup" aria-label="Model">
        {models.map((model) => {
          const supported = modelSupported(model, kind, capabilities);
          const selected = model.id === value;
          const reason = supported ? null : blockedReason(model, kind, capabilities);
          const generic = supported && isFallbackFamily(model, capabilities);

          return (
            <button
              key={model.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-disabled={!supported}
              title={
                reason
                  ? `${model.displayName}: ${reason.detail}`
                  : generic
                    ? `${model.displayName} · ${model.baseModel ?? 'unknown family'} · generic workflow`
                    : `${model.displayName} · ${model.baseModel ?? 'unknown family'}`
              }
              className={[
                styles.tile,
                selected ? styles.tileOn : '',
                supported ? '' : styles.tileBlocked,
                explainedId === model.id ? styles.tileExplained : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={tileArt(model)}
              onClick={() => {
                if (supported) {
                  setExplainedId(null);
                  onChange(model.id);
                } else {
                  // Not selectable, but not silent either.
                  setExplainedId(model.id);
                }
              }}
            >
              {model.previewUrl ? (
                <img className={styles.art} src={model.previewUrl} alt="" loading="lazy" />
              ) : null}
              <span className={styles.name}>{model.displayName}</span>
              {reason ? <span className={styles.badge}>{reason.badge}</span> : null}
              {/* A generic template will probably work and may look wrong; say
                  so quietly rather than either hiding it or blocking it. */}
              {generic ? <span className={styles.badgeSoft}>generic</span> : null}
            </button>
          );
        })}
      </div>

      {/* The tile the user just pressed, answered in full. */}
      {explainedReason ? (
        <p className={styles.note} role="status">
          <WarningIcon size={12} className={styles.noteIcon} />
          <span>
            <strong className={styles.noteStrong}>{explained?.displayName}</strong>{' '}
            {explainedReason.detail}
            {explainedReason.switchTo && onModeChange ? (
              <>
                {' '}
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => {
                    onModeChange(explainedReason.switchTo!);
                    setExplainedId(null);
                  }}
                >
                  Switch to {explainedReason.switchTo === 'video' ? 'Video' : 'Image'} mode
                </button>
              </>
            ) : null}
          </span>
        </p>
      ) : runnable.length === 0 ? (
        <p className={styles.note}>
          <WarningIcon size={12} className={styles.noteIcon} />
          <span>
            {otherModeModels.length > 0 ? (
              <>
                No installed checkpoint can run {KIND_NOUN[mode]} jobs.{' '}
                {listNames(otherModeModels)} {otherModeModels.length === 1 ? 'is' : 'are'}{' '}
                {KIND_NOUN[otherMode]} {otherModeModels.length === 1 ? 'model' : 'models'}.
                {onModeChange ? (
                  <>
                    {' '}
                    <button
                      type="button"
                      className={styles.link}
                      onClick={() => onModeChange(otherMode)}
                    >
                      Switch to {otherMode === 'video' ? 'Video' : 'Image'} mode
                    </button>
                  </>
                ) : null}
              </>
            ) : (
              <>
                None of the installed checkpoints have a workflow template for this kind of job
                yet. Templates are added per model family.
              </>
            )}
          </span>
        </p>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- reasons

const KIND_NOUN: Record<CreateMode, string> = { image: 'image', video: 'video' };

interface BlockedReason {
  /** Two words, on the tile. */
  badge: string;
  /** The sentence, in the note and the tooltip. */
  detail: string;
  /** The mode that *would* run this model, when there is one. */
  switchTo: CreateMode | null;
}

/**
 * Why this model cannot run this job — the specific answer, not the count.
 *
 * Three genuinely different situations hide behind one dimmed tile: the model
 * is for the other mode (fixable, one click), the model needs a starting image
 * (fixable, drop one in), or nobody has written a workflow for its family
 * (not fixable by the user, and worth saying plainly rather than implying they
 * did something wrong).
 */
export function blockedReason(
  model: Model,
  kind: JobKind,
  capabilities: CapabilityMap,
): BlockedReason {
  const kinds = modelKinds(model, capabilities);
  const family = model.baseModel ?? 'this family';
  const mode = modeOfKind(kind);

  if (kinds.length === 0) {
    return {
      badge: 'No template',
      detail: `has no workflow template yet — nothing here knows how to build a graph for ${family}.`,
      switchTo: null,
    };
  }

  const modes = new Set(kinds.map(modeOfKind));
  if (!modes.has(mode) && modes.size === 1) {
    const only = [...modes][0]!;
    return {
      badge: only === 'video' ? 'Video model' : 'Image model',
      detail: `is a ${KIND_NOUN[only]} model — it runs ${KIND_NOUN[only]} jobs, not ${KIND_NOUN[mode]} ones.`,
      switchTo: only,
    };
  }

  // Same mode, wrong variant: the family has a template, but for the other
  // side of the txt2*/img2* split.
  const needsInit = kinds.some((candidate) => candidate.startsWith('img2'));
  return needsInit
    ? {
        badge: 'Needs an image',
        detail: 'only runs from a starting image. Add one above and it becomes selectable.',
        switchTo: null,
      }
    : {
        badge: 'No template',
        detail: `has no workflow template for this kind of job yet (${family}).`,
        switchTo: null,
      };
}

/** "Hunyuan Video 720p and Ltx Video" — at most three, then "and 2 more". */
function listNames(models: Model[]): string {
  const names = models.slice(0, 2).map((model) => model.displayName);
  const rest = models.length - names.length;
  if (rest > 0) return `${names.join(', ')} and ${rest} more`;
  return names.length === 2 ? `${names[0]} and ${names[1]}` : (names[0] ?? '');
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
