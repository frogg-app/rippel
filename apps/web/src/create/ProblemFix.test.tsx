/** One repair for a model file's own problem, on the Create screen. */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Model, ModelFileProblem, ModelInstall } from '@comfy/shared';

vi.mock('../lib/api-jobs', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/api-jobs')>();
  return {
    ...original,
    readinessApi: { ...original.readinessApi, workingBuild: vi.fn(), moveToDiffusionModels: vi.fn(), operation: vi.fn() },
  };
});
vi.mock('../lib/api-models', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/api-models')>();
  return { ...original, modelsApi: { ...original.modelsApi, installStatus: vi.fn(), removeModel: vi.fn(), backends: vi.fn() } };
});

const { readinessApi } = await import('../lib/api-jobs');
const { modelsApi } = await import('../lib/api-models');
const { ProblemFix } = await import('./ModelNotice');

const model: Model = {
  id: 'm1', type: 'checkpoint', filename: 'model_weights_0306.safetensors', displayName: 'Model Weights 0306',
  baseModel: 'ltx-video', previewUrl: null, sizeBytes: null, source: 'local', sourceRef: null, backendIds: ['b1'],
};
const unloadable: ModelFileProblem = { kind: 'unloadable', summary: 's', detail: 'ComfyUI can’t read this file’s format.' };
const install = { id: 'i1', status: 'downloading', filename: 'ltx-video-2b-v0.9.5.safetensors' } as unknown as ModelInstall;

function show(problem: ModelFileProblem, isAdmin = true, onWant = vi.fn(), onChanged = vi.fn()) {
  render(<ProblemFix model={model} backendId="b1" problem={problem} isAdmin={isAdmin} pickHref="/models" onWant={onWant} onChanged={onChanged} />);
  return { onWant, onChanged };
}

describe('ProblemFix', () => {
  beforeEach(() => vi.clearAllMocks());

  it('installs the working build, then selects it', async () => {
    vi.mocked(readinessApi.workingBuild).mockResolvedValue({ install, modelId: null, filename: install.filename });
    vi.mocked(modelsApi.installStatus).mockResolvedValue({ ...install, status: 'complete' });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { onWant } = show({ ...unloadable, fix: { kind: 'replace', name: 'ltx-video-2b-v0.9.5', size: '5.7 GB' } });
    expect(screen.queryByText('Pick another model')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Get a version that works' }));
    await waitFor(() => expect(readinessApi.workingBuild).toHaveBeenCalledWith('b1', 'm1'));
    await vi.advanceTimersByTimeAsync(3_100);
    vi.useRealTimers();
    await waitFor(() => expect(onWant).toHaveBeenCalledWith({ id: null, filename: install.filename }));
  });

  it('selects a working build that is already there', async () => {
    vi.mocked(readinessApi.workingBuild).mockResolvedValue({ install: null, modelId: 'm2', filename: 'x' });
    const { onWant } = show({ ...unloadable, fix: { kind: 'replace', name: 'x', size: null } });
    fireEvent.click(screen.getByRole('button', { name: 'Get a version that works' }));
    await waitFor(() => expect(onWant).toHaveBeenCalledWith({ id: 'm2', filename: 'x' }));
  });

  it('keeps "Pick another model" when there is no known-good build, with a quiet Remove for admins', async () => {
    vi.mocked(modelsApi.removeModel).mockResolvedValue({ removed: true, removedFromDisk: false, note: 'n' });
    const { onChanged } = show(unloadable);
    expect(screen.getByRole('link', { name: 'Pick another model' })).toHaveAttribute('title', unloadable.detail);
    vi.mocked(modelsApi.backends).mockResolvedValue([{ id: 'b1', name: 'desktop-6900xt' } as never]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove this file' }));
    // Asks first, naming the machine; nothing is deleted yet.
    expect(await screen.findByText(/from desktop-6900xt\?/)).toBeInTheDocument();
    expect(modelsApi.removeModel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('offers no fix or Remove to a non-admin', () => {
    show({ ...unloadable, fix: { kind: 'replace', name: 'x', size: null } }, false);
    expect(screen.getByRole('link', { name: 'Pick another model' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('moves diffusion weights out of checkpoints through the agent', async () => {
    vi.mocked(readinessApi.moveToDiffusionModels).mockResolvedValue({ id: 'o1', status: 'running', step_index: 0, steps: [], progress: null, error: null });
    show({ kind: 'needs-diffusion-loader', summary: 's', detail: 'd', fix: { kind: 'move' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move it' }));
    await waitFor(() => expect(screen.getByText('Moving…')).toBeInTheDocument());
  });
});
