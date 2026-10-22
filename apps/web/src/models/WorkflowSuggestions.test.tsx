import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../lib/api', () => ({ request: vi.fn() }));
import { request } from '../lib/api';
import { WorkflowSuggestions } from './WorkflowSuggestions';

afterEach(() => vi.resetAllMocks());

const suggestion = { name: 'video_minimax_h3_r2v', title: 'MiniMax H3 Reference to Video', capability: 'img2vid', downloadBytes: 0, files: [] };

it('offers each match as one Add button and shows progress once added', async () => {
  vi.mocked(request)
    .mockResolvedValueOnce({ family: 'minimax', canAdd: true, version: '0.11.55', added: [], suggestions: [suggestion] })
    .mockResolvedValueOnce({ added: { workflowId: 'w', title: suggestion.title, capability: 'img2vid', phase: 'testing', error: null, progress: null } });
  render(<WorkflowSuggestions modelId="m" backendId="b" onBrowse={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Add MiniMax H3 Reference to Video' }));
  expect(await screen.findByText(/Testing…/)).toBeInTheDocument();
  expect(request).toHaveBeenLastCalledWith('/models/m/workflows/add', {
    method: 'POST',
    body: { backendId: 'b', name: 'video_minimax_h3_r2v', version: '0.11.55', capability: 'img2vid' },
  });
});

it('says one line and offers Browse when nothing fits', async () => {
  const onBrowse = vi.fn();
  vi.mocked(request).mockResolvedValueOnce({ family: null, canAdd: true, version: '1', added: [], suggestions: [] });
  render(<WorkflowSuggestions modelId="m" backendId="b" onBrowse={onBrowse} />);
  expect(await screen.findByText('No workflow for this model yet')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Browse workflows' }));
  expect(onBrowse).toHaveBeenCalled();
});

it('is a single Add workflow button when compact', async () => {
  vi.mocked(request).mockResolvedValueOnce({ family: 'minimax', canAdd: true, version: '1', added: [], suggestions: [suggestion, { ...suggestion, name: 'two' }] });
  render(<WorkflowSuggestions modelId="m" backendId="b" compact />);
  expect(await screen.findByRole('button', { name: 'Add workflow' })).toBeInTheDocument();
  expect(screen.getAllByRole('button')).toHaveLength(1);
});
