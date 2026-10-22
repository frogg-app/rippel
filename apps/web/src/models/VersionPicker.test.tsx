import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ModelCatalogEntry, ModelVariant } from '@comfy/shared';
import { versionTags } from './discover';
import { useVariants, variantLabel, VersionPicker, type LoadVariants } from './VersionPicker';

const variants: ModelVariant[] = [
  { path: 'flux1-dev-Q8_0.gguf', filename: 'flux1-dev-Q8_0.gguf', kind: 'gguf', precision: 'Q8_0', distilled: false },
  { path: 'flux1-dev-Q4_K_S.gguf', filename: 'flux1-dev-Q4_K_S.gguf', kind: 'gguf', precision: 'Q4_K_S', distilled: false },
];

const entry = {
  ref: 'hugging-face:city96/FLUX.1-dev-gguf',
  filename: 'flux1-dev-Q8_0.gguf',
  variants,
} as ModelCatalogEntry;

function Harness({ load, onInstall }: { load: LoadVariants; onInstall: (path: string | null) => void }) {
  const versions = useVariants(entry, load);
  return (
    <>
      <VersionPicker
        variants={versions.variants}
        memoryBytes={versions.memoryBytes}
        loading={versions.loading}
        chosen={versions.chosen}
        onChoose={versions.choose}
        backendName="steve-pc"
      />
      <button type="button" onClick={() => onInstall(versions.chosen)}>
        Install
      </button>
    </>
  );
}

describe('VersionPicker', () => {
  it('selects the version recommended for the machine, and installs the one chosen', async () => {
    const load = vi.fn<LoadVariants>(async () => ({
      memoryBytes: 12e9,
      variants: [
        { ...variants[0]!, sizeBytes: 12.7e9, recommended: false },
        { ...variants[1]!, sizeBytes: 6.8e9, recommended: true },
      ],
    }));
    const onInstall = vi.fn();
    render(<Harness load={load} onInstall={onInstall} />);

    expect(await screen.findByText('Recommended')).toBeInTheDocument();
    expect(screen.getByText('steve-pc has 12.0 GB of graphics memory')).toBeInTheDocument();
    const q4 = screen.getByRole('radio', { name: /GGUF Q4_K_S/ });
    await waitFor(() => expect(q4).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByText('6.80 GB')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Install' }));
    expect(onInstall).toHaveBeenLastCalledWith('flux1-dev-Q4_K_S.gguf');

    await userEvent.click(screen.getByRole('radio', { name: /GGUF Q8_0/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Install' }));
    expect(onInstall).toHaveBeenLastCalledWith('flux1-dev-Q8_0.gguf');
  });

  it('keeps the names to choose from when the sizes cannot be read', async () => {
    const load = vi.fn<LoadVariants>(async () => {
      throw new Error('offline');
    });
    render(<Harness load={load} onInstall={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('Reading sizes…')).not.toBeInTheDocument());
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: /GGUF Q8_0/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('labels builds the way people choose between them', () => {
    expect(variantLabel({ kind: 'full', precision: 'fp16', distilled: false })).toBe('Full (fp16)');
    expect(variantLabel({ kind: 'fp8', precision: 'fp8', distilled: true })).toBe('Smaller (fp8) · distilled');
    expect(variantLabel({ kind: 'gguf', precision: 'Q4_K_M', distilled: false })).toBe('GGUF Q4_K_M');
  });
});

describe('versionTags', () => {
  it('says which kinds of build a model comes in, for the Version filter', () => {
    expect(
      versionTags({
        ...entry,
        variants: [
          { path: 'a', filename: 'a', kind: 'full', precision: 'bf16', distilled: false },
          { path: 'b', filename: 'b', kind: 'full', precision: 'bf16', distilled: true },
          { path: 'c', filename: 'c', kind: 'fp8', precision: 'fp8', distilled: false },
        ],
      }),
    ).toEqual(['full', 'distilled', 'smaller (fp8)']);
    expect(versionTags(entry)).toEqual(['gguf']);
    // Nothing installable, nothing to filter on.
    expect(versionTags({ ...entry, installBlockedReason: 'Access required' })).toEqual([]);
  });
});
