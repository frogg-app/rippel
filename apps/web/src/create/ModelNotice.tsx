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
import { useContext, useEffect, useState } from 'react';
import type { JobKind, Model, ModelInstall } from '@comfy/shared';
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
import { absentParts, joinParts } from './modelReasons';
import { modeOfKind } from './form';
import { invalidateReadiness } from './useReadiness';
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
}: {
  model: Model;
  kind: JobKind;
  answer: ModelReadiness | undefined;
}) {
  const user = useContext(AuthContext)?.user ?? null;
  const backendId = model.backendIds[0] ?? null;
  if (!answer || answer.state !== 'blocked' || !backendId) return null;

  const isAdmin = !user || user.role === 'admin';
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
        <>
          <a className={styles.link} href={findModelsHref(mode)} title={answer.problem.detail}>
            Pick another model
          </a>
        </>
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
          <button type="button" className={styles.getIt} disabled={state.kind === 'starting'} onClick={install}>
            {state.kind === 'starting' ? 'Starting…' : `Install ${part.offer.name}${part.offer.size ? ` (${part.offer.size})` : ''}`}
          </button>
        ) : null}
        <a className={styles.link} href={findPartHref(search)}>
          Find on Models
        </a>
      </span>
    </li>
  );
}
