/**
 * What the chosen model still needs, said under the Model section with the
 * buttons that fix it.
 *
 * The Models page already knew each model's prerequisites — "Needs prompt
 * reader", "Needs image decoder", with Find and Download — and the Create
 * screen did not use any of it, so a person found out by pressing Generate and
 * reading a ComfyUI traceback. This is the same knowledge where the decision is
 * made: one sentence naming the parts ("LTX-Video needs a prompt reader (T5
 * text encoder) and an image decoder before it can run"), one Install per part
 * (the readiness check's own recommended download, through the same
 * `POST /backends/:id/readiness/install` the Models page uses), progress
 * inline, and a "Find on Models" link for anyone who wants to choose a
 * different build. When the last part lands, readiness is asked again and
 * Generate wakes up by itself.
 *
 * A file that cannot load at all (diffusers-format weights) gets no Install
 * button: no part fixes it, and offering one is how the user ended up
 * downloading things for a model that was never going to run.
 */
import { useContext, useEffect, useState, type ReactNode } from 'react';
import type { JobKind, Model, ModelFileOperation, ModelFileProblem, ModelInstall } from '@comfy/shared';
import { ApiRequestError } from '../lib/api';
import { type MissingPart, type ModelReadiness, readinessApi } from '../lib/api-jobs';
import { modelsApi } from '../lib/api-models';
import { AuthContext } from '../auth/context';
import { InstallProgress } from '../models/InstallProgress';
import { partSearch } from '../models/MissingParts';
import { VOCABULARY } from '../models/vocabulary';
import { WarningIcon } from './icons';
import { familyWords } from './families';
import { findModelsHref, findPartHref } from './discoverLinks';
import { NOT_SUPPORTED, absentParts, joinParts } from './modelReasons';
import { WorkflowSuggestions } from '../models/WorkflowSuggestions';
import { modeOfKind } from './form';
import { invalidateReadiness } from './useReadiness';
import { Button, buttonClass } from '../components/Button';
import { DeleteButton } from '../components/ConfirmDelete';
import styles from './modelPicker.module.css';

const POLL_MS = 3_000;

/** The sentence that leads the notice. Exported for tests. */
export function noticeHeadline(model: Model, answer: ModelReadiness): string {
  const who = model.baseModel ? familyWords(model.baseModel).label : model.displayName;
  if (answer.problem) {
    return answer.problem.kind === 'unloadable'
      ? 'This file won’t run'
      : 'This file is in the wrong folder';
  }
  const absent = absentParts(answer.missing);
  if (absent.length > 0) return `${who} needs ${joinParts(absent)} before it can run`;
  return `${who} isn’t set up on this machine yet`;
}

export function ModelNotice({
  model,
  kind,
  answer,
  onWant,
  onChanged,
}: {
  model: Model;
  kind: JobKind;
  answer: ModelReadiness | undefined;
  /** Select this model once the list has it (by id, or by filename after an install). */
  onWant?: (want: { id: string | null; filename: string }) => void;
  /** The model list changed under us: a file moved or was removed. */
  onChanged?: () => void;
}) {
  const user = useContext(AuthContext)?.user ?? null;
  const backendId = model.backendIds[0] ?? null;
  const isAdmin = !user || user.role === 'admin';

  // Nothing built in runs it: offer the best library workflow, in one click.
  if (answer?.state === 'no-template' && backendId) {
    return (
      <div className={styles.notice} role="status" aria-label="What this model needs">
        <p className={styles.noticeHead} title={answer.summary ?? undefined}>
          <WarningIcon size={12} className={styles.noteIcon} />
          <strong className={styles.noteStrong}>{NOT_SUPPORTED}</strong>
        </p>
        <WorkflowSuggestions
          modelId={model.id}
          backendId={backendId}
          compact
          onReady={() => {
            invalidateReadiness(backendId, model.id);
            onChanged?.();
          }}
        />
      </div>
    );
  }
  if (!answer || answer.state !== 'blocked' || !backendId) return null;

  const absent = absentParts(answer.missing);
  const misfiled = (answer.missing ?? []).filter((part) => part.misfiled);
  const mode = modeOfKind(kind);

  return (
    <div className={styles.notice} role="status" aria-label="What this model needs">
      <p className={styles.noticeHead}>
        <WarningIcon size={12} className={styles.noteIcon} />
        <strong className={styles.noteStrong}>{noticeHeadline(model, answer)}</strong>
      </p>

      {answer.problem ? (
        <ProblemFix
          model={model}
          backendId={backendId}
          problem={answer.problem}
          isAdmin={isAdmin}
          pickHref={findModelsHref(mode)}
          onWant={onWant}
          onChanged={onChanged}
        />
      ) : (
        <>
          {absent.length > 0 ? (
            <ul className={styles.noticeParts}>
              {absent.map((part) => (
                <PartRow
                  key={part.label}
                  part={part}
                  model={model}
                  kind={kind}
                  backendId={backendId}
                  isAdmin={isAdmin}
                />
              ))}
            </ul>
          ) : null}
          {!isAdmin && absent.some((part) => part.offer) ? (
            <p className={styles.noticeText}>An admin can install these for you.</p>
          ) : null}
          {misfiled.length > 0 || (absent.length === 0 && answer.steps.length > 0) ? (
            <p className={styles.noticeText}>{answer.steps.filter((step) => !step.startsWith('Install ')).join(' ')}</p>
          ) : null}
        </>
      )}
    </div>
  );
}

type RowState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'installing'; install: ModelInstall }
  | { kind: 'message'; text: string; error?: boolean };

/** One missing part: its plain name, the file we would fetch, and the two ways to get it. */
function PartRow({
  part,
  model,
  kind,
  backendId,
  isAdmin,
}: {
  part: MissingPart;
  model: Model;
  kind: JobKind;
  backendId: string;
  isAdmin: boolean;
}) {
  const [state, setState] = useState<RowState>({ kind: 'idle' });
  const [now, setNow] = useState(() => Date.now());
  const installId = state.kind === 'installing' ? state.install.id : null;

  // Watch the download through the route that advances it, and when it lands,
  // ask readiness again so the tile, the notice and Generate all update.
  useEffect(() => {
    if (!installId) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      modelsApi
        .installStatus(backendId, installId)
        .then((install) => {
          if (stopped) return;
          if (install.status === 'complete') {
            window.clearInterval(timer);
            setState({ kind: 'message', text: 'Installed.' });
            invalidateReadiness(backendId, model.id);
          } else if (install.status === 'failed' || install.status === 'cancelled') {
            window.clearInterval(timer);
            setState({ kind: 'message', text: install.error ?? 'The download did not finish.', error: true });
          } else {
            setState({ kind: 'installing', install });
          }
        })
        .catch(() => {
          // A missed poll is just a later one.
        });
    }, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [installId, backendId, model.id]);

  const plain = part.type ? VOCABULARY[part.type].name : part.label;
  const search = partSearch({ filename: part.offer?.filename ?? part.label, purpose: part.label, loader: '' });

  const install = () => {
    if (!part.offer) return;
    setState({ kind: 'starting' });
    readinessApi
      .installMissing(backendId, model.id, kind, [part.offer.ref])
      .then((result) => {
        const started = result.installs[0];
        if (started) setState({ kind: 'installing', install: started });
        else setState({ kind: 'message', text: result.skipped[0]?.reason ?? 'Nothing left to download.' });
      })
      .catch((cause: unknown) =>
        setState({
          kind: 'message',
          error: true,
          text:
            cause instanceof ApiRequestError && cause.status === 403
              ? 'Only an admin can install files.'
              : cause instanceof Error
                ? cause.message
                : 'Could not start the download.',
        }),
      );
  };

  return (
    <li className={styles.noticePart}>
      <span className={styles.noticePartName}>
        {plain}
        <span className={styles.noteExpert}> · {part.label}</span>
      </span>
      <span className={styles.noticePartActions}>
        {state.kind === 'installing' ? (
          <InstallProgress install={state.install} now={now} compact />
        ) : state.kind === 'message' ? (
          <span role={state.error ? 'alert' : undefined}>{state.text}</span>
        ) : part.offer && isAdmin ? (
          <Button variant="primary" busy={state.kind === 'starting'} onClick={install}>
            {state.kind === 'starting' ? 'Starting…' : `Install ${part.offer.name}${part.offer.size ? ` (${part.offer.size})` : ''}`}
          </Button>
        ) : null}
        <a className={buttonClass('quiet')} href={findPartHref(search)}>
          Find on Models
        </a>
      </span>
    </li>
  );
}

type FixState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'installing'; install: ModelInstall; filename: string }
  | { kind: 'moving'; operation: ModelFileOperation }
  | { kind: 'message'; text: string; error?: boolean };

function errorText(cause: unknown, fallback: string): string {
  if (cause instanceof ApiRequestError && cause.status === 403) return 'Only an admin can do this.';
  return cause instanceof Error ? cause.message : fallback;
}

/**
 * A model file with a problem of its own. One action, when the app can make
 * the repair: install a known-good build of the same family and select it, or
 * have the agent move bare diffusion weights to diffusion_models. Otherwise
 * the "Pick another model" link. Admins also get a danger "Remove", behind
 * the shared delete confirm,
 * for a file that will never load. Detail lives in tooltips.
 */
export function ProblemFix({
  model,
  backendId,
  problem,
  isAdmin,
  pickHref,
  onWant,
  onChanged,
}: {
  model: Model;
  backendId: string;
  problem: ModelFileProblem;
  isAdmin: boolean;
  pickHref: string;
  onWant?: (want: { id: string | null; filename: string }) => void;
  onChanged?: () => void;
}) {
  const [state, setState] = useState<FixState>({ kind: 'idle' });
  const [now, setNow] = useState(() => Date.now());
  const fix = isAdmin ? (problem.fix ?? null) : null;
  const installId = state.kind === 'installing' ? state.install.id : null;
  const installFile = state.kind === 'installing' ? state.filename : null;
  const operationId = state.kind === 'moving' ? state.operation.id : null;

  useEffect(() => {
    if (!installId || !installFile) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      modelsApi
        .installStatus(backendId, installId)
        .then((install) => {
          if (stopped) return;
          if (install.status === 'complete') {
            window.clearInterval(timer);
            setState({ kind: 'message', text: 'Installed. Selecting it…' });
            onWant?.({ id: null, filename: installFile });
          } else if (install.status === 'failed' || install.status === 'cancelled') {
            window.clearInterval(timer);
            setState({ kind: 'message', text: install.error ?? 'The download did not finish.', error: true });
          } else {
            setState({ kind: 'installing', install, filename: installFile });
          }
        })
        .catch(() => {});
    }, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [installId, installFile, backendId, onWant]);

  useEffect(() => {
    if (!operationId) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      readinessApi
        .operation(operationId)
        .then((operation) => {
          if (stopped) return;
          if (operation.status === 'done') {
            window.clearInterval(timer);
            setState({ kind: 'message', text: 'Moved.' });
            invalidateReadiness(backendId, model.id);
            onChanged?.();
          } else if (operation.status === 'failed') {
            window.clearInterval(timer);
            setState({ kind: 'message', text: operation.error ?? 'The move did not finish.', error: true });
          } else {
            setState({ kind: 'moving', operation });
          }
        })
        .catch(() => {});
    }, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [operationId, backendId, model.id, onChanged]);

  const getWorking = () => {
    setState({ kind: 'starting' });
    readinessApi
      .workingBuild(backendId, model.id)
      .then((result) => {
        if (result.install) setState({ kind: 'installing', install: result.install, filename: result.filename });
        else {
          setState({ kind: 'message', text: 'Already here. Selecting it…' });
          onWant?.({ id: result.modelId, filename: result.filename });
        }
      })
      .catch((cause: unknown) => setState({ kind: 'message', error: true, text: errorText(cause, 'Could not start the download.') }));
  };

  const move = () => {
    setState({ kind: 'starting' });
    readinessApi
      .moveToDiffusionModels(backendId, model.id)
      .then((operation) => setState({ kind: 'moving', operation }))
      .catch((cause: unknown) => setState({ kind: 'message', error: true, text: errorText(cause, 'Could not move the file.') }));
  };

  // Remove deletes the file from the machine, so its confirm names both.
  const canRemove = isAdmin && problem.kind === 'unloadable';
  const [machine, setMachine] = useState('this machine');
  useEffect(() => {
    if (!canRemove) return;
    let stopped = false;
    Promise.resolve()
      .then(() => modelsApi.backends())
      .then((list) => {
        const name = list.find((b) => b.id === backendId)?.name;
        if (name && !stopped) setMachine(name);
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [canRemove, backendId]);

  const remove = async () => {
    try {
      const removal = await modelsApi.removeModel(model.id);
      setState({ kind: 'message', text: removal.removedFromDisk ? 'Deleted.' : 'Removed from rippel.' });
      onChanged?.();
    } catch (cause) {
      throw new Error(errorText(cause, 'Could not delete it.'));
    }
  };

  let action: ReactNode;
  if (state.kind === 'installing') action = <InstallProgress install={state.install} now={now} compact />;
  else if (state.kind === 'moving') action = <span>Moving…</span>;
  else if (state.kind === 'message') action = <span role={state.error ? 'alert' : undefined}>{state.text}</span>;
  else if (fix?.kind === 'replace') {
    action = (
      <Button
        variant="primary"
        busy={state.kind === 'starting'}
        onClick={getWorking}
        title={`Installs ${fix.name}${fix.size ? ` (${fix.size})` : ''}, a build ComfyUI can load.`}
      >
        {state.kind === 'starting' ? 'Starting…' : 'Get a version that works'}
      </Button>
    );
  } else if (fix?.kind === 'move') {
    action = (
      <Button variant="primary" busy={state.kind === 'starting'} onClick={move} title={problem.detail}>
        {state.kind === 'starting' ? 'Starting…' : 'Move it'}
      </Button>
    );
  } else {
    action = (
      <a className={buttonClass('secondary')} href={pickHref} title={problem.detail}>
        Pick another model
      </a>
    );
  }

  return (
    <div className={styles.noticeActions}>
      {action}
      {canRemove && state.kind === 'idle' ? (
        <DeleteButton
          className={styles.noticeRemove}
          aria-label={`Remove ${model.displayName}`}
          hint={`Deletes ${model.filename} from ${machine}`}
          confirmTitle="Delete this file?"
          confirmBody={
            <>
              <strong>{model.displayName}</strong> will be removed from <strong>{machine}</strong>.
            </>
          }
          onConfirm={remove}
        />
      ) : null}
    </div>
  );
}
