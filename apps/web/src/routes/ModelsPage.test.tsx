/**
 * Tests for the things on this screen that are expensive to get wrong.
 *
 * Not "does it render" — the four cases below are the ones that would ship
 * broken and only be discovered by an operator staring at a stock ComfyUI or a
 * seven-gigabyte download:
 *
 *  1. A backend with no transport answers 501, and its message names the fix.
 *     Swallowing that into "something went wrong" is the single most damaging
 *     thing this screen could do, because the 501 *is* the answer.
 *  2. An install advances queued -> downloading -> complete by polling. There
 *     is no WebSocket for installs; if the poll loop is wrong the UI simply
 *     lies for the next twenty minutes.
 *  3. An install already running when the page mounts is adopted. Downloads
 *     outlive the page, and a screen that assumed it started everything it can
 *     see would show "no downloads" over a live one.
 *  4. The catalogue filter narrows 100 entries, because it is the only way to
 *     use a 372-entry list at all.
 *
 * Plus the admin gate, since every install route 403s for a non-admin.
 *
 * No real install is ever started: everything runs against the stub in
 * models/testing.ts.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import type { User } from '@comfy/shared';
import { AuthContext, type AuthState } from '../auth/context';
import { ApiRequestError } from '../lib/api';
import type { ModelsApi } from '../lib/api-models';
import {
  installInState,
  makeBackend,
  makeStubApi,
  type StubOptions,
} from '../models/testing';
import { ModelsPage } from './ModelsPage';

const admin: User = {
  id: 'e766567c-482c-4a79-b892-9f2c7acc2d29',
  email: 'steve@st3v3.com',
  displayName: 'Steve',
  role: 'admin',
  createdAt: '2026-09-06T07:46:43.332Z',
};

function withAuth(user: User, children: ReactNode) {
  const value: AuthState = {
    status: 'authenticated',
    user,
    allowRegistration: false,
    signIn: async () => {},
    signUp: async () => {},
    signOut: async () => {},
  };
  return <AuthContext value={value}>{children}</AuthContext>;
}

function renderPage(api: ModelsApi, user: User = admin) {
  return render(withAuth(user, <ModelsPage api={api} />));
}

/** Wait for the initial backends+models load to land. */
async function ready() {
  await screen.findByRole('button', { name: /Installed/ });
  await waitFor(() =>
    expect(screen.queryByText('Reading your backends…')).not.toBeInTheDocument(),
  );
}

async function openTab(name: RegExp) {
  const user = userEvent.setup({
    // Only some of these tests run on fake timers; user-event has to be told
    // which, or it hangs on the ones that do.
    advanceTimers: (ms) => {
      if (vi.isFakeTimers()) vi.advanceTimersByTime(ms);
    },
  });
  await user.click(screen.getByRole('button', { name }));
  return user;
}

describe('ModelsPage', () => {
  describe('a backend with no install transport', () => {
    it('renders the API’s 501 message rather than an empty catalogue', async () => {
      const message =
        'This backend cannot install models: ComfyUI-Manager is not responding on it. ' +
        'Install ComfyUI-Manager into the backend’s custom_nodes and restart ComfyUI.';
      const api = makeStubApi({
        catalogueError: new ApiRequestError(501, 'not_implemented', message),
      });

      renderPage(api);
      await ready();
      await openTab(/Discover/);

      // Verbatim: it names the fix, and a paraphrase would lose it.
      expect(await screen.findByText(message)).toBeInTheDocument();
      expect(
        screen.getByRole('heading', { name: 'This backend cannot install models' }),
      ).toBeInTheDocument();
      // And it must not read as "there is nothing here".
      expect(screen.queryByLabelText('Search the catalogue')).not.toBeInTheDocument();
    });

    it('still lists what that backend already holds', async () => {
      const api = makeStubApi({
        catalogueError: new ApiRequestError(501, 'not_implemented', 'no transport'),
      });
      renderPage(api);
      await ready();

      // /api/models is requireAuth and independent of any transport.
      expect(await screen.findByText('Sd Xl Base 1.0')).toBeInTheDocument();
      expect(screen.getAllByText('desktop-6900xt').length).toBeGreaterThan(0);
    });
  });

  describe('installs', () => {
    beforeEach(() => {
      // `shouldAdvanceTime` keeps microtask-driven awaits and user-event working
      // while still letting the test jump the poll interval by hand.
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('polls an install through queued → downloading → complete', async () => {
      const options: StubOptions = {
        statusScript: [
          { status: 'downloading', detail: 'Downloading (1/1 in progress)', startedAt: '2026-09-06T08:28:07.594Z' },
          { status: 'complete', detail: 'Installed and visible to ComfyUI', finishedAt: '2026-09-06T08:29:37.604Z' },
        ],
      };
      const api = makeStubApi(options);

      renderPage(api);
      await ready();
      const user = await openTab(/Discover/);

      // Narrow to the one entry we mean; the grid is 100 cards.
      await user.type(screen.getByLabelText('Search the catalogue'), 'Cinematic');
      const card = await screen.findByRole('article', { name: 'Cinematic Film Look' });
      await user.click(within(card).getByRole('button', { name: /Install/ }));

      // Accepted, and shown immediately rather than on the next poll.
      expect(await within(card).findByText('Queued')).toBeInTheDocument();

      // Wrapped so the state updates the poll causes land inside React's act.
      await act(async () => vi.advanceTimersByTimeAsync(3_000));
      await waitFor(() => expect(within(card).getByText('Downloading')).toBeInTheDocument());
      expect(within(card).getByText('Downloading (1/1 in progress)')).toBeInTheDocument();

      // No fabricated percentage anywhere — the bar is indeterminate.
      const bar = within(card).getByRole('progressbar');
      expect(bar).not.toHaveAttribute('aria-valuenow');
      expect(bar).toHaveAttribute('aria-valuetext', 'Downloading (1/1 in progress)');

      // Wrapped so the state updates the poll causes land inside React's act.
      await act(async () => vi.advanceTimersByTimeAsync(3_000));
      await waitFor(() => expect(within(card).getByText('Installed')).toBeInTheDocument());
      expect(within(card).queryByRole('progressbar')).not.toBeInTheDocument();
    });

    it('adopts an install that was already running when the page mounted', async () => {
      const running = installInState('downloading', 'Downloading (1/1 in progress)');
      const api = makeStubApi({ activeInstalls: [running] });

      renderPage(api);
      await ready();
      await openTab(/Downloads/);

      // Nothing on this page started it; it came from GET /api/model-installs.
      expect(await screen.findByText('SDXL Base 1.0')).toBeInTheDocument();
      expect(screen.getByText('Downloading (1/1 in progress)')).toBeInTheDocument();
      expect(api.calls).toContain('active');

      // And the header count says something is in flight.
      expect(screen.getByRole('button', { name: /Downloads/ })).toHaveTextContent('1');
    });

    it('shows a failed install with the transport’s own error', async () => {
      const failed = installInState('failed', null);
      failed.error = 'ComfyUI-Manager refused the install: security level too high.';
      const api = makeStubApi({ activeInstalls: [], history: [failed] });

      renderPage(api);
      await ready();
      await openTab(/Downloads/);

      expect(await screen.findByText('Failed')).toBeInTheDocument();
      expect(
        screen.getByText('ComfyUI-Manager refused the install: security level too high.'),
      ).toBeInTheDocument();
    });
  });

  describe('the catalogue browser', () => {
    it('filters by text and by type, and never offers a re-install', async () => {
      const api = makeStubApi();
      renderPage(api);
      await ready();
      const user = await openTab(/Discover/);

      const search = await screen.findByLabelText('Search the catalogue');
      // 100 entries, but the grid pages rather than painting them all at once.
      expect(screen.getByText('48 of 100')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Show 48 more' })).toBeInTheDocument();

      await user.type(search, 'halation');
      // Matched on the description, which is where the useful words live.
      await waitFor(() => expect(screen.getByText('1 / 100')).toBeInTheDocument());
      expect(screen.getByRole('article', { name: 'Cinematic Film Look' })).toBeInTheDocument();
      expect(screen.queryByRole('article', { name: 'RealESRGAN x2' })).not.toBeInTheDocument();

      await user.clear(search);
      await user.click(screen.getByRole('button', { name: /^VAE/ }));
      await waitFor(() =>
        expect(screen.getByRole('article', { name: 'FLUX VAE' })).toBeInTheDocument(),
      );
      expect(screen.queryByRole('article', { name: 'Cinematic Film Look' })).not.toBeInTheDocument();

      // An installed entry is marked and has no install button: the API
      // answers 409 to a re-install, so offering the click would be a lie.
      await user.click(screen.getByRole('button', { name: /^Checkpoint/ }));
      const installed = await screen.findByRole('article', { name: 'SDXL Base 1.0' });
      expect(within(installed).getByText('Installed')).toBeInTheDocument();
      expect(within(installed).queryByRole('button', { name: /Install/ })).not.toBeInTheDocument();
    });

    it('says so when a backend’s catalogue is empty', async () => {
      const api = makeStubApi({ entries: [] });
      renderPage(api);
      await ready();
      await openTab(/Discover/);

      expect(
        await screen.findByRole('heading', { name: 'This backend offers nothing to install' }),
      ).toBeInTheDocument();
    });
  });

  describe('permissions and backend state', () => {
    it('tells a non-admin they need to be an admin instead of failing', async () => {
      const api = makeStubApi();
      renderPage(api, { ...admin, role: 'user' });
      await ready();
      await openTab(/Discover/);

      expect(
        await screen.findByRole('heading', { name: 'You need to be an administrator' }),
      ).toBeInTheDocument();
      // The admin-only routes are never called for them.
      expect(api.calls).not.toContain('catalogue');
      expect(api.calls).not.toContain('active');
    });

    it('does not interrogate an offline backend, and says why', async () => {
      const api = makeStubApi({ backends: [makeBackend({ status: 'offline' })] });
      renderPage(api);
      await ready();
      await openTab(/Discover/);

      expect(await screen.findByRole('heading', { name: 'Backend is offline' })).toBeInTheDocument();
      expect(api.calls).not.toContain('catalogue');
    });
  });
});
