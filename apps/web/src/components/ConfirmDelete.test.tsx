/**
 * The delete confirm's contract: what it says, where focus goes, the ways
 * out, and what a slow or failing deletion looks like.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './Button';
import { DeleteButton } from './ConfirmDelete';

function show(onConfirm: () => Promise<unknown> | void = vi.fn()) {
  render(
    <div>
      <span>outside</span>
      <DeleteButton
        aria-label="Remove Model Weights 0306"
        confirmTitle="Delete this file?"
        confirmBody="Model Weights 0306 will be removed from steve-pc."
        onConfirm={onConfirm}
      />
    </div>,
  );
  return screen.getByRole('button', { name: 'Remove Model Weights 0306' });
}

describe('Button', () => {
  it('is a type=button with its variant, and busy disables it', () => {
    const { rerender } = render(<Button variant="danger">Delete</Button>);
    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('data-variant', 'danger');
    expect(button).toBeEnabled();
    rerender(<Button variant="danger" busy>Delete</Button>);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
  });
});

describe('DeleteButton and ConfirmDelete', () => {
  it('asks with the action as the title and one line of body, focused on Cancel', async () => {
    const onConfirm = vi.fn();
    const trigger = show(onConfirm);
    expect(trigger).toHaveAttribute('data-variant', 'danger-soft');
    expect(trigger).toHaveTextContent('Remove');
    await userEvent.click(trigger);
    const ask = screen.getByRole('alertdialog', { name: 'Delete this file?' });
    expect(ask).toHaveAccessibleDescription('Model Weights 0306 will be removed from steve-pc.');
    const cancel = within(ask).getByRole('button', { name: 'Cancel' });
    expect(cancel).toHaveFocus();
    expect(within(ask).getByRole('button', { name: 'Delete' })).toHaveAttribute('data-variant', 'danger');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('cancels on Esc, on Cancel and on a click outside, returning focus to the trigger', async () => {
    const onConfirm = vi.fn();
    const trigger = show(onConfirm);
    await userEvent.click(trigger);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(trigger).toHaveFocus();

    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await userEvent.click(trigger);
    fireEvent.mouseDown(screen.getByText('outside'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('shows busy while deleting, then closes', async () => {
    let finish!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    await userEvent.click(show(onConfirm));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const busy = screen.getByRole('button', { name: 'Deleting…' });
    expect(busy).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    // Esc does nothing mid-flight.
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    finish();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('says why in one line on failure, and stays open to try again', async () => {
    const onConfirm = vi.fn().mockRejectedValueOnce(new Error('steve-pc did not answer.')).mockResolvedValueOnce(undefined);
    await userEvent.click(show(onConfirm));
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('steve-pc did not answer.');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });
});
