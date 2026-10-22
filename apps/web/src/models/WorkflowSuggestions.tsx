/**
 * The way forward for a model nothing runs yet: up to three one-click "Add"
 * buttons for library workflows that fit it, with progress inline while the
 * workflow's other files download and its test generation runs. When nothing
 * fits, one line and "Browse workflows".
 *
 * The server does the matching and the checking (`/models/:id/workflow-suggestions`),
 * so a button here is only ever shown for a workflow that can really be added.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobKind, Uuid } from '@comfy/shared';
import { request } from '../lib/api';
import { formatBytes } from './catalogue';
import { WorkflowIcon } from './icons';
import panels from './ModelsPanels.module.css';
import styles from './workflowSuggestions.module.css';

export interface WorkflowSuggestion {
  name: string;
  title: string;
  capability: JobKind;
  downloadBytes: number | null;
  files: string[];
}

export interface AddedWorkflow {
  workflowId: string;
  title: string;
  capability: JobKind;
  phase: 'downloading' | 'testing' | 'ready' | 'failed';
  error: string | null;
  progress: { bytesReceived?: number; bytesTotal?: number } | null;
}

export interface SuggestionsAnswer {
  family: string | null;
  canAdd: boolean;
  version: string | null;
  added: AddedWorkflow[];
  suggestions: WorkflowSuggestion[];
}

const JOB_WORDS: Record<JobKind, string> = {
  txt2img: 'Text to image',
  img2img: 'Image to image',
  txt2vid: 'Text to video',
  img2vid: 'Image to video',
  upscale: 'Upscale',
};

const POLL_MS = 3_000;

function tip(suggestion: WorkflowSuggestion): string {
  const parts = [JOB_WORDS[suggestion.capability]];
  if (suggestion.files.length > 0) {
    parts.push(
      `Downloads ${suggestion.files.join(', ')}${suggestion.downloadBytes ? ` (${formatBytes(suggestion.downloadBytes)})` : ''}`,
    );
  }
  parts.push('Runs one test generation');
  return parts.join(' · ');
}

function phaseText(added: AddedWorkflow): string {
  if (added.phase === 'downloading') {
    const got = added.progress?.bytesReceived;
    const total = added.progress?.bytesTotal;
    return got !== undefined && total ? `Downloading ${formatBytes(got)} / ${formatBytes(total)}` : 'Downloading…';
  }
  if (added.phase === 'testing') return 'Testing…';
  if (added.phase === 'failed') return 'Failed';
  return 'Ready';
}

export function WorkflowSuggestions({
  modelId,
  backendId,
  compact = false,
  onBrowse,
  onReady,
}: {
  modelId: Uuid;
  backendId: Uuid;
  /** One button only (the best match), for the Create screen. */
  compact?: boolean;
  onBrowse?: () => void;
  /** An added workflow passed its test: the model's verdict has changed. */
  onReady?: () => void;
}) {
  const [answer, setAnswer] = useState<SuggestionsAnswer | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const readyRef = useRef(onReady);
  readyRef.current = onReady;

  const load = useCallback(
    (signal?: AbortSignal) =>
      request<SuggestionsAnswer>(
        `/models/${modelId}/workflow-suggestions?backendId=${encodeURIComponent(backendId)}`,
        { signal },
      ).then((next) => {
        if (!signal?.aborted) setAnswer(next);
        return next;
      }),
    [modelId, backendId],
  );

  useEffect(() => {
    const controller = new AbortController();
    setAnswer(null);
    load(controller.signal).catch(() => {});
    return () => controller.abort();
  }, [load]);

  const busy = answer?.added.filter((added) => added.phase === 'downloading' || added.phase === 'testing') ?? [];
  useEffect(() => {
    if (busy.length === 0) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      Promise.all(
        busy.map((added) =>
          request<{ added: AddedWorkflow }>(`/models/${modelId}/workflows/added/${added.workflowId}`, {
            signal: controller.signal,
          }).then((result) => result.added),
        ),
      )
        .then((fresh) => {
          if (controller.signal.aborted) return;
          setAnswer((now) =>
            now
              ? { ...now, added: now.added.map((old) => fresh.find((next) => next.workflowId === old.workflowId) ?? old) }
              : now,
          );
          if (fresh.some((next) => next.phase === 'ready')) readyRef.current?.();
        })
        .catch(() => {});
    }, POLL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
    // Re-arm only when the set of in-flight workflows changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, busy.map((added) => `${added.workflowId}:${added.phase}`).join(',')]);

  async function add(suggestion: WorkflowSuggestion) {
    if (!answer?.version) return;
    setAdding(suggestion.name);
    setError(null);
    try {
      const result = await request<{ added: AddedWorkflow }>(`/models/${modelId}/workflows/add`, {
        method: 'POST',
        body: { backendId, name: suggestion.name, version: answer.version, capability: suggestion.capability },
      });
      setAnswer((now) =>
        now
          ? {
              ...now,
              added: [...now.added, result.added],
              suggestions: now.suggestions.filter((other) => other.name !== suggestion.name),
            }
          : now,
      );
      if (result.added.phase === 'ready') onReady?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add this workflow.');
    } finally {
      setAdding(null);
    }
  }

  if (!answer) return null;
  const inFlight = answer.added.filter((added) => added.phase !== 'ready');
  const shown = compact ? answer.suggestions.slice(0, 1) : answer.suggestions;
  const nothing = shown.length === 0 && inFlight.length === 0;

  return (
    <div className={styles.row} aria-live="polite">
      {inFlight.map((added) => (
        <span
          key={added.workflowId}
          className={added.phase === 'failed' ? styles.error : styles.status}
          title={added.error ?? `${added.title} · ${JOB_WORDS[added.capability]}`}
        >
          {compact ? '' : `${added.title}: `}
          {phaseText(added)}
        </span>
      ))}
      {answer.canAdd
        ? shown.map((suggestion) => (
            <button
              key={suggestion.name}
              type="button"
              className={panels.rowAction}
              disabled={adding !== null}
              title={tip(suggestion)}
              onClick={() => void add(suggestion)}
            >
              <WorkflowIcon size={13} />
              {adding === suggestion.name ? 'Adding…' : compact ? 'Add workflow' : `Add ${suggestion.title}`}
            </button>
          ))
        : null}
      {!nothing && !compact && onBrowse ? (
        <button type="button" className={panels.rowAction} onClick={onBrowse} title="Every workflow in the library">
          More
        </button>
      ) : null}
      {nothing ? (
        <>
          <span className={styles.line}>No workflow for this model yet</span>
          {onBrowse ? (
            <button type="button" className={panels.rowAction} onClick={onBrowse}>
              Browse workflows
            </button>
          ) : null}
        </>
      ) : null}
      {error ? (
        <span className={styles.error} role="alert" title={error}>
          Couldn’t add
        </span>
      ) : null}
    </div>
  );
}
