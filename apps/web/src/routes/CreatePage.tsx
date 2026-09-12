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
import type { Job, Model, VideoLimits } from '@comfy/shared';
import { SparkIcon } from '../components/icons';
import { Chips, Group, Segmented, Slider } from '../create/Controls';
import { AdvancedDrawer } from '../create/AdvancedDrawer';
import { LoraSection } from '../create/LoraSection';
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
  clampVideo,
  type VideoBounds,
  videoBoundsFor,
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
import { isRunnable, useReadiness } from '../create/useReadiness';
import { partitionModels } from '../create/visibility';
import { placeInQueue, refreshQueue, useQueue } from '../lib/api-queue';
import { isTerminal } from '../create/jobProgress';
import styles from './CreatePage.module.css';

/**
 * What the duration slider says under itself.
 *
 * The old hint was one sentence for every model — "about six seconds is the
 * most a 16 GB card decodes" — which was a guess about the card, not a fact
 * about the model, and it was wrong in the direction that mattered: Stable
 * Video Diffusion stops at 25 frames, so its ceiling is one second at 25 fps
 * and no amount of VRAM changes that. Now that the server sends the frame
 * budget, the hint can name the real reason the slider stops where it does.
 */
function videoHint(
  model: Model | null,
  limits: VideoLimits | null,
  bounds: VideoBounds,
): string {
  if (!limits) {
    return 'Longer clips cost more memory and time.';
  }
  const name = model?.displayName ?? 'This model';
  return (
    `${name} samples up to ${limits.frames.max} frames, which is ${bounds.lengthMax}s ` +
    `at this rate. Longer clips cost more memory and time.`
  );
}

export function CreatePage() {
  const [form, setForm] = useState<CreateFormState>(initialFormState);
  const [advancedOpen, setAdvancedOpen] = useAdvancedOpen();
  const [mode, setMode] = useCreateMode();
  const { checkpoints, loras, capabilities, loading, error } = useModels();
  const stage = useJobStage();
  // The queue is shared state (the top bar shows the same snapshot), so this is
  // a subscription, not a second fetch. Its only job here is to turn "queued"
  // into "3rd in line" — the difference between waiting and reloading.
  const queue = useQueue();
  const place = placeInQueue(queue, stage.job?.id ?? null);

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

  // Asked of the server, per model, for exactly this capability: it is the only
  // thing that can tell "no workflow exists" from "the workflow exists and this
  // machine is missing a file", which is the difference between a model worth
  // hiding and one worth explaining.
  const readiness = useReadiness(checkpoints, kind);

  // The same split the picker draws, computed here too so selection can never
  // land on a tile that is not on screen.
  const partition = useMemo(
    () => partitionModels(checkpoints, kind, capabilities, readiness),
    [checkpoints, kind, capabilities, readiness],
  );

  // Never leave a hidden model selected. Readiness arrives after the first
  // paint, so a model that was legitimately chosen a moment ago can become
  // one the grid no longer shows; dropping it hands the preselect below the
  // job of finding a replacement that is actually visible.
  useEffect(() => {
    if (!form.modelId) return;
    // Never on an unanswered probe. `visibility.ts` refuses to hide while a
    // verdict is pending; clearing the user's choice here would undo that and
    // reintroduce the swap it exists to prevent.
    if (partition.pending) return;
    if (!partition.listed.some((entry) => entry.model.id === form.modelId)) {
      patch({ modelId: null });
    }
  }, [partition, form.modelId, patch]);

  // Preselect the first model we can actually generate with. A screen that
  // opens with nothing chosen makes the user do work the app could do, and
  // preselecting an *unrunnable* model would arm a disabled Generate for a
  // reason that is not the user's fault.
  useEffect(() => {
    if (form.modelId || checkpoints.length === 0) return;
    // Same rule: preselecting on a guess means visibly swapping the model out
    // from under the user a moment later.
    if (partition.pending) return;
    const first = partition.runnable[0];
    if (first) patch({ modelId: first.model.id });
  }, [checkpoints, partition, form.modelId, patch]);

  const selectedModel: Model | null =
    checkpoints.find((model) => model.id === form.modelId) ?? null;

  const supported = selectedModel
    ? isRunnable(selectedModel, kind, capabilities, readiness)
    : false;

  // What *this* model can sample, as the server derived it from the template's
  // own constraints. Null until readiness answers, for an image capability, or
  // when the endpoint could not be reached — all three fall back to the widest
  // bounds, which is what this screen used before it asked.
  const videoLimits = selectedModel ? readiness.here[selectedModel.id]?.videoLimits ?? null : null;
  // Clamped during render rather than written back into form state: an effect
  // would leave one frame in which a rejected length is on screen and armed,
  // and a write-back would throw away the 6 seconds the user picked for LTX the
  // moment they glanced at SVD. `form.video` stays the user's intent; `video`
  // is what this model would run.
  const video = clampVideo(form.video, videoLimits);
  const videoBounds = videoBoundsFor(videoLimits, video.fps);

  const busy = Boolean(stage.job && !isTerminal(stage.job.status)) || stage.submitting;
  const submittable = useMemo(
    () => checkSubmittable(form, { modelSupported: supported, busy }),
    [form, supported, busy],
  );

  const generate = useCallback(() => {
    if (!submittable.ok) return;
    // The seed is settled *before* the request, so what the drawer shows is
    // what the sampler gets. `prepareSubmit` re-rolls it unless it is locked.
    const submitted = prepareSubmit({ ...form, video });
    setForm(submitted);
    void stage.submit(toGenerationParams(submitted)).then(() => {
      // Ask straight away rather than waiting out the poll: the job you just
      // started should appear in the line while your finger is still on the
      // button.
      refreshQueue();
    });
  }, [form, video, stage, submittable.ok]);

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
              readiness={readiness}
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

          {/* What the mode decides: a batch of stills, or one clip with a
              length and a rate. Keyed by mode so the block re-enters when the
              toggle flips, rather than one control silently becoming another. */}
          {mode === 'video' ? (
            <div key="video" className={styles.modeBlock}>
              <Group label="Video">
                <Slider
                  label="Duration"
                  accent
                  min={videoBounds.lengthMin}
                  max={videoBounds.lengthMax}
                  step={videoBounds.lengthStep}
                  value={video.lengthSeconds}
                  display={`${video.lengthSeconds}s`}
                  valueText={`${video.lengthSeconds} seconds`}
                  hint={videoHint(selectedModel, videoLimits, videoBounds)}
                  onChange={(lengthSeconds) => patch({ video: { ...video, lengthSeconds } })}
                />
                <Chips
                  label="Frame rate"
                  value={String(video.fps)}
                  options={videoBounds.fpsOptions.map((fps) => ({
                    value: String(fps),
                    label: `${fps} fps`,
                  }))}
                  onChange={(fps) => patch({ video: { ...video, fps: Number(fps) } })}
                />
              </Group>
            </div>
          ) : (
            <div key="image" className={styles.modeBlock}>
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
            </div>
          )}

          {/* Below the reference image, above Advanced: a creative choice on
              the same footing as the model, not a preset override. */}
          <LoraSection
            loras={form.loras}
            models={loras}
            checkpoint={checkpoints.find((model) => model.id === form.modelId) ?? null}
            onChange={(next) => patch({ loras: next })}
          />

          <AdvancedDrawer
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
            quality={form.quality}
            batchSize={form.batchSize}
            value={form.advanced}
            onChange={(advanced) => patch({ advanced })}
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
                {mode === 'video'
                  ? `${video.lengthSeconds}s clip`
                  : `${form.batchSize} ${form.batchSize === 1 ? 'image' : 'images'}`}{' '}
                &middot; about {estimateSeconds({ ...form, video })} seconds
              </>
            )}
          </div>
        </footer>
      </section>

      <JobStage
        job={stage.job}
        submitting={stage.submitting}
        submitError={stage.submitError}
        fit={stage.fit}
        disconnected={stage.connection !== 'open'}
        place={place}
        onCancel={stage.cancel}
        onRemix={remix}
        onDismiss={stage.clear}
      />
    </div>
  );
}
