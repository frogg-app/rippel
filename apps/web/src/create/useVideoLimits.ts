/** Resolve the same admin pin or automatic choice shown by the workflow sheet.
 * Answers are keyed during render so a model switch cannot submit old limits. */
import { useCallback, useEffect, useState } from 'react';
import type { JobKind, ModelWorkflows, WorkflowVideoLimits } from '@comfy/shared';
import { modelsApi } from '../lib/api-models';

export function selectedVideoLimits(workflows: ModelWorkflows, kind: JobKind) {
  const options = workflows.options.filter((option) => option.template.capability === kind);
  return (options.find((option) => option.assigned) ?? options.find((option) => option.automatic))
    ?.template.videoLimits ?? null;
}

export function useVideoLimits(modelId: string | null, kind: JobKind) {
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  const key = `${modelId}|${kind}|${revision}`;
  const [answer, setAnswer] = useState<{
    key: string; limits: WorkflowVideoLimits | null; error: string | null;
  } | null>(null);
  const isVideo = kind === 'txt2vid' || kind === 'img2vid';
  useEffect(() => {
    if (!modelId || !isVideo) return;
    const controller = new AbortController();
    void modelsApi.modelWorkflows(modelId, null, controller.signal).then((workflows) => {
      if (controller.signal.aborted) return;
      const limits = selectedVideoLimits(workflows, kind);
      setAnswer({ key, limits, error: limits ? null : 'Video settings are unavailable for this workflow.' });
    }).catch(() => {
      if (!controller.signal.aborted) {
        setAnswer({ key, limits: null, error: 'Could not load video settings. Try again.' });
      }
    });
    return () => controller.abort();
  }, [modelId, kind, isVideo, key]);
  return { ...(answer?.key === key ? answer : { limits: null, error: null }), retry };
}
