/**
 * What a failed request says to a person: the server's words when they are
 * specific, a plain line tied to the action when they are not, and never a
 * bare HTTP status phrase.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, NO_ANSWER, UNREACHABLE, errorLine, request } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('ApiRequestError', () => {
  it('keeps a specific server message', () => {
    const error = new ApiRequestError(400, 'too_large', 'That file is too large.');
    expect(error.message).toBe('That file is too large.');
    expect(error.generic).toBe(false);
  });

  it.each(['Unsupported Media Type', 'Unsupported Media Type: application/json', 'Bad Gateway', 'Internal Server Error', 'undefined', '', 'Something went wrong.'])(
    'never shows %j',
    (raw) => {
      const error = new ApiRequestError(415, 'Unsupported Media Type', raw);
      expect(error.message).toBe('Something went wrong. Try again.');
      expect(error.generic).toBe(true);
      expect(error.detail).toContain('415');
    },
  );

  it('says the server did not answer for a bare 502, 503 or 504', () => {
    for (const status of [502, 503, 504]) expect(new ApiRequestError(status, 'error', 'Bad Gateway').message).toBe(NO_ANSWER);
    // A 502 the API itself sent with a reason keeps the reason.
    expect(new ApiRequestError(502, 'helper_offline', 'The backend did not answer.').message).toBe('The backend did not answer.');
  });

  it('says the connection failed when nothing came back', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(request('/x')).rejects.toMatchObject({ status: 0, message: UNREACHABLE });
  });

  it('maps a raw Fastify 415 body to a line about the action', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ statusCode: 415, error: 'Unsupported Media Type', message: 'Unsupported Media Type' }, { status: 415 })));
    const cause = await request('/x', { method: 'POST' }).catch((e: unknown) => e);
    expect(errorLine(cause, 'test the agent')).toBe('Couldn’t test the agent. Try again.');
    expect((cause as ApiRequestError).detail).toBe('HTTP 415 Unsupported Media Type');
  });
});

describe('errorLine', () => {
  it('prefers specific words, and falls back to the action', () => {
    expect(errorLine(new ApiRequestError(409, 'busy', 'steve-pc is busy installing.'), 'test the agent')).toBe('steve-pc is busy installing.');
    expect(errorLine(new Error('undefined'), 'save')).toBe('Couldn’t save. Try again.');
    expect(errorLine('nope', 'save')).toBe('Couldn’t save. Try again.');
    expect(errorLine(new ApiRequestError(0, 'unreachable', ''), 'save')).toBe(UNREACHABLE);
  });
});
