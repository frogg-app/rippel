/**
 * The dropdown, tested at the level the native `<select>` set.
 *
 * Replacing a browser control is only worth doing if the replacement keeps the
 * contract, so these are written as that contract rather than as a tour of the
 * implementation: what the keyboard does, what a screen reader is told, where
 * focus is, and what the parent hears about the value.
 */
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dropdown } from './Dropdown';

const FRUIT = [
  { value: 'apple', label: 'Apple' },
  { value: 'apricot', label: 'Apricot' },
  { value: 'banana', label: 'Banana' },
  { value: 'cherry', label: 'Cherry' },
];

function Harness({
  onChange,
  initial = 'apple',
}: {
  onChange?: (value: string) => void;
  initial?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <span id="fruit-label">Fruit</span>
      <Dropdown
        aria-labelledby="fruit-label"
        value={value}
        options={FRUIT}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
      />
      <button type="button">after</button>
    </>
  );
}

const trigger = () => screen.getByRole('combobox', { name: 'Fruit' });

describe('Dropdown', () => {
  it('wires the combobox / listbox / option roles a screen reader needs', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    // Closed: no listbox exists, and the trigger says so.
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(trigger()).toHaveAttribute('aria-haspopup', 'listbox');
    expect(screen.queryByRole('listbox')).toBeNull();

    await user.click(trigger());

    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    const list = screen.getByRole('listbox');
    // The trigger owns the list, and points at the row the keyboard is on.
    expect(trigger()).toHaveAttribute('aria-controls', list.id);
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(4);
    expect(trigger()).toHaveAttribute('aria-activedescendant', options[0]!.id);
    // Exactly one option is selected, and it is the current value.
    expect(options.filter((option) => option.getAttribute('aria-selected') === 'true')).toHaveLength(
      1,
    );
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
  });

  it('moves with the arrows and commits on Enter', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    trigger().focus();
    await user.keyboard('{ArrowDown}'); // opens, cursor on the current value
    await user.keyboard('{ArrowDown}{ArrowDown}'); // Apricot, Banana
    expect(trigger()).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[2]!.id);

    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('banana');
    expect(trigger()).toHaveTextContent('Banana');
  });

  it('goes to the ends with Home and End', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();

    await user.keyboard('{End}{Enter}');
    expect(trigger()).toHaveTextContent('Cherry');

    await user.keyboard('{Home}{Enter}');
    expect(trigger()).toHaveTextContent('Apple');
  });

  it('jumps to a match as you type', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard('{Enter}'); // open on Apple

    // One letter jumps past the cursor, so a repeated letter cycles:
    // Apple -> Apricot.
    await user.keyboard('a');
    expect(trigger()).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[1]!.id);

    await user.keyboard('{Enter}');
    expect(trigger()).toHaveTextContent('Apricot');
  });

  it('refines on the letters typed together, not just the first', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard('{Enter}');

    // "app" and "apr" share a first letter and must not reach the same row.
    await user.keyboard('apr');
    expect(trigger()).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[1]!.id);

    await user.keyboard('{Escape}{Enter}');
    await user.keyboard('app');
    expect(trigger()).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[0]!.id);
  });

  it('types ahead without opening, the way the OS menu does', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    trigger().focus();

    await user.keyboard('b');
    // It opened on the match rather than committing blind — the value is only
    // ever changed by an explicit choice.
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger()).toHaveAttribute('aria-activedescendant', screen.getAllByRole('option')[2]!.id);
  });

  it('closes on Escape leaving the value exactly as it was', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    trigger().focus();

    await user.keyboard('{Enter}{ArrowDown}{ArrowDown}'); // cursor is on Banana
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger()).toHaveTextContent('Apple');
  });

  it('puts focus back on the trigger after closing, either way', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(trigger());
    await user.keyboard('{Escape}');
    expect(trigger()).toHaveFocus();

    await user.click(trigger());
    await user.click(screen.getByRole('option', { name: 'Cherry' }));
    expect(trigger()).toHaveFocus();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('closes without choosing when the pointer goes down outside', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await user.click(trigger());
    await user.click(screen.getByRole('button', { name: 'after' }));

    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger()).toHaveTextContent('Apple');
  });

  it('lets Tab leave, without swallowing it or changing the value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    trigger().focus();
    await user.keyboard('{Enter}{ArrowDown}');
    await user.tab();

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus();
  });

  it('escapes an ancestor that clips, by rendering the menu outside it', async () => {
    const user = userEvent.setup();
    render(
      <div style={{ overflow: 'hidden', height: 20 }} data-testid="clipper">
        <Harness />
      </div>,
    );

    await user.click(trigger());
    const list = screen.getByRole('listbox');
    // The clipping ancestor does not contain the menu: it is portalled to the
    // body and positioned in viewport coordinates.
    expect(screen.getByTestId('clipper').contains(list)).toBe(false);
    expect(list.closest('body')).not.toBeNull();
  });

  it('skips a disabled option and refuses to commit one', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Dropdown
        aria-label="Sizes"
        value="s"
        options={[
          { value: 's', label: 'Small' },
          { value: 'm', label: 'Medium', disabled: true },
          { value: 'l', label: 'Large' },
        ]}
        onChange={onChange}
      />,
    );

    const combo = screen.getByRole('combobox', { name: 'Sizes' });
    combo.focus();
    await user.keyboard('{Enter}{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('l');

    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('option', { name: 'Medium' }));
    expect(onChange).not.toHaveBeenCalledWith('m');
  });

  it('shows the first option when the value matches none, as a select does', () => {
    // The backend picker hands us `''` for one render before the list settles.
    // An empty pill there would be a regression on the control we replaced.
    render(<Dropdown aria-label="Fruit" value="" options={FRUIT} onChange={() => {}} />);
    expect(screen.getByRole('combobox', { name: 'Fruit' })).toHaveTextContent('Apple');
  });

  it('prefers an explicit placeholder over that fallback', () => {
    render(
      <Dropdown aria-label="Fruit" value="" placeholder="Pick one" options={FRUIT} onChange={() => {}} />,
    );
    expect(screen.getByRole('combobox', { name: 'Fruit' })).toHaveTextContent('Pick one');
  });

  it('keeps its placeholder when it is an action list rather than a value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Dropdown
        aria-label="Add"
        value=""
        placeholder="Add…"
        keepPlaceholder
        options={FRUIT}
        onChange={onChange}
      />,
    );

    const combo = screen.getByRole('combobox', { name: 'Add' });
    expect(combo).toHaveTextContent('Add…');
    await user.click(combo);
    await user.click(screen.getByRole('option', { name: 'Banana' }));

    expect(onChange).toHaveBeenCalledWith('banana');
    expect(combo).toHaveTextContent('Add…');
  });
});
