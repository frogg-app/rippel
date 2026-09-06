/**
 * The Create screen.
 *
 * PLAN.md §6 fixes the shape: a ~396px left panel holding *every* input with
 * Generate pinned to its bottom, and the right side given over to the running
 * job at full size. This module is the state that joins the two — the form
 * lives here, the job lives in `useJobStage`, and Remix is the one arrow
 * pointing back from the job to the form.
 *
 * Everything with a rule worth testing is somewhere else and pure:
 * `create/form.ts` (what we POST, and what the seed does), `create/jobProgress.ts`
 * (what a `JobEvent` does to the job on screen).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Job, Model } from '@comfy/shared';
import { SparkIcon } from '../components/icons';
import { Chips, Group, Segmented, Slider } from '../create/Controls';
import { AdvancedDrawer } from '../create/AdvancedDrawer';
import { JobStage } from '../create/JobStage';
import { ModelPicker } from '../create/ModelPicker';
import { PromptFields } from '../create/PromptFields';
import { ReferenceImage } from '../create/ReferenceImage';
import {
  ASPECT_RATIOS,
  type CreateFormState,
  deriveKind,
  effectiveKind,
  modeOfKind,
  MAX_BATCH,
  MIN_BATCH,
  QUALITY_LABELS,
  QUALITY_PRESETS,
  checkSubmittable,
  estimateSeconds,
  fromGenerationParams,
  initialFormState,
  prepareSubmit,
  toGenerationParams,
} from '../create/form';
import { useCreateMode } from '../create/mode';
import { useAdvancedOpen } from '../create/useAdvancedOpen';
import { useJobStage } from '../create/useJobStage';
import { useModels } from '../create/useModels';
import { modelSupported } from '../lib/api-jobs';
import { isTerminal } from '../create/jobProgress';
import styles from './CreatePage.module.css';

export function CreatePage() {
  const [form, setForm] = useState<CreateFormState>(initialFormState);
  const [advancedOpen, setAdvancedOpen] = useAdvancedOpen();
  const [mode, setMode] = useCreateMode();
  const { checkpoints, loras, capabilities, loading, error } = useModels();
  const stage = useJobStage();

  const patch = useCallback(
    (next: Partial<CreateFormState>) => setForm((prev) => ({ ...prev, ...next })),
    [],
  );

  // The Image/Video toggle lives in the shell's top bar and until now told
  // nobody: it highlighted itself while the form went on submitting txt2img.
  // The mode is the base kind; the img2* variant is derived from the starting
  // image at submit time (`effectiveKind`), so there is still exactly one
  // source of truth for the capability.
  useEffect(() => {
    setForm((prev) => {
      const base = deriveKind(mode, false);
      if (prev.kind === base) return prev;
      // The chosen model almost certainly cannot run the other mode; dropping
      // it lets the preselect below pick one that can, rather than leaving a
      // disabled Generate under a model the user did choose.
      return { ...prev, kind: base, modelId: null };
    });
  }, [mode]);

  // What we will actually POST, and therefore what everything on screen must
  // be judged against: the picker, the Generate button and `toGenerationParams`
  // all ask this same question.
  const kind = effectiveKind(form);

  // Preselect the first model we can actually generate with. A screen that
  // opens with nothing chosen makes the user do work the app could do, and
  // preselecting an *unrunnable* model would arm a disabled Generate for a
  // reason that is not the user's fault.
  useEffect(() => {
    if (form.modelId || checkpoints.length === 0) return;
    const first = checkpoints.find((model) => modelSupported(model, kind, capabilities));
    if (first) patch({ modelId: first.id });
  }, [checkpoints, capabilities, form.modelId, kind, patch]);

  const selectedModel: Model | null =
    checkpoints.find((model) => model.id === form.modelId) ?? null;

  const supported = selectedModel ? modelSupported(selectedModel, kind, capabilities) : false;

  const busy = Boolean(stage.job && !isTerminal(stage.job.status)) || stage.submitting;
  const submittable = useMemo(
    () => checkSubmittable(form, { modelSupported: supported, busy }),
    [form, supported, busy],
  );

  const generate = useCallback(() => {
    if (!submittable.ok) return;
    // The seed is settled *before* the request, so what the drawer shows is
    // what the sampler gets. `prepareSubmit` re-rolls it unless it is locked.
    const submitted = prepareSubmit(form);
    setForm(submitted);
    void stage.submit(toGenerationParams(submitted));
  }, [form, stage, submittable.ok]);

  const remix = useCallback(
    (job: Job) => {
      // A remixed video job has to bring the toggle with it, or the effect
      // above would immediately drag the form back to the current mode and
      // throw away the model that job used.
      setMode(modeOfKind(job.params.kind));
      setForm((prev) => fromGenerationParams(job.params, prev));
      // A remix always touches Advanced (it pins the seed), so open the drawer
      // rather than leaving the change invisible.
      setAdvancedOpen(true);
    },
    [setAdvancedOpen, setMode],
  );

  return (
    <div className={styles.workspace}>
      <section className={styles.panel} aria-label="Generation settings">
        <div className={styles.inputs}>
          <PromptFields
            prompt={form.prompt}
            negativePrompt={form.negativePrompt}
            negativeOpen={form.negativeOpen}
            onPromptChange={(prompt) => patch({ prompt })}
            onNegativeChange={(negativePrompt) => patch({ negativePrompt })}
            onNegativeOpenChange={(negativeOpen) => patch({ negativeOpen })}
            onSubmit={generate}
          />

          {/* Between the prompt and the model, as the artboard has it: what
              you are starting from is part of the request, not a setting. */}
          <ReferenceImage
            value={form.initImage}
            onChange={(initImage) => patch({ initImage })}
            disabled={stage.submitting}
          />

          <Group label="Model">
            <ModelPicker
              models={checkpoints}
              kind={kind}
              capabilities={capabilities}
              loading={loading}
              error={error}
              value={form.modelId}
              onChange={(modelId) => patch({ modelId })}
              onModeChange={setMode}
            />
          </Group>

          <Segmented
            label="Quality"
            value={form.quality}
            options={QUALITY_PRESETS.map((value) => ({ value, label: QUALITY_LABELS[value] }))}
            onChange={(quality) => patch({ quality })}
          />

          <Group label="Aspect ratio">
            <Chips
              label="Aspect ratio"
              value={form.aspect}
              options={ASPECT_RATIOS.map((value) => ({ value, label: value }))}
              onChange={(aspect) => patch({ aspect })}
            />
          </Group>

          <Group label="Images">
            <Slider
              label="Image count"
              accent
              min={MIN_BATCH}
              max={MAX_BATCH}
              value={form.batchSize}
              display={String(form.batchSize)}
              hint="Every image in a batch uses the same seed with a different offset."
              onChange={(batchSize) => patch({ batchSize })}
            />
          </Group>

          <AdvancedDrawer
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
            quality={form.quality}
            value={form.advanced}
            onChange={(advanced) => patch({ advanced })}
            loras={form.loras}
            loraModels={loras}
            onLorasChange={(next) => patch({ loras: next })}
          />
        </div>

        {/* Pinned: it must not scroll away, however long the Advanced drawer
            gets. The footer is a flex sibling of the scroll area, not a
            position:sticky child of it, so it never overlaps the last control. */}
        <footer className={styles.footer}>
          <button
            type="button"
            className={styles.generate}
            disabled={!submittable.ok}
            title={submittable.reason ?? undefined}
            onClick={generate}
          >
            <SparkIcon size={17} />
            {stage.submitting ? 'Starting…' : 'Generate'}
          </button>
          <div className={styles.estimate}>
            {submittable.reason ?? (
              <>
                {form.batchSize} {form.batchSize === 1 ? 'image' : 'images'} &middot; about{' '}
                {estimateSeconds(form)} seconds
              </>
            )}
          </div>
        </footer>
      </section>

      <JobStage
        job={stage.job}
        submitting={stage.submitting}
        submitError={stage.submitError}
        disconnected={stage.connection !== 'open'}
        onCancel={stage.cancel}
        onRemix={remix}
        onDismiss={stage.clear}
      />
    </div>
  );
}
