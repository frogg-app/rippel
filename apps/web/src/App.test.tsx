import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';

/**
 * One end-to-end-ish test through the pieces that have to agree with each
 * other: the api client's cookie handling, the auth provider's boot round trip,
 * the route guard, and the shell that appears once you are in. Stubbing at
 * `fetch` rather than at the client means the URLs and methods are asserted
 * too — which is the point of having a single fetch site.
 */
function stubApi(routes: Record<string, () => Response>) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const key = `${init?.method ?? 'GET'} ${url}`;
    const handler = routes[key];
    if (!handler) throw new Error(`unexpected request: ${key}`);
    return Promise.resolve(handler());
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const user = { id: 'u1', email: 'steve@st3v3.com', displayName: null, role: 'user', createdAt: '' };

beforeEach(() => {
  window.history.pushState({}, '', '/create');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('sends an anonymous visitor to the sign-in screen', async () => {
    stubApi({
      'GET /api/auth/me': () => json({ error: 'unauthorized', message: 'Not signed in.' }, 401),
      'GET /api/auth/config': () => json({ allowRegistration: true }),
    });

    render(<App />);

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create an account' })).toBeInTheDocument();
  });

  it('signs in and hands over to the shell, cookies attached', async () => {
    const fetchMock = stubApi({
      'GET /api/auth/me': () => json({ error: 'unauthorized', message: 'Not signed in.' }, 401),
      'GET /api/auth/config': () => json({ allowRegistration: false }),
      'POST /api/auth/login': () => json({ user }),
      'GET /api/backends': () =>
        json({
          backends: [
            {
              id: 'b1',
              name: 'desktop-4090',
              baseUrl: '',
              enabled: true,
              status: 'online',
              deviceName: null,
              vramFree: null,
              vramTotal: null,
              ramFree: null,
              ramTotal: null,
              vramLimitMb: null,
              lastSeenAt: null,
              queueDepth: 2,
            },
          ],
        }),
    });

    render(<App />);

    await userEvent.type(await screen.findByLabelText('Email'), user.email);
    await userEvent.type(screen.getByLabelText('Password'), 'a-long-enough-password');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    // The shell, with the chrome PLAN.md §6 says is on every screen.
    expect(await screen.findByText('desktop-4090')).toBeInTheDocument();
    expect(screen.getByText('2 in queue')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create' })).toBeInTheDocument();

    const [, init] = fetchMock.mock.calls.find(([url]) => String(url) === '/api/auth/login') ?? [];
    expect(init?.credentials).toBe('include');
  });

  it("shows the API's own message when sign-in fails", async () => {
    stubApi({
      'GET /api/auth/me': () => json({ error: 'unauthorized', message: 'Not signed in.' }, 401),
      'GET /api/auth/config': () => json({ allowRegistration: false }),
      'POST /api/auth/login': () =>
        json({ error: 'invalid_credentials', message: 'That email or password is not right.' }, 401),
    });

    render(<App />);

    await userEvent.type(await screen.findByLabelText('Email'), 'nobody@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong-password-here');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('That email or password is not right.'),
    );
  });
});
