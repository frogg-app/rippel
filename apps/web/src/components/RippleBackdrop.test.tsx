import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { RippleBackdrop } from './RippleBackdrop';

describe('RippleBackdrop', () => {
  afterEach(() => vi.restoreAllMocks());

  // StrictMode runs the effect twice on one canvas. The second run must reuse
  // the first's context: a canvas never hands out a fresh one, and the old
  // cleanup lost it, which Chromium paints as a white box over the login page.
  it('makes its context once per canvas, even under StrictMode', () => {
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(() => null);
    const { unmount } = render(
      <StrictMode>
        <RippleBackdrop />
      </StrictMode>,
    );
    unmount();
    const kinds = getContext.mock.calls.map((call) => call[0]);
    expect(kinds.filter((kind) => kind === 'webgl')).toHaveLength(1);
  });
});
