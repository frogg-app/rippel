/**
 * The Workflows sheet.
 *
 * Two modes over one surface:
 *
 *  - **model** — for one installed model: every template that could serve it,
 *    each with the verdict it would get on the selected backend, which one the
 *    automatic rules pick, and (for an administrator) a radio per capability
 *    to pin one instead. "Use automatic" clears the pin. An administrator can
 *    also switch a capability off for the model; its options stay listed,
 *    dimmed, so what switching back on restores is visible. A verdict that
 *    names missing files lists them with folder, size and link, because there
 *    is no longer an install transport to press a button on.
 *  - **browse** — every template the registry ships, optionally narrowed to a
 *    family: label, capability, families, the folder the model loader reads,
 *    companions, and a fallback badge. Reached from the Installed panel's
 *    "Browse templates" and from a catalogue card.
 *
 * It is a portal to the body like the preview lightbox, for the same reason:
 * the card and row that open it are lifted on hover, and a transformed
 * ancestor would trap a fixed sheet inside it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { JobKind, Model, ModelWorkflows, Uuid, WorkflowTemplateSummary } from '@comfy/shared';
import { ApiRequestError } from '../lib/api';
import type { ModelsApi } from '../lib/api-models';
import {
  RUNNABILITY_LABEL,
  RUNNABILITY_TONE,
  SUPPORT_ROLES,
  TYPE_LABELS,
  familyLabel,
  foldFamily,
  generates,
} from './catalogue';
import { CloseIcon, WorkflowIcon } from './icons';
import { ManualDownloads } from './ManualDownloads';
import styles from './ModelsPanels.module.css';

export type WorkflowSheetSubject =
  | { mode: 'model'; model: Model }
  | { mode: 'browse'; family: string | null };

export interface WorkflowSheetProps {
  api: ModelsApi;
  subject: WorkflowSheetSubject;
  /** The backend the verdicts are measured on; null lets the API choose. */
  backendId: Uuid | null;
  isAdmin: boolean;
  onClose: () => void;
  /** Fired after a pin changes, so the list behind can refresh its verdicts. */
  onAssigned?: () => void;
}

const CAPABILITY_LABEL: Record<JobKind, string> = {
  txt2img: 'Text to image',
  img2img: 'Image to image',
  txt2vid: 'Text to video',
  img2vid: 'Image to video',
  upscale: 'Upscale',
};

const CAPABILITY_ORDER: JobKind[] = ['txt2img', 'img2img', 'txt2vid', 'img2vid', 'upscale'];

export function WorkflowSheet({ api, subject, backendId, isAdmin, onClose, onAssigned }: WorkflowSheetProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreTo = useRef<Element | null>(null);

  useEffect(() => {
    restoreTo.current = document.activeElement;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      if (restoreTo.current instanceof HTMLElement) restoreTo.current.focus();
    };
  }, [onClose]);

  const title =
    subject.mode === 'model'
      ? // A support file has no workflow of its own, so the sheet does not claim
        // to be offering one. It answers the question that is actually
        // answerable about a LoRA: what is it, and where does it get used.
        generates(subject.model.type)
        ? `Workflows for ${subject.model.displayName}`
        : `About ${subject.model.displayName}`
      : subject.family
        ? `Templates for ${familyLabel(foldFamily(subject.family))} models`
        : 'Workflow templates';

  return createPortal(
    <div className={styles.lightbox} onClick={onClose}>
      <div
        className={`${styles.sheet} pop`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.sheetHead}>
          <span className={styles.sheetTitle}>
            <WorkflowIcon size={15} />
            {title}
          </span>
          <button
            type="button"
            ref={closeRef}
            className={styles.sheetClose}
            onClick={onClose}
            aria-label="Close"
          >
            <CloseIcon size={15} />
          </button>
        </header>
        <div className={styles.sheetBody}>
          {subject.mode === 'model' && !generates(subject.model.type) ? (
            <SupportFile model={subject.model} />
          ) : subject.mode === 'model' ? (
            <ModelOptions
              api={api}
              model={subject.model}
              backendId={backendId}
              isAdmin={isAdmin}
              onAssigned={onAssigned}
            />
          ) : (
            <TemplateList api={api} family={subject.family} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// -------------------------------------------------------------- support mode

/**
 * A support file's panel: an explanation, and no choice.
 *
 * This replaces the bug the owner actually hit. The sheet used to render the
 * full radio list for a LoRA, accept the click, badge the template PINNED and
 * write the row — and then nothing happened, because a LoRA is never the thing
 * a workflow is selected *for*. The truth was on the screen the whole time, in
 * grey, underneath a control that contradicted it.
 *
 * So the control is gone. What is left is the answer to the question somebody
 * opening this actually has — what is this file, and where does it get used —
 * plus the one honest onward step: the workflows belong to the *checkpoint*,
 * which is where a pin would have any effect.
 */
function SupportFile({ model }: { model: Model }) {
  const role = SUPPORT_ROLES[model.type];
  return (
    <>
      <p className={styles.sheetLede}>
        <span className="mono">{model.filename}</span>
        {model.baseModel ? <> · for {familyLabel(model.baseModel)} models</> : null}
      </p>

      <section className={styles.sheetSection} aria-label={`What ${model.displayName} is for`}>
        <header className={styles.sheetSectionHead}>
          <h3 className={styles.sheetSectionTitle}>{role.noun}</h3>
          <span className={styles.sheetSectionNote}>{TYPE_LABELS[model.type]}</span>
        </header>
        <p className={styles.sheetOptionDesc}>{role.what}</p>
        <p className={styles.sheetOptionDesc}>{role.where}</p>
      </section>

      <p className={styles.sheetFoot}>
        There is no workflow to choose here. A workflow is picked for the model you generate
        with — a checkpoint — and this file is loaded by that workflow when it needs it. To pin a
        template, open the Workflows sheet on a checkpoint instead.
      </p>
    </>
  );
}

// ---------------------------------------------------------------- model mode

function ModelOptions({
  api,
  model,
  backendId,
  isAdmin,
  onAssigned,
}: {
  api: ModelsApi;
  model: Model;
  backendId: Uuid | null;
  isAdmin: boolean;
  onAssigned?: () => void;
}) {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: ModelWorkflows }
  >({ kind: 'loading' });
  const [busy, setBusy] = useState<JobKind | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const data = await api.modelWorkflows(model.id, backendId, signal);
        setState({ kind: 'ready', data });
      } catch (cause) {
        if (signal?.aborted) return;
        setState({
          kind: 'error',
          message:
            cause instanceof ApiRequestError ? cause.message : 'Could not read the workflows for this model.',
        });
      }
    },
    [api, model.id, backendId],
  );

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: 'loading' });
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function toggle(capability: JobKind, enabled: boolean) {
    setBusy(capability);
    setProblem(null);
    try {
      await api.switchCapability(model.id, capability, enabled);
      await load();
      onAssigned?.();
    } catch (cause) {
      setProblem(cause instanceof ApiRequestError ? cause.message : 'Could not switch that on or off.');
    } finally {
      setBusy(null);
    }
  }

  async function assign(capability: JobKind, templateId: string | null) {
    setBusy(capability);
    setProblem(null);
    try {
      await api.assignWorkflow(model.id, capability, templateId);
      await load();
      onAssigned?.();
    } catch (cause) {
      setProblem(cause instanceof ApiRequestError ? cause.message : 'Could not change the workflow.');
    } finally {
      setBusy(null);
    }
  }

  if (state.kind === 'loading') {
    return (
      <div className={styles.sheetLoading} role="status">
        <span className={`${styles.skeleton} ${styles.sheetSkeleton}`} />
        <span className={`${styles.skeleton} ${styles.sheetSkeleton}`} />
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <p className={styles.sheetProblem} role="alert">
        {state.message}
      </p>
    );
  }

  const { data } = state;
  const byCapability = new Map<JobKind, typeof data.options>();
  for (const option of data.options) {
    const list = byCapability.get(option.template.capability) ?? [];
    list.push(option);
    byCapability.set(option.template.capability, list);
  }
  const capabilities = CAPABILITY_ORDER.filter((capability) => byCapability.has(capability));

  return (
    <>
      <p className={styles.sheetLede}>
        <span className="mono">{model.filename}</span>
        {data.model.folder ? (
          <>
            {' '}
            is in <span className="mono">{data.model.folder}/</span>
          </>
        ) : null}
        {data.backend ? <> on {data.backend.name}</> : null}
        {data.model.family ? <> · {familyLabel(data.model.family)} family</> : <> · family unknown</>}
      </p>

      {capabilities.length === 0 ? (
        <p className={styles.sheetProblem}>
          No template is written for this family yet, so nothing here can generate with it.
        </p>
      ) : null}

      {problem ? (
        <p className={styles.sheetProblem} role="alert">
          {problem}
        </p>
      ) : null}

      {capabilities.map((capability) => {
        const options = byCapability.get(capability)!;
        const pinned = data.assigned[capability] ?? null;
        const off = (data.switchedOff ?? []).includes(capability);
        return (
          <section
            key={capability}
            className={styles.sheetSection}
            aria-label={CAPABILITY_LABEL[capability]}
          >
            <header className={styles.sheetSectionHead}>
              <h3 className={styles.sheetSectionTitle}>{CAPABILITY_LABEL[capability]}</h3>
              <span className={styles.sheetSectionNote}>
                {off
                  ? 'Switched off for this model'
                  : pinned
                    ? 'Pinned by an administrator'
                    : 'Chosen automatically'}
              </span>
              {isAdmin ? (
                <button
                  type="button"
                  role="switch"
                  aria-checked={!off}
                  aria-label={`${CAPABILITY_LABEL[capability]} for this model`}
                  className={styles.capSwitch}
                  disabled={busy !== null}
                  onClick={() => void toggle(capability, off)}
                >
                  {off ? 'Off' : 'On'}
                </button>
              ) : null}
            </header>
            {off ? (
              <p className={styles.sheetFoot}>
                Jobs asking for this are refused for {model.displayName}.
                {pinned ? ' The pinned template comes back when it is switched on.' : ''}
              </p>
            ) : null}
            <ul className={`${styles.sheetOptions} ${off ? styles.sheetOptionsOff : ''}`} role={isAdmin ? 'radiogroup' : undefined} aria-label={isAdmin ? `${CAPABILITY_LABEL[capability]} template` : undefined}>
              {options.map((option) => {
                const chosen = pinned ? option.assigned : option.automatic;
                const tone = RUNNABILITY_TONE[option.verdict.status];
                return (
                  <li
                    key={option.template.id}
                    className={`${styles.sheetOption} ${chosen ? styles.sheetOptionOn : ''}`}
                  >
                    {isAdmin ? (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={option.assigned}
                        className={styles.sheetRadio}
                        disabled={busy !== null || off}
                        aria-label={`Pin ${option.template.label}`}
                        onClick={() => void assign(capability, option.template.id)}
                      >
                        <span className={styles.sheetRadioDot} aria-hidden />
                      </button>
                    ) : (
                      <span className={`${styles.sheetRadio} ${styles.sheetRadioStatic}`} aria-hidden>
                        <span className={styles.sheetRadioDot} />
                      </span>
                    )}
                    <div className={styles.sheetOptionBody}>
                      <div className={styles.sheetOptionHead}>
                        <span className={styles.sheetOptionLabel}>{option.template.label}</span>
                        {option.template.isFallback ? (
                          <span className={styles.sheetBadge}>generic</span>
                        ) : null}
                        {option.automatic ? (
                          <span className={`${styles.sheetBadge} ${styles.sheetBadgeAuto}`}>automatic</span>
                        ) : null}
                        {option.assigned ? (
                          <span className={`${styles.sheetBadge} ${styles.sheetBadgeOn}`}>pinned</span>
                        ) : null}
                      </div>
                      <p className={styles.sheetOptionDesc}>{option.template.description}</p>
                      <p className={`${styles.verdict} ${styles[`verdict_${tone}`]}`}>
                        <span className={styles.verdictChip}>{RUNNABILITY_LABEL[option.verdict.status]}</span>
                        <span className={styles.verdictText}>
                          {option.verdict.detail ?? option.verdict.summary}
                        </span>
                      </p>
                      <ManualDownloads missing={option.verdict.missing ?? []} />
                    </div>
                  </li>
                );
              })}
            </ul>
            {isAdmin && pinned ? (
              <button
                type="button"
                className={styles.sheetAuto}
                disabled={busy !== null || off}
                onClick={() => void assign(capability, null)}
              >
                Use automatic
              </button>
            ) : null}
          </section>
        );
      })}

      {!isAdmin && capabilities.length > 0 ? (
        <p className={styles.sheetFoot}>Only an administrator can pin a template for a model.</p>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- browse mode

function TemplateList({ api, family }: { api: ModelsApi; family: string | null }) {
  const [templates, setTemplates] = useState<WorkflowTemplateSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setTemplates(null);
    api
      .templates(controller.signal)
      .then((list) => setTemplates(list))
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof ApiRequestError ? cause.message : 'Could not read the templates.');
      });
    return () => controller.abort();
  }, [api]);

  if (error) {
    return (
      <p className={styles.sheetProblem} role="alert">
        {error}
      </p>
    );
  }
  if (!templates) {
    return (
      <div className={styles.sheetLoading} role="status">
        <span className={`${styles.skeleton} ${styles.sheetSkeleton}`} />
        <span className={`${styles.skeleton} ${styles.sheetSkeleton}`} />
      </div>
    );
  }

  const wanted = family ? foldFamily(family) : null;
  const shown = wanted
    ? templates.filter((template) => template.baseModels.some((base) => foldFamily(base) === wanted))
    : templates;

  return (
    <>
      {wanted && shown.length === 0 ? (
        <p className={styles.sheetProblem}>
          No template is written for {familyLabel(wanted)} models yet. Every template rippel ships is
          listed below.
        </p>
      ) : null}
      <ul className={styles.sheetOptions} aria-label="Templates">
        {(shown.length > 0 ? shown : templates).map((template, index) => (
          <li
            key={template.id}
            className={`${styles.sheetOption} rise`}
            style={{ '--i': Math.min(index, 12) } as React.CSSProperties}
          >
            <div className={styles.sheetOptionBody}>
              <div className={styles.sheetOptionHead}>
                <span className={styles.sheetOptionLabel}>{template.label}</span>
                <span className={styles.sheetBadge}>{CAPABILITY_LABEL[template.capability]}</span>
                {template.isFallback ? <span className={styles.sheetBadge}>generic</span> : null}
              </div>
              <p className={styles.sheetOptionDesc}>{template.description}</p>
              <dl className={styles.sheetMeta}>
                <dt>Families</dt>
                <dd>{template.baseModels.map((base) => familyLabel(foldFamily(base))).join(', ')}</dd>
                <dt>Loads from</dt>
                <dd className="mono">{template.loaderFolders.map((folder) => `${folder}/`).join(' ')}</dd>
                {template.requires.length > 0 ? (
                  <>
                    <dt>Needs</dt>
                    <dd>{template.requires.map((requirement) => requirement.label).join(', ')}</dd>
                  </>
                ) : null}
              </dl>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
