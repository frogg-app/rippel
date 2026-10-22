import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { CatalogueCard } from './CatalogueCard';
import { makeEntry } from './testing';
it('shows discovered gated models in the existing grid without an install button', () => {
  render(<CatalogueCard entry={makeEntry({ name: 'krea/Krea-2-Turbo', ref: 'hugging-face:krea/Krea-2-Turbo', reference: null, info: null, installBlockedReason: 'Access required on Hugging Face.' })} install={null} starting={false} canInstall onInstall={vi.fn()} failure={null} now={Date.now()} />);
  expect(screen.getByRole('heading', { name: 'Krea-2-Turbo' })).toBeInTheDocument();
  expect(screen.getByText('Access required on Hugging Face.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();
});
