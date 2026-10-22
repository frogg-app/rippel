import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { InstalledDrawer } from './InstalledDrawer';
import { BACKEND_ID, makeModel } from './testing';

const hosts = [{ id: BACKEND_ID, name: 'desktop-6900xt', online: true }];

it('opens for a file with no known source, with its local facts and the actions', () => {
  render(
    <InstalledDrawer
      model={makeModel({ sizeBytes: 6_938_078_334 })}
      verdict={null}
      info={null}
      backendOrder={hosts}
      selectedBackendId={BACKEND_ID}
      memoryBytes={17e9}
      onClose={vi.fn()}
      onWorkflows={vi.fn()}
      onRemove={vi.fn()}
    />,
  );
  const panel = screen.getByRole('dialog', { name: 'Details of Sd Xl Base 1.0' });
  expect(panel).toHaveTextContent('Added by hand');
  expect(panel).toHaveTextContent('6.94 GB');
  expect(screen.queryByRole('link', { name: /View on Hugging Face/ })).not.toBeInTheDocument();
  expect(screen.getByText('desktop-6900xt')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Remove/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Workflows/ })).toBeInTheDocument();
});

it('links the repo a file was installed from', () => {
  render(
    <InstalledDrawer
      model={makeModel()}
      verdict={null}
      info={null}
      source={{ url: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0', how: 'install' }}
      backendOrder={hosts}
      selectedBackendId={BACKEND_ID}
      memoryBytes={null}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByRole('link', { name: /View on Hugging Face/ })).toHaveAttribute(
    'href',
    'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0',
  );
  expect(screen.getByText(/installed through rippel/)).toBeInTheDocument();
});
