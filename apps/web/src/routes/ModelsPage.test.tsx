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
 *  5. A card says whether the thing will actually run, and the "Will run here"
 *     filter narrows to those. This is the whole reason the screen is worth
 *     opening before a download rather than after one.
 *  6. An installed model that cannot run says why. Two video checkpoints sat in
 *     that list looking available while every job against them failed.
 *  7. The open tab survives a reload, because it is in the URL. It used to be
 *     component state, so every refresh dropped the operator back on Installed.
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
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import type { User } from '@comfy/shared';
import { AuthContext, type AuthState } from '../auth/context';
import { ApiRequestError } from '../lib/api';
import type { ModelsApi } from '../lib/api-models';
import {
  BACKEND_ID,
  installInState,
  makeBackend,
  makeModel,
  makeOption,
  makeRunnability,
  makeStubApi,
  makeTemplate,
  type StubOptions,
} from '../models/testing';
import type { StorageApi } from '../lib/api-storage';
import type { BackendStorage } from '@comfy/shared';
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

/**
 * Reports the query string, and offers a Back button.
 *
 * The tab lives in the URL, so "did switching tabs actually navigate" is a
 * question about the location rather than about the DOM — and pressing Back is
 * the behaviour that motivated putting it there.
 */
function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <span data-testid="search">{location.search}</span>
      <button type="button" onClick={() => navigate(-1)}>
        Go back
      </button>
    </>
  );
}

function renderPage(api: ModelsApi, user: User = admin, url = '/models', storageApi?: StorageApi) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      {withAuth(user, (
        <>
          <ModelsPage api={api} storageApi={storageApi} />
          <LocationProbe />
        </>
      ))}
    </MemoryRouter>,
  );
}

/** The query string as the address bar would show it. */
function search() {
  return screen.getByTestId('search').textContent;
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

    it('shows the preview and the verdict, and filters down to what will run', async () => {
      const api = makeStubApi();
      renderPage(api);
      await ready();
      const user = await openTab(/Discover/);

      const sdxl = await screen.findByRole('article', { name: 'SDXL Base 1.0' });
      // Same-origin, from our own API — never huggingface.co, which is the
      // whole point of caching these server-side.
      const image = within(sdxl).getByRole('presentation', { hidden: true });
      expect(image).toHaveAttribute('src', '/api/model-previews/2f2a1b0c9d8e7f6a5b4c');
      expect(within(sdxl).getByText('Will run')).toBeInTheDocument();
      expect(
        within(sdxl).getByText('An SDXL model, with a workflow written for it.'),
      ).toBeInTheDocument();
      expect(within(sdxl).getByText('openrail++')).toBeInTheDocument();
      // 1,767,210 downloads, in the width a card has for it.
      expect(within(sdxl).getByText('1.8M')).toBeInTheDocument();

      // One entry in the fixture runs; everything else is a support file, and
      // a support file is not offered as either working or broken.
      await user.click(screen.getByRole('button', { name: /Will run here/ }));
      await waitFor(() => expect(screen.getByText('1 / 100')).toBeInTheDocument());
      expect(screen.getByRole('article', { name: 'SDXL Base 1.0' })).toBeInTheDocument();
      expect(screen.queryByRole('article', { name: 'RealESRGAN x2' })).not.toBeInTheDocument();
    });

    it('opens the large rendition when the preview is clicked', async () => {
      // Most of these images are contact sheets; the card shows one at a size
      // where each sample is a thumbnail. The click is what makes them useful,
      // and it must fetch the *large* rendition, not blow up the card's.
      const api = makeStubApi();
      renderPage(api);
      await ready();
      const user = await openTab(/Discover/);

      const sdxl = await screen.findByRole('article', { name: 'SDXL Base 1.0' });
      await user.click(
        within(sdxl).getByRole('button', { name: /See the full-size preview of SDXL Base 1.0/ }),
      );

      const dialog = await screen.findByRole('dialog', { name: 'Preview of SDXL Base 1.0' });
      expect(within(dialog).getByRole('img')).toHaveAttribute(
        'src',
        '/api/model-previews/2f2a1b0c9d8e7f6a5b4c?full=1',
      );

      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('falls back to the family gradient when a preview will not load', async () => {
      const api = makeStubApi();
      renderPage(api);
      await ready();
      await openTab(/Discover/);

      const sdxl = await screen.findByRole('article', { name: 'SDXL Base 1.0' });
      const image = within(sdxl).getByRole('presentation', { hidden: true });
      // A cached preview can 404 — the row outlives the bytes if the table is
      // cleared. One failure, then the gradient, never a broken-image icon.
      act(() => {
        image.dispatchEvent(new Event('error'));
      });
      await waitFor(() =>
        expect(within(sdxl).queryByRole('presentation', { hidden: true })).not.toBeInTheDocument(),
      );
    });

  });

  describe('the preview fill-in poll', () => {
    beforeEach(() => {
      // As above: microtask-driven awaits and user-event keep working, while
      // the test still jumps the 6s fill-in interval by hand.
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('re-reads while the API is still resolving model pages', async () => {
      // Previews arrive a minute or so after the first read of a catalogue
      // nobody has looked at before. Rather than blocking a 372-card grid on
      // that, the screen paints what it has and fills in.
      const api = makeStubApi({ cataloguePending: 3 });
      renderPage(api);
      await ready();
      await openTab(/Discover/);
      await screen.findByRole('article', { name: 'SDXL Base 1.0' });

      const first = api.calls.filter((call) => call === 'catalogue').length;
      expect(first).toBeGreaterThan(0);

      await act(async () => vi.advanceTimersByTimeAsync(7_000));
      await waitFor(() =>
        expect(api.calls.filter((call) => call === 'catalogue').length).toBeGreaterThan(first),
      );
    });

    it('asks once and stops when there is nothing left to resolve', async () => {
      const api = makeStubApi({ cataloguePending: 0 });
      renderPage(api);
      await ready();
      await openTab(/Discover/);
      await screen.findByRole('article', { name: 'SDXL Base 1.0' });

      const first = api.calls.filter((call) => call === 'catalogue').length;
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(api.calls.filter((call) => call === 'catalogue').length).toBe(first);
    });
  });

  describe('a backend with nothing to offer', () => {
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

  describe('the installed list', () => {
    it('says why an installed model cannot actually be used', async () => {
      const ltx = makeModel({
        id: 'ltx',
        displayName: 'LTX-Video 2B',
        filename: 'ltx-video-2b-v0.9.1.safetensors',
        baseModel: 'ltx-video',
      });
      const api = makeStubApi({
        installed: {
          models: [ltx],
          families: ['ltx-video'],
          runnability: {
            ltx: makeRunnability({
              status: 'needs-companion',
              family: 'ltx-video',
              backendId: BACKEND_ID,
              summary: 'Needs another model first',
              detail:
                'The LTX-Video workflow also needs a T5 text encoder, "t5xxl_fp16.safetensors", which desktop-6900xt cannot load.',
              missing: [
                { filename: 't5xxl_fp16.safetensors', purpose: 'T5 text encoder', loader: 'CLIPLoader' },
              ],
            }),
          },
        },
      });
      renderPage(api);
      await ready();

      expect(await screen.findByText('LTX-Video 2B')).toBeInTheDocument();
      expect(screen.getByText('Needs another model')).toBeInTheDocument();
      // The API's own sentence, naming the file to go and get.
      expect(screen.getByText(/t5xxl_fp16\.safetensors/)).toBeInTheDocument();
    });

    it('leaves a model that works unbadged', async () => {
      const api = makeStubApi({
        installed: {
          models: [makeModel({ id: 'sdxl' })],
          families: ['sdxl'],
          runnability: { sdxl: makeRunnability({ status: 'ready', summary: 'Will run' }) },
        },
      });
      renderPage(api);
      await ready();

      expect(await screen.findByText('Sd Xl Base 1.0')).toBeInTheDocument();
      // No badge on a healthy row: with one on every row the two that matter
      // would have nowhere to stand out.
      expect(screen.queryByText('Will run')).not.toBeInTheDocument();
    });
  });

  describe('which tab is open', () => {
    it('opens the tab named in the URL, so a reload keeps your place', async () => {
      const api = makeStubApi();
      renderPage(api, admin, '/models?tab=discover');
      await ready();

      // Straight into Discover: no click, and the admin-only catalogue was
      // fetched, which only happens on that tab.
      expect(await screen.findByLabelText('Search the catalogue')).toBeInTheDocument();
      expect(api.calls).toContain('catalogue');
    });

    it('puts the tab in the URL when you switch, and takes it out again', async () => {
      const api = makeStubApi();
      renderPage(api);
      await ready();
      expect(search()).toBe('');

      const user = await openTab(/Discover/);
      await waitFor(() => expect(search()).toBe('?tab=discover'));

      await user.click(screen.getByRole('button', { name: /Downloads/ }));
      await waitFor(() => expect(search()).toBe('?tab=downloads'));

      // Installed is the default, and is spelled by the absence of the
      // parameter — `/models` stays a clean URL.
      await user.click(screen.getByRole('button', { name: /Installed/ }));
      await waitFor(() => expect(search()).toBe(''));
    });

    it('steps back through the tabs with the browser Back button', async () => {
      const api = makeStubApi();
      renderPage(api);
      await ready();

      const user = await openTab(/Discover/);
      await waitFor(() => expect(search()).toBe('?tab=discover'));

      await user.click(screen.getByRole('button', { name: 'Go back' }));
      await waitFor(() => expect(search()).toBe(''));
      // And the screen followed the URL, not the other way round.
      expect(screen.queryByLabelText('Search the catalogue')).not.toBeInTheDocument();
    });

    it('falls back to Installed for a tab nobody has ever heard of', async () => {
      const api = makeStubApi();
      renderPage(api, admin, '/models?tab=nonsense');
      await ready();

      expect(screen.queryByLabelText('Search the catalogue')).not.toBeInTheDocument();
      expect(await screen.findByLabelText('Search installed models')).toBeInTheDocument();
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

  describe('storage', () => {
    const JOB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const listing = (): BackendStorage => ({
      helper: 'ok',
      input: {
        totalBytes: 3_000_000,
        files: [
          {
            path: '0123456789abcdef0123456789abcdef.png',
            size: 2_000_000,
            modifiedAt: '2026-09-06T10:00:00Z',
            owner: { id: 'u-steve', email: 'steve@st3v3.com', displayName: 'Steve' },
            uploadId: 'up-1',
          },
          { path: 'probe.png', size: 1_000_000, modifiedAt: '2026-09-01T10:00:00Z', owner: null },
        ],
      },
      output: {
        totalBytes: 5_000_000,
        files: [
          {
            path: `image/${JOB}/ComfyUI_00001_.png`,
            size: 5_000_000,
            modifiedAt: '2026-09-06T11:00:00Z',
            owner: { id: 'u-bob', email: 'bob@example.com', displayName: null },
            jobId: JOB,
            assetId: 'asset-1',
          },
        ],
      },
    });

    function stubStorage(data: BackendStorage, opts: { removeError?: Error } = {}) {
      const removed: Array<{ folder: string; paths: string[] }> = [];
      const api: StorageApi & { removed: typeof removed } = {
        removed,
        list: async () => data,
        remove: async (_id, folder, paths) => {
          removed.push({ folder, paths });
          if (opts.removeError) throw opts.removeError;
          return { deleted: paths, missing: [] };
        },
      };
      return api;
    }

    it('is not offered to a non-admin at all', async () => {
      renderPage(makeStubApi(), { ...admin, role: 'user' }, '/models', stubStorage(listing()));
      await ready();
      expect(screen.queryByRole('button', { name: /Storage/ })).not.toBeInTheDocument();
    });

    it('lists both folders by owner, with the untracked pile last', async () => {
      renderPage(makeStubApi(), admin, '/models', stubStorage(listing()));
      await ready();
      await openTab(/Storage/);

      const inputs = await screen.findByRole('region', { name: 'Inputs' });
      expect(within(inputs).getByText('Steve')).toBeInTheDocument();
      expect(within(inputs).getByText('Not tracked by rippel')).toBeInTheDocument();
      expect(within(inputs).getByText('2 files · 3.0 MB')).toBeInTheDocument();

      const outputs = screen.getByRole('region', { name: 'Outputs' });
      expect(within(outputs).getByText('bob@example.com')).toBeInTheDocument();
      expect(within(outputs).getByRole('link', { name: 'in library' })).toBeInTheDocument();
    });

    it('removes a selection only on the second press, and drops the rows', async () => {
      const storage = stubStorage(listing());
      renderPage(makeStubApi(), admin, '/models', storage);
      await ready();
      const user = await openTab(/Storage/);

      const inputs = await screen.findByRole('region', { name: 'Inputs' });
      await user.click(within(inputs).getByLabelText('Select probe.png'));

      const remove = within(inputs).getByRole('button', { name: /^Remove 1 file from desktop-6900xt/ });
      await user.click(remove);
      // Armed, not done: nothing has been sent yet.
      expect(storage.removed).toHaveLength(0);
      await user.click(within(inputs).getByRole('button', { name: /^Confirm: remove 1 file/ }));

      await waitFor(() => expect(storage.removed).toEqual([{ folder: 'input', paths: ['probe.png'] }]));
      expect(within(inputs).queryByText('probe.png')).not.toBeInTheDocument();
      expect(within(inputs).getByText('1 file · 2.0 MB')).toBeInTheDocument();
    });

    it('puts the rows back and says so when the helper refuses', async () => {
      const storage = stubStorage(listing(), { removeError: new ApiRequestError(502, 'helper_offline', 'The backend did not answer.') });
      renderPage(makeStubApi(), admin, '/models', storage);
      await ready();
      const user = await openTab(/Storage/);

      const inputs = await screen.findByRole('region', { name: 'Inputs' });
      await user.click(within(inputs).getByLabelText("Select all of Steve’s inputs"));
      await user.click(within(inputs).getByRole('button', { name: /^Remove 1 file/ }));
      await user.click(within(inputs).getByRole('button', { name: /^Confirm/ }));

      expect(await screen.findByRole('status')).toHaveTextContent('The backend did not answer.');
      expect(within(inputs).getByText('0123456789abcdef0123456789abcdef.png')).toBeInTheDocument();
    });

    it('explains the install when the helper is missing', async () => {
      const empty = { totalBytes: 0, files: [] };
      renderPage(makeStubApi(), admin, '/models', stubStorage({ helper: 'missing', input: empty, output: empty }));
      await ready();
      await openTab(/Storage/);

      expect(
        await screen.findByRole('heading', { name: /storage helper is not installed on desktop-6900xt/ }),
      ).toBeInTheDocument();
      expect(screen.getByText('tools/comfyui-rippel-storage')).toBeInTheDocument();
      expect(screen.getByText('RIPPEL_STORAGE_TOKEN')).toBeInTheDocument();
    });
  });

  describe('workflows per model', () => {
    const ltx = makeModel({
      id: 'ltx',
      displayName: 'LTX-Video 2B',
      filename: 'ltx-video-2b-v0.9.1.safetensors',
      baseModel: 'ltx-video',
    });
    const dm = makeTemplate({
      id: 'txt2vid-ltxv-dm',
      label: 'Text to video (LTX-Video, diffusion_models)',
      capability: 'txt2vid',
      baseModels: ['ltx-video', 'ltxv'],
      loaderFolder: 'diffusion_models',
      loaderFolders: ['diffusion_models', 'text_encoders', 'vae'],
      requires: [
        { id: 'text-encoder', label: 'T5 text encoder', modelType: 'clip', why: 'x' },
        { id: 'vae', label: 'LTX-Video VAE', modelType: 'vae', why: 'y' },
      ],
      description: 'Makes a clip from a prompt on a graph written for ltx-video, loading the model from diffusion_models/.',
    });
    const ckpt = makeTemplate({
      id: 'txt2vid-ltxv',
      label: 'Text to video (LTX-Video)',
      capability: 'txt2vid',
      baseModels: ['ltx-video', 'ltxv'],
      description: 'Makes a clip from a prompt on a graph written for ltx-video, loading the model from checkpoints/.',
    });
    const workflows = () => ({
      ltx: {
        model: { id: 'ltx', displayName: 'LTX-Video 2B', filename: 'ltx-video-2b-v0.9.1.safetensors', family: 'ltx-video', folder: 'diffusion_models' },
        backend: { id: BACKEND_ID, name: 'desktop-6900xt' },
        assigned: {},
        options: [
          makeOption(ckpt, { status: 'wrong-folder', summary: 'On disk, but the workflow cannot see it', detail: 'It is in "diffusion_models", but the workflow loads it from "checkpoints" — it needs moving there, not downloading again.' }),
          makeOption(dm, { status: 'needs-companion', summary: 'Needs another model first', detail: 'Also needs a T5 text encoder, t5xxl_fp16.safetensors and 1 other file, which desktop-6900xt does not have.' }, { automatic: true }),
        ],
      },
    });
    const installed = { models: [ltx], families: ['ltx-video'], runnability: {} };

    it('opens the sheet from a row, and judges each template on its own', async () => {
      const api = makeStubApi({ installed, workflows: workflows() });
      renderPage(api);
      await ready();
      const user = await openTab(/Workflows for LTX-Video 2B/);

      const sheet = await screen.findByRole('dialog', { name: 'Workflows for LTX-Video 2B' });
      expect(within(sheet).getByText('Text to video (LTX-Video, diffusion_models)')).toBeInTheDocument();
      // The two graphs disagree about the same file, and both verdicts show.
      expect(within(sheet).getByText('Wrong folder')).toBeInTheDocument();
      expect(within(sheet).getByText('Needs another model')).toBeInTheDocument();
      expect(within(sheet).getByText('automatic')).toBeInTheDocument();
      expect(
        within(sheet).getByText(
          (_, element) => element?.tagName === 'P' && /is in diffusion_models\/ on desktop-6900xt/.test(element.textContent ?? ''),
        ),
      ).toHaveTextContent('is in diffusion_models/');
      expect(api.calls).toContain(`workflows:ltx:${BACKEND_ID}`);

      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('lets an administrator pin a template and go back to automatic', async () => {
      const api = makeStubApi({ installed, workflows: workflows() });
      renderPage(api);
      await ready();
      const user = await openTab(/Workflows for LTX-Video 2B/);
      const sheet = await screen.findByRole('dialog', { name: 'Workflows for LTX-Video 2B' });

      await user.click(within(sheet).getByRole('radio', { name: 'Pin Text to video (LTX-Video)' }));
      await waitFor(() => expect(api.calls).toContain('assign:ltx:txt2vid:txt2vid-ltxv'));
      expect(await within(sheet).findByText('pinned')).toBeInTheDocument();
      expect(within(sheet).getByText('Pinned by an administrator')).toBeInTheDocument();

      await user.click(within(sheet).getByRole('button', { name: 'Use automatic' }));
      await waitFor(() => expect(api.calls).toContain('assign:ltx:txt2vid:auto'));
      expect(await within(sheet).findByText('Chosen automatically')).toBeInTheDocument();
    });

    /**
     * The bug the owner hit: he assigned a workflow to `Hyper SD15 1step LoRA`,
     * the sheet badged it PINNED, and the Create screen never listed it —
     * because a LoRA is not a model you generate with and never could be. The
     * sheet now explains instead of offering a choice that does nothing, and
     * the row that opens it does not say "Workflows" either.
     */
    it('explains a support file instead of offering it a workflow', async () => {
      const lora = makeModel({
        id: 'hyper',
        type: 'lora',
        displayName: 'Hyper SD15 1step LoRA',
        filename: 'Hyper-SD15-1step-lora.safetensors',
        baseModel: 'sd1.5',
      });
      const api = makeStubApi({
        installed: { models: [lora], families: ['sd1.5'], runnability: {} },
        workflows: workflows(),
      });
      renderPage(api);
      await ready();

      // The row does not promise a workflow it cannot deliver.
      expect(
        screen.queryByRole('button', { name: 'Workflows for Hyper SD15 1step LoRA' }),
      ).not.toBeInTheDocument();
      await openTab(/What Hyper SD15 1step LoRA is for/);

      const sheet = await screen.findByRole('dialog', { name: 'About Hyper SD15 1step LoRA' });
      // Plain words about what it is and where it is used — not "LoRA" alone.
      expect(within(sheet).getByText('Extra style')).toBeInTheDocument();
      expect(within(sheet).getByText(/Extra styles, on the Create screen/)).toBeInTheDocument();
      expect(within(sheet).getByText(/There is no workflow to choose here/)).toBeInTheDocument();
      // No selectable list, and nothing was ever assigned.
      expect(within(sheet).queryByRole('radio')).not.toBeInTheDocument();
      expect(api.calls.filter((call) => call.startsWith('assign:'))).toEqual([]);
      expect(api.calls.filter((call) => call.startsWith('workflows:'))).toEqual([]);
    });

    it('splits the installed list into what generates and what supports', async () => {
      const lora = makeModel({ id: 'hyper', type: 'lora', displayName: 'Hyper SD15 1step LoRA', filename: 'h.safetensors', baseModel: 'sd1.5' });
      const api = makeStubApi({
        installed: { models: [ltx, lora], families: ['ltx-video', 'sd1.5'], runnability: {} },
        workflows: workflows(),
      });
      renderPage(api);
      await ready();

      const generators = screen.getByRole('region', { name: 'Models you can generate with' });
      const support = screen.getByRole('region', { name: 'Support files' });
      expect(within(generators).getByText('LTX-Video 2B')).toBeInTheDocument();
      expect(within(support).getByText('Hyper SD15 1step LoRA')).toBeInTheDocument();
      // Nothing is hidden: both are still counted on the tab.
      expect(screen.getByRole('button', { name: /Installed\s*2/ })).toBeInTheDocument();
    });

    it('offers no pinning to a non-admin', async () => {
      const api = makeStubApi({ installed, workflows: workflows() });
      renderPage(api, { ...admin, role: 'user' });
      await ready();
      await openTab(/Workflows for LTX-Video 2B/);
      const sheet = await screen.findByRole('dialog', { name: 'Workflows for LTX-Video 2B' });
      expect(within(sheet).queryByRole('radio')).not.toBeInTheDocument();
      expect(within(sheet).getByText(/Only an administrator can pin/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Remove LTX-Video 2B$/ })).not.toBeInTheDocument();
    });

    it('removes a model in two steps and repeats what the API said about the file', async () => {
      const api = makeStubApi({ installed, workflows: workflows() });
      renderPage(api);
      await ready();
      const user = await openTab(/^Remove LTX-Video 2B$/);
      // Not yet: the first press only arms the confirm.
      expect(api.calls.filter((call) => call.startsWith('remove:'))).toEqual([]);
      await user.click(screen.getByRole('button', { name: 'Confirm' }));

      await waitFor(() => expect(api.calls).toContain('remove:ltx'));
      await waitFor(() => expect(screen.queryByText('LTX-Video 2B')).not.toBeInTheDocument());
      expect(await screen.findByRole('status')).toHaveTextContent('the file is still on desktop-6900xt');
    });

    it('browses every template from the Installed panel', async () => {
      const api = makeStubApi({ installed, workflows: workflows(), templates: [ckpt, dm] });
      renderPage(api);
      await ready();
      await openTab(/Browse templates/);
      const sheet = await screen.findByRole('dialog', { name: 'Workflow templates' });
      expect(await within(sheet).findByText('Text to video (LTX-Video)')).toBeInTheDocument();
      expect(within(sheet).getByText('diffusion_models/ text_encoders/ vae/')).toBeInTheDocument();
      expect(within(sheet).getByText('T5 text encoder, LTX-Video VAE')).toBeInTheDocument();
    });
  });

  describe('the pickers that used to be native selects', () => {
    it('switches backend from the header picker, by keyboard alone', async () => {
      const api = makeStubApi({
        backends: [
          makeBackend(),
          makeBackend({ id: 'backend-2', name: 'studio-4090', status: 'offline' }),
        ],
      });
      renderPage(api);
      await ready();

      const picker = screen.getByRole('combobox', { name: /installing to|highlighting|files on/i });
      expect(picker).toHaveTextContent('desktop-6900xt');

      picker.focus();
      const user = userEvent.setup();
      await user.keyboard('{Enter}');
      // The offline one is still offered, and still says so.
      expect(screen.getByRole('option', { name: /studio-4090 \(offline\)/ })).toBeInTheDocument();

      await user.keyboard('{ArrowDown}{Enter}');
      expect(picker).toHaveTextContent('studio-4090');
      expect(picker).toHaveFocus();
    });

    it('filters the catalogue by family, and gives "All" back again', async () => {
      const api = makeStubApi();
      renderPage(api);
      await ready();
      const user = await openTab(/Discover/);

      const family = screen.getByRole('combobox', { name: /base/i });
      expect(family).toHaveTextContent('All');

      await user.click(family);
      const options = screen.getAllByRole('option');
      // "All" is a real option, not a blank first row.
      expect(options[0]).toHaveTextContent('All');
      expect(options.length).toBeGreaterThan(1);

      await user.click(options[1]!);
      expect(family).not.toHaveTextContent('All');

      // And back: the empty value still reaches the parent as "no filter".
      await user.click(family);
      await user.click(screen.getByRole('option', { name: 'All' }));
      expect(family).toHaveTextContent('All');
    });
  });

});
