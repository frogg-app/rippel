/**
 * The one job the stage is showing, and everything that keeps it current.
 *
 * Three sources feed it, in this order of authority:
 *  1. `POST /jobs`, which returns the job we just started;
 *  2. `GET /jobs/:id` on mount, because a socket only reports what happened
 *     while it was connected — after a reload the bar must pick up where the
 *     job actually is, not at zero;
 *  3. `WS /api/events`, applied through the pure reducer in `jobProgress.ts`.
 *
 * The active job id is kept in `sessionStorage` rather than the URL: it is a
 * per-tab "what was I watching", not a shareable address, and putting it in the
 * URL would make a refresh of a finished job look like a permalink to results
 * that live in the Library instead.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobFit, GenerationParams, Job, JobEvent } from '@comfy/shared';
import { type ConnectionState, jobsApi, subscribeToEvents } from '../lib/api-jobs';
import { adoptCreated, applyJobEvent, isTerminal } from './jobProgress';

const ACTIVE_JOB_KEY = 'comfy.create.activeJob';

export interface JobStageState {
  job: Job | null;
  connection: ConnectionState;
  /** A submit that failed — the API's own message, which names the control. */
  submitError: string | null;
  submitting: boolean;
  /**
   * Whether the machine that took this job has ever finished one this big.
   *
   * Only ever a warning. The verdict comes from a bracket learned from that
   * machine's own history, and history is not a promise in either direction —
   * so a job judged `too-big` still runs, and this is what says so while it
   * does. Cleared whenever the stage is.
   */
  fit: JobFit | null;
}

export interface JobStage extends JobStageState {
  submit: (params: GenerationParams) => Promise<Job | null>;
  cancel: () => void;
  clear: () => void;
}

function readActiveJobId(): string | null {
  try {
    return sessionStorage.getItem(ACTIVE_JOB_KEY);
  } catch {
    return null;
  }
}

function writeActiveJobId(id: string | null) {
  try {
    if (id) sessionStorage.setItem(ACTIVE_JOB_KEY, id);
    else sessionStorage.removeItem(ACTIVE_JOB_KEY);
  } catch {
    /* private mode; the stage just starts empty next time */
  }
}

export function useJobStage(): JobStage {
  const [state, setState] = useState<JobStageState>({
    job: null,
    connection: 'connecting',
    submitError: null,
    submitting: false,
    fit: null,
  });

  // The reducer needs the current job, but resubscribing the socket on every
  // progress frame would be absurd. A ref keeps the listener stable.
  const jobRef = useRef<Job | null>(null);
  const setJob = useCallback((next: Job | null) => {
    jobRef.current = next;
    setState((prev) => ({ ...prev, job: next }));
  }, []);

  // 2. Rehydrate on mount.
  useEffect(() => {
    const id = readActiveJobId();
    if (!id) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const { job } = await jobsApi.get(id, controller.signal);
        if (controller.signal.aborted) return;
        // Only adopt if nothing has been started in the meantime — a submit
        // that beat this fetch wins.
        if (!jobRef.current) setJob(job);
      } catch {
        // The job is gone (restarted API, cleared session). Forget it quietly
        // rather than showing an error for something the user did not ask for.
        writeActiveJobId(null);
      }
    })();
    return () => controller.abort();
  }, [setJob]);

  // 3. The socket.
  useEffect(() => {
    const onEvent = (event: JobEvent) => {
      if (event.type === 'job.created' && adoptCreated(jobRef.current, event.job)) {
        writeActiveJobId(event.job.id);
        setJob(event.job);
        return;
      }
      const next = applyJobEvent(jobRef.current, event);
      if (next !== jobRef.current) setJob(next);
    };

    return subscribeToEvents({
      onEvent,
      onConnectionChange: (connection) => setState((prev) => ({ ...prev, connection })),
    });
  }, [setJob]);

  const submit = useCallback(
    async (params: GenerationParams) => {
      setState((prev) => ({ ...prev, submitting: true, submitError: null, fit: null }));
      try {
        const { job, fit } = await jobsApi.create(params);
        writeActiveJobId(job.id);
        // The socket may already have delivered `job.created` and progress
        // frames for this job while the POST was in flight; keep whichever is
        // further along rather than snapping the bar back to queued.
        const current = jobRef.current;
        if (!current || current.id !== job.id) setJob(job);
        // Only a verdict worth reading is kept: `fits` and `unknown` both mean
        // "say nothing", and a banner that appears on every job teaches people
        // to ignore the one that matters.
        setState((prev) => ({
          ...prev,
          submitting: false,
          fit: fit && (fit.verdict === 'too-big' || fit.verdict === 'unproven') ? fit : null,
        }));
        return job;
      } catch (error) {
        setState((prev) => ({
          ...prev,
          submitting: false,
          submitError: error instanceof Error ? error.message : 'Could not start the job.',
        }));
        return null;
      }
    },
    [setJob],
  );

  const cancel = useCallback(() => {
    const job = jobRef.current;
    if (!job || isTerminal(job.status)) return;
    void jobsApi
      .cancel(job.id)
      .then(({ job: cancelled }) => setJob(cancelled))
      .catch(() => {
        /* the socket will tell us if it actually stopped */
      });
  }, [setJob]);

  const clear = useCallback(() => {
    writeActiveJobId(null);
    setJob(null);
    setState((prev) => ({ ...prev, submitError: null, fit: null }));
  }, [setJob]);

  return { ...state, submit, cancel, clear };
}
