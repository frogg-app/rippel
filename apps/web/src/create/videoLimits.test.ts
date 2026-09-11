import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ModelWorkflows, WorkflowVideoLimits } from '@comfy/shared';
import { fitVideoState, videoFrameBounds } from './form';
import { selectedVideoLimits, useVideoLimits } from './useVideoLimits';
import { modelsApi } from '../lib/api-models';

vi.mock('../lib/api-models', () => ({ modelsApi: { modelWorkflows: vi.fn() } }));

const svd: WorkflowVideoLimits = {
  frames: { min: 2, max: 25, step: 1 }, fps: { min: 3, max: 30, step: 1 },
  frameQuantum: 1, motion: { min: 1, max: 1023, step: 1 },
};
const ltx: WorkflowVideoLimits = {
  frames: { min: 9, max: 161, step: 1 }, fps: { min: 1, max: 60, step: 1 },
  frameQuantum: 8, motion: null,
};
function response(limits: WorkflowVideoLimits): ModelWorkflows {
  return { options: [{ automatic: true, assigned: false,
    template: { capability: 'img2vid', videoLimits: limits } }] } as ModelWorkflows;
}

describe('per-model video limits', () => {
  it('fits SVD defaults and gives LTX a different maximum duration', () => {
    expect(fitVideoState({ lengthSeconds: 4, fps: 25 }, svd)).toEqual({ lengthSeconds: 1, fps: 25 });
    expect(videoFrameBounds(ltx).max / 25).toBe(6.44);
    expect(fitVideoState({ lengthSeconds: 10, fps: 25 }, ltx).lengthSeconds).toBe(6.44);
    expect(fitVideoState({ lengthSeconds: 1, fps: 60 }, svd)).toEqual({ lengthSeconds: 25 / 30, fps: 30 });
  });

  it('uses an admin assignment before the automatic option', () => {
    const workflows = response(ltx);
    workflows.options.push({ ...response(svd).options[0]!, automatic: false, assigned: true });
    expect(selectedVideoLimits(workflows, 'img2vid')).toBe(svd);
    expect(selectedVideoLimits(workflows, 'txt2vid')).toBeNull();
  });

  it('discards old model limits immediately and ignores late responses', async () => {
    let finish!: (value: ModelWorkflows) => void;
    vi.mocked(modelsApi.modelWorkflows)
      .mockResolvedValueOnce(response(svd))
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(response(svd));
    const { result, rerender } = renderHook(({ id }) => useVideoLimits(id, 'img2vid'), {
      initialProps: { id: 'svd' },
    });
    await waitFor(() => expect(result.current.limits).toEqual(svd));
    rerender({ id: 'ltx' });
    expect(result.current.limits).toBeNull();
    rerender({ id: 'svd-2' });
    await waitFor(() => expect(result.current.limits).toEqual(svd));
    await act(async () => finish(response(ltx)));
    expect(result.current.limits).toEqual(svd);
  });

  it('reports a failed request and supports retrying the same model', async () => {
    vi.mocked(modelsApi.modelWorkflows)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(response(svd));
    const { result } = renderHook(() => useVideoLimits('svd', 'img2vid'));
    await waitFor(() => expect(result.current.error).toContain('Could not load'));
    expect(result.current.limits).toBeNull();
    act(() => result.current.retry());
    expect(result.current.error).toBeNull();
    await waitFor(() => expect(result.current.limits).toEqual(svd));
  });
});
