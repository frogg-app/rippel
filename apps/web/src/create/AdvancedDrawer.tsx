/**
 * The Advanced drawer: steps, guidance, sampler, scheduler, seed and LoRAs.
 *
 * The governing rule (from `apps/api/src/workflows/presets.ts`): opening this
 * drawer must never change the result. So every control starts at the value the
 * chosen quality preset would have used, and a control the user has not touched
 * stays `null` in the form state and is *omitted* from the request — the server
 * then applies the preset itself. Touching one pins it; the reset arrow gives
 * it back to the preset.
 */
import type { LoraSelection, Model, QualityPreset } from '@comfy/shared';
import { ChevronDownIcon, PlusIcon } from '../components/icons';
import { IconButton, Row, Select, Slider } from './Controls';
import { CloseIcon, DiceIcon, LockIcon, RemixIcon, UnlockIcon } from './icons';
import {
  type AdvancedState,
  PRESET_DEFAULTS,
  SAMPLERS,
  SCHEDULERS,
  formatSeed,
  randomSeed,
} from './form';
import styles from './advanced.module.css';

export function AdvancedDrawer({
  open,
  onOpenChange,
  quality,
  value,
  onChange,
  loras,
  loraModels,
  onLorasChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  quality: QualityPreset;
  value: AdvancedState;
  onChange: (next: AdvancedState) => void;
  loras: LoraSelection[];
  loraModels: Model[];
  onLorasChange: (next: LoraSelection[]) => void;
}) {
  const preset = PRESET_DEFAULTS[quality];
  const set = <K extends keyof AdvancedState>(key: K, next: AdvancedState[K]) =>
    onChange({ ...value, [key]: next });

  return (
    <section className={styles.drawer}>
      <button
        type="button"
        className={open ? `${styles.head} ${styles.headOpen}` : styles.head}
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <span className={styles.title}>Advanced</span>
        <span className={styles.headRight}>
          {overrideCount(value) > 0 ? (
            <span className={`mono ${styles.overrides}`}>{overrideCount(value)} set</span>
          ) : null}
          <ChevronDownIcon
            size={15}
            className={open ? `${styles.chevron} ${styles.chevronOpen}` : styles.chevron}
          />
        </span>
      </button>

      {open ? (
        <div className={styles.body}>
          <Overridable
            overridden={value.steps !== null}
            onReset={() => set('steps', null)}
            label="Steps"
          >
            <Slider
              label="Steps"
              min={1}
              max={80}
              value={value.steps ?? preset.steps}
              display={value.steps === null ? `${preset.steps}` : String(value.steps)}
              onChange={(steps) => set('steps', steps)}
            />
          </Overridable>

          <Overridable
            overridden={value.guidance !== null}
            onReset={() => set('guidance', null)}
            label="Guidance"
          >
            <Slider
              label="Guidance"
              min={1}
              max={20}
              step={0.1}
              value={value.guidance ?? preset.guidance}
              display={(value.guidance ?? preset.guidance).toFixed(1)}
              onChange={(guidance) => set('guidance', Number(guidance.toFixed(1)))}
            />
          </Overridable>

          <Select
            label="Sampler"
            value={value.sampler ?? preset.sampler}
            options={SAMPLERS}
            onChange={(sampler) => set('sampler', sampler)}
          />

          <Select
            label="Scheduler"
            value={value.scheduler ?? preset.scheduler}
            options={SCHEDULERS}
            onChange={(scheduler) => set('scheduler', scheduler)}
          />

          <Row label="Seed">
            <span className={`mono ${styles.seed}`} data-testid="seed-value">
              {formatSeed(value.seed)}
            </span>
            <IconButton title="Randomise the seed" onClick={() => set('seed', randomSeed())}>
              <DiceIcon size={14} />
            </IconButton>
            <IconButton
              title={value.seedLocked ? 'Seed locked — reused next run' : 'Lock the seed to reuse it'}
              on={value.seedLocked}
              onClick={() => set('seedLocked', !value.seedLocked)}
            >
              {value.seedLocked ? <LockIcon size={13} /> : <UnlockIcon size={13} />}
            </IconButton>
          </Row>

          <LoraPicker loras={loras} models={loraModels} onChange={onLorasChange} />
        </div>
      ) : null}
    </section>
  );
}

/** How many knobs the user has pinned, shown on the closed header so an
 *  override is never invisible. The seed is excluded: it always has a value. */
function overrideCount(state: AdvancedState): number {
  return [state.steps, state.guidance, state.sampler, state.scheduler].filter(
    (entry) => entry !== null,
  ).length;
}

function Overridable({
  overridden,
  onReset,
  label,
  children,
}: {
  overridden: boolean;
  onReset: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.overridable}>
      {children}
      {overridden ? (
        <button
          type="button"
          className={styles.reset}
          onClick={onReset}
          title={`Back to the quality preset's ${label.toLowerCase()}`}
        >
          <RemixIcon size={11} /> preset
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- LoRAs

const DEFAULT_LORA_WEIGHT = 0.7;

function LoraPicker({
  loras,
  models,
  onChange,
}: {
  loras: LoraSelection[];
  models: Model[];
  onChange: (next: LoraSelection[]) => void;
}) {
  const chosen = new Set(loras.map((lora) => lora.modelId));
  const available = models.filter((model) => !chosen.has(model.id));

  return (
    <div className={styles.loras}>
      <div className={styles.row}>
        <span className={styles.rowLabel}>LoRA</span>
        {models.length === 0 ? (
          <span className={styles.none}>none installed</span>
        ) : (
          <div className={styles.addWrap}>
            {/* A select styled as the artboard's dashed "+" square: one control,
                one click, and the list is the installed LoRAs. */}
            <select
              className={styles.add}
              value=""
              aria-label="Add a LoRA"
              disabled={available.length === 0}
              onChange={(event) => {
                if (!event.target.value) return;
                onChange([...loras, { modelId: event.target.value, weight: DEFAULT_LORA_WEIGHT }]);
              }}
            >
              <option value="">Add…</option>
              {available.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName}
                </option>
              ))}
            </select>
            <PlusIcon size={12} className={styles.addIcon} />
          </div>
        )}
      </div>

      {loras.map((lora, index) => {
        const model = models.find((entry) => entry.id === lora.modelId);
        return (
          <div key={lora.modelId} className={styles.lora}>
            <div className={styles.loraHead}>
              <span className={styles.loraName}>{model?.displayName ?? lora.modelId}</span>
              <button
                type="button"
                className={styles.loraRemove}
                title={`Remove ${model?.displayName ?? 'this LoRA'}`}
                aria-label={`Remove ${model?.displayName ?? 'this LoRA'}`}
                onClick={() => onChange(loras.filter((_, i) => i !== index))}
              >
                <CloseIcon size={11} />
              </button>
            </div>
            <Slider
              label="Weight"
              accent
              min={-1}
              max={2}
              step={0.05}
              value={lora.weight}
              display={lora.weight.toFixed(2)}
              onChange={(weight) =>
                onChange(
                  loras.map((entry, i) =>
                    i === index ? { ...entry, weight: Number(weight.toFixed(2)) } : entry,
                  ),
                )
              }
            />
          </div>
        );
      })}
    </div>
  );
}
