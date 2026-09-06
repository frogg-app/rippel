/**
 * The queue chip, through the DOM.
 *
 * What is pinned here is what would be embarrassing in front of a second user:
 * that somebody else's prompt is not rendered — not as text, not as "undefined",
 * not as an empty pair of quotes — and that a server without the queue route
 * still gets a working top bar.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@comfy/shared';
import { AuthContext, type AuthState } from '../auth/context';
import { resetQueueStore } from '../lib/api-queue';
import { QueueChip } from './QueueChip';

const me: User = {
  id: 'user-1',
  email: 'steve@st3v3.com',
  displayName: 'Steve',
  role: 'user',
  createdAt: '2026-09-06T09:00:00.000Z',
};

const auth: AuthState = {
  status: 'authenticated',
  user: me,
  allowRegistration: false,
  signIn: async () => {},
  signUp: async () => {},
  signOut: async () => {},
};

function queueJob(id: string, userId: string, prompt?: string) {
  const job = {
    id,
    userId,
    kind: 'txt2img',
    status: 'queued',
    queuePosition: 0,
    backendId: null,
    progress: {
      step: null,
      totalSteps: null,
      frame: null,
      totalFrames: null,
      fraction: 0,
      etaSeconds: null,
      previewUrl: null,
    },
    error: null,
    createdAt: '2026-09-06T10:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    assets: [],
  };
  // A foreign job arrives with no `params` key at all — that absence is the
  // contract, so the fixture reproduces it rather than sending an empty object.
  return prompt === undefined
    ? job
    : {
        ...job,
        params: {
          kind: 'txt2img',
          prompt,
          modelId: 'model-1',
          quality: 'balanced',
          aspect: '1:1',
          batchSize: 1,
        },
      };
}

function stubQueue(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        ({
          status,
          ok: status >= 200 && status < 300,
          json: async () => body,
        }) as Response,
    ),
  );
}

function renderChip(depth: number) {
  return render(
    <AuthContext.Provider value={auth}>
      <QueueChip depth={depth} />
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  resetQueueStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('QueueChip', () => {
  it('shows what is waiting, and withholds other people’s prompts', async () => {
    stubQueue({
      running: {
        position: 0,
        ownerName: 'Ada',
        ownerId: 'user-2',
        job: queueJob('job-running', 'user-2'),
      },
      entries: [
        {
          position: 1,
          ownerName: 'Ada',
          ownerId: 'user-2',
          job: queueJob('job-2', 'user-2'),
        },
        {
          position: 2,
          ownerName: 'Steve',
          ownerId: 'user-1',
          job: queueJob('job-3', 'user-1', 'a lone figure on a rain-slick street'),
        },
      ],
    });

    const user = userEvent.setup();
    renderChip(0);

    const chip = await screen.findByRole('button', { name: /2 in queue/i });
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    await user.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'true');

    // Ours is shown in full, and named as ours.
    expect(screen.getByText('a lone figure on a rain-slick street')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();

    // Theirs is a person and a place in the line, and nothing else. The
    // rendered panel must not contain the word "undefined" anywhere.
    const panel = screen.getByRole('group', { name: /queue/i });
    expect(panel.textContent).not.toMatch(/undefined/i);
    expect(screen.getAllByText('Ada')).toHaveLength(2); // running + waiting
    expect(screen.getByText(/only your own prompts/i)).toBeInTheDocument();

    // Escape closes it again.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(chip).toHaveAttribute('aria-expanded', 'false'));
  });

  it('degrades to the backend count when the queue route does not exist', async () => {
    stubQueue({ error: 'Not Found' }, 404);

    renderChip(3);

    // Still a chip, still the right number, just not a button with a panel
    // behind it: there is nothing to reveal.
    expect(await screen.findByText('3 in queue')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /in queue/i })).not.toBeInTheDocument(),
    );
  });

  it('shows nothing at all when nothing is waiting', async () => {
    stubQueue({ entries: [], running: null });
    const { container } = renderChip(0);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
