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
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Job, Model } from '@comfy/shared';
import { SparkIcon } from '../components/icons';
import { Chips, Group, Hint, Segmented, Slider } from '../create/Controls';
import { VISIBILITIES, VISIBILITY_HINT, VISIBILITY_LABEL } from '../lib/sharing';
import { AdvancedDrawer } from '../create/AdvancedDrawer';
import { LoraSection } from '../create/LoraSection';
import { JobStage } from '../create/JobStage';
import { ModelPicker } from '../create/ModelPicker';
import { ModelNotice } from '../create/ModelNotice';
import { setupReason } from '../create/modelReasons';
import { invalidLoras } from '../create/loras';
import { familyWords } from '../create/families';
import { clearDraft, droppedSentence, flushDraft, loadDraft, reviseDraft, saveDraft } from '../create/draft';
import { AuthContext } from '../auth/context';
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
  fitVideoState,
  videoFrameBounds,
  videoFpsOptions,
  QUALITY_LABELS,
  QUALITY_PRESETS,
  checkSubmittable,
  clipLimitHint,
  clipSeconds,
  estimateSeconds,
  fromGenerationParams,
  initialFormState,
  prepareSubmit,
  toGenerationParams,
} from '../create/form';
import { useCreateMode } from '../create/mode';
import { useAdvancedOpen } from '../create/useAdvancedOpen';
import { useJobStage } from '../create/useJobStage';
import { useVideoLimits } from '../create/useVideoLimits';
import { useModels } from '../create/useModels';
import { isRunnable, useReadiness } from '../create/useReadiness';
import { partitionModels } from '../create/visibility';
import { placeInQueue, refreshQueue, useQueue } from '../lib/api-queue';
import { isTerminal } from '../create/jobProgress';
import { useTargetBackend } from '../shell/useTargetBackend';
import styles from './CreatePage.module.css';

export function CreatePage() {
  const targetBackendId = useTargetBackend();
  const userId = useContext(AuthContext)?.user?.id ?? null;
  // What was on this screen last time — this session, or the last visit.
  const [restored] = useState(() => loadDraft(userId));
  const [form, setForm] = useState<CreateFormState>(() => restored ?? initialFormState());
  const [draftNotice, setDraftNotice] = useState<string | null>(null);
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

  // Keep the form across routes and reloads; see `create/draft.ts`.
  useEffect(() => saveDraft(userId, form), [userId, form]);
  useEffect(() => {
    window.addEventListener('pagehide', flushDraft);
    return () => {
      window.removeEventListener('pagehide', flushDraft);
      flushDraft();
    };
  }, []);

  // A restored draft is checked once against what exists now: a model or
  // style add-on uninstalled since, or a starting image that no longer loads,
  // is dropped with a note rather than left to fail at Generate.
  const revised = useRef(false);
  useEffect(() => {
    if (revised.current || !restored || loading) return;
    revised.current = true;
    const { form: next, dropped } = reviseDraft(restored, { checkpoints, loras });
    if (dropped.length > 0) {
      setForm((prev) => ({ ...prev, modelId: next.modelId, loras: next.loras }));
      setDraftNotice(droppedSentence(dropped));
    }
    const image = restored.initImage;
    if (image) {
      void fetch(image.previewUrl, { method: 'HEAD', credentials: 'include' })
        .then((response) => response.ok)
        .catch(() => true) // offline is not "gone"
        .then((ok) => {
          if (ok) return;
          setForm((prev) => (prev.initImage?.previewUrl === image.previewUrl ? { ...prev, initImage: null } : prev));
          setDraftNotice('The starting image from your saved draft is no longer available, so it was removed.');
        });
    }
  }, [restored, loading, checkpoints, loras]);

  const startOver = useCallback(() => {
    clearDraft(userId);
    setForm(initialFormState());
    setDraftNotice(null);
  }, [userId]);
  const hasContent = Boolean(
    form.prompt || form.negativePrompt || form.initImage || form.loras.length > 0,
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
  const selectedAnswer = selectedModel ? readiness.here[selectedModel.id] : undefined;
  const waitingOn = supported ? null : setupReason(selectedAnswer);

  // Style add-ons follow the model. The workflow that would run says whether it
  // takes any at all; the family says which. Selections that stop fitting when
  // the model or mode changes are dropped here, with a sentence, rather than
  // left to fail at Generate.
  const takesLoras = selectedAnswer?.takesLoras ?? null;
  const familyLabel = selectedModel?.baseModel
    ? familyWords(selectedModel.baseModel).label
    : selectedModel?.displayName ?? 'this model';
  const [loraNotice, setLoraNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedModel || readiness.loading) return;
    const { keep, notice } = invalidLoras(form.loras, loras, selectedModel, takesLoras, familyLabel);
    if (notice) {
      patch({ loras: keep });
      setLoraNotice(notice);
    }
  }, [selectedModel, readiness.loading, takesLoras, familyLabel, form.loras, loras, patch]);

  const videoSettings = useVideoLimits(form.modelId, kind);
  const videoLimits = videoSettings.limits;
  const videoBounds = videoLimits ? videoFrameBounds(videoLimits) : null;
  const fittedVideo = videoLimits ? fitVideoState(form.video, videoLimits) : form.video;
  const videoSettled = fittedVideo.fps === form.video.fps &&
    fittedVideo.lengthSeconds === form.video.lengthSeconds;
  useEffect(() => {
    if (videoLimits && !videoSettled) patch({ video: fittedVideo });
  }, [videoLimits, videoSettled, fittedVideo.fps, fittedVideo.lengthSeconds, patch]);

  const busy = Boolean(stage.job && !isTerminal(stage.job.status)) || stage.submitting;
  const submittable = useMemo(
    () => {
      const basic = checkSubmittable(form, { modelSupported: supported, busy, setupReason: waitingOn });
      if (!basic.ok || modeOfKind(kind) !== 'video') return basic;
      return videoLimits && videoSettled ? basic : {
        ok: false, reason: videoSettings.error ?? 'Loading video settings…',
      };
    },
    [form, supported, busy, waitingOn, kind, videoLimits, videoSettled, videoSettings.error],
  );

  const generate = useCallback(() => {
    if (!submittable.ok) return;
    // The seed is settled *before* the request, so what the drawer shows is
    // what the sampler gets. `prepareSubmit` re-rolls it unless it is locked.
    const submitted = prepareSubmit(form);
    setForm(submitted);
    void stage.submit({ ...toGenerationParams(submitted), ...(targetBackendId ? { targetBackendId } : {}) }).then(() => {
      // Ask straight away rather than waiting out the poll: the job you just
      // started should appear in the line while your finger is still on the
      // button.
      refreshQueue();
    });
  }, [form, stage, submittable.ok, targetBackendId]);

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
          {draftNotice || hasContent ? (
            <div className={styles.draftBar}>
              {draftNotice ? (
                <span role="status" className={styles.draftNotice}>{draftNotice}</span>
              ) : (
                <span />
              )}
              {hasContent ? (
                <button type="button" className={styles.startOver} onClick={startOver}>
                  Start over
                </button>
              ) : null}
            </div>
          ) : null}
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
            {selectedModel && !supported ? (
              <ModelNotice model={selectedModel} kind={kind} answer={selectedAnswer} />
            ) : null}
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
            <Hint text="The shape of the picture — square, wide or tall. Its size in pixels follows from this and the quality you chose, at what the model was made for." />
          </Group>

          {/* What the mode decides: a batch of stills, or one clip with a
              length and a rate. Keyed by mode so the block re-enters when the
              toggle flips, rather than one control silently becoming another. */}
          {mode === 'video' ? (
            <div key="video" className={styles.modeBlock}>
              <Group label="Video">
                {videoLimits && videoBounds ? <>
                  <Slider
                    label="Duration"
                    accent
                    min={videoBounds.min}
                    max={videoBounds.max}
                    step={videoBounds.step}
                    value={Math.round(fittedVideo.lengthSeconds * fittedVideo.fps)}
                    display={`${Number(fittedVideo.lengthSeconds.toFixed(2))}s`}
                    valueText={`${Number(fittedVideo.lengthSeconds.toFixed(2))} seconds`}
                    ends={[clipSeconds(videoBounds.min, fittedVideo.fps), `up to ${clipSeconds(videoBounds.max, fittedVideo.fps)}`]}
                    hint={clipLimitHint(videoBounds.max, fittedVideo.fps, videoLimits.fps.min)}
                    onChange={(frames) => patch({ video: { ...fittedVideo, lengthSeconds: frames / fittedVideo.fps } })}
                  />
                  <Chips
                    label="Frame rate"
                    value={String(fittedVideo.fps)}
                    options={[...new Set([...videoFpsOptions(videoLimits), fittedVideo.fps])].sort((a, b) => a - b).map((fps) => ({ value: String(fps), label: `${fps} fps` }))}
                    onChange={(fps) => patch({ video: fitVideoState({ ...form.video, fps: Number(fps) }, videoLimits) })}
                  />
                </> : <p role="status">{videoSettings.error ?? (form.modelId ? 'Loading video settings…' : 'Select a model to load its video settings.')}
                  {videoSettings.error && <button type="button" onClick={videoSettings.retry}>Retry</button>}
                </p>}
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
            takesLoras={takesLoras}
            familyLabel={familyLabel}
            notice={loraNotice}
            onDismissNotice={() => setLoraNotice(null)}
            onChange={(next) => patch({ loras: next })}
          />

          {/* Who sees the result, chosen before it exists rather than after:
              a picture is never briefly visible to anyone it was not meant for. */}
          <Group label="Visibility">
            <Chips
              label="Visibility"
              value={form.visibility}
              options={VISIBILITIES.map((value) => ({ value, label: VISIBILITY_LABEL[value] }))}
              onChange={(visibility) => patch({ visibility })}
            />
            <Hint text={VISIBILITY_HINT[form.visibility]} />
          </Group>

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
                  ? `${form.video.lengthSeconds}s clip`
                  : `${form.batchSize} ${form.batchSize === 1 ? 'image' : 'images'}`}{' '}
                &middot; about {estimateSeconds(form)} seconds
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
        place={place}
        onCancel={stage.cancel}
        onRemix={remix}
        onDismiss={stage.clear}
      />
    </div>
  );
}
