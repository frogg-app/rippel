/**
 * A smoke test over the whole screen.
 *
 * The hook tests cover the logic that is expensive to get wrong; this covers
 * the thing that is cheap to get wrong and embarrassing to ship — the page not
 * rendering at all. It matters more than usual here because the route is not
 * registered in `App.tsx` yet (that happens at merge), so nothing else in the
 * suite would ever mount this component.
 *
 * It stubs `libraryApi` explicitly rather than leaning on the dev fixture
 * flag. The flag now defaults to off — the real endpoints exist — and a test
 * that depends on which implementation happens to be wired is a test that
 * breaks for reasons unrelated to the screen.
 */
import { describe, expect, it, vi } from 'vitest';


vi.mock('../lib/api-library', async () => {
  const actual = await vi.importActual<typeof import('../lib/api-library')>('../lib/api-library');
  const { mockLibrary: fixture } = await import('../library/mock');
  return { ...actual, libraryApi: fixture, usingMockLibrary: true };
});
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { LibraryPage } from './LibraryPage';

function renderPage() {
  return render(
    <MemoryRouter>
      <LibraryPage />
    </MemoryRouter>,
  );
}

describe('LibraryPage', () => {
  it('paints the toolbar, the rail and a grid of tiles', async () => {
    renderPage();

    expect(screen.getByRole('heading', { name: 'Library' })).toBeInTheDocument();
    expect(screen.getByLabelText('Search your prompts')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Collections' })).toBeInTheDocument();

    // Tiles are named by their prompt — the thumbnail itself is decorative
    // next to that, so it carries an empty alt and is not queried for here.
    const tiles = await screen.findAllByRole('button', { name: /rain-slick street/ });
    expect(tiles.length).toBeGreaterThan(0);
  });

  it('opens the detail drawer on a tile, with the prompt and a copyable seed', async () => {
    const user = userEvent.setup();
    renderPage();

    // By prompt, not by `pressed: false` — the toolbar's segmented control is
    // made of aria-pressed buttons too and would match first.
    const [tile] = await screen.findAllByRole('button', { name: /rain-slick street/ });
    await user.click(tile!);

    const drawer = await screen.findByRole('complementary', { name: 'Asset details' });
    expect(drawer).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('Prompt')).toBeInTheDocument());
    expect(screen.getByLabelText('Copy prompt')).toBeInTheDocument();
    expect(screen.getByLabelText('Copy seed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Remix/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Re-run/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download/ })).toBeInTheDocument();
  });
});
