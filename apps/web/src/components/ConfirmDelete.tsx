/**
 * Asking before something is destroyed, the same way everywhere.
 *
 * A small panel hangs off the button that opened it. Its title is the action
 * ("Delete this file?"), its body one line saying what goes and from where,
 * and its two buttons sit right-aligned on one row: Cancel, quiet, and the
 * danger button. Focus starts on Cancel so a stray Enter keeps the file; Esc,
 * a click outside, and Cancel all back out. While the deletion runs the
 * danger button spins and nothing else can be pressed; a failure is said in
 * one line inside the panel, which stays open so it can be tried again.
 *
 * `DeleteButton` is the usual way in: the red-tinted trigger and this panel,
 * wired together. Use `ConfirmDelete` directly only when the trigger has to be
 * something else.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Button, type ButtonProps } from './Button';
import { useAnchoredPosition, useDismissOnOutside } from './useAnchoredPosition';
import styles from './ConfirmDelete.module.css';

const PANEL_WIDTH = 300;
const PANEL_HEIGHT = 150;

export interface ConfirmDeleteProps {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  /** The question, as the action: "Delete this file?" */
  title: string;
  /** One line: what goes, and from where. */
  body: ReactNode;
  confirmLabel?: string;
  busyLabel?: string;
  /** Runs the deletion. A rejection keeps the panel open with its message. */
  onConfirm: () => Promise<unknown> | void;
  onCancel: () => void;
  /** After a successful confirm. Defaults to closing via onCancel. */
  onDone?: () => void;
}

function message(cause: unknown): string {
  return cause instanceof Error && cause.message ? cause.message : 'That did not work. Try again.';
}

export function ConfirmDelete({
  anchorRef,
  open,
  title,
  body,
  confirmLabel = 'Delete',
  busyLabel = 'Deleting…',
  onConfirm,
  onCancel,
  onDone,
}: ConfirmDeleteProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const bodyId = useId();
  const position = useAnchoredPosition(anchorRef, open, {
    width: PANEL_WIDTH,
    maxHeight: PANEL_HEIGHT,
    minHeight: PANEL_HEIGHT,
    align: 'end',
    offset: 6,
  });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const cancel = () => {
    if (busy) return;
    onCancel();
  };

  useEffect(() => {
    if (!open) {
      setBusy(false);
      setError(null);
    }
  }, [open]);

  // Focus to Cancel on open, and back to the trigger on close.
  useLayoutEffect(() => {
    if (!open || !position) return;
    cancelRef.current?.focus();
  }, [open, position !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    return () => {
      if (anchor?.isConnected) anchor.focus();
    };
  }, [open, anchorRef]);

  useDismissOnOutside(open, [panelRef, anchorRef], cancel);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.preventDefault();
        cancel();
      }
    };
    // Capture, so a drawer's own Esc handler does not close the drawer too.
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  });

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      if (!mounted.current) return;
      setBusy(false);
      (onDone ?? onCancel)();
    } catch (cause) {
      if (!mounted.current) return;
      setBusy(false);
      setError(message(cause));
      confirmRef.current?.focus();
    }
  };

  // Tab stays between the two buttons while the question is open.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const first = cancelRef.current;
    const last = confirmRef.current;
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!open || !position || typeof document === 'undefined') return null;

  // Flipped above: pin the bottom edge to the trigger so a short panel does
  // not float a gap away from it.
  const anchorTop = anchorRef.current?.getBoundingClientRect().top ?? 0;
  const style = position.up
    ? { left: position.left, width: position.width, bottom: window.innerHeight - anchorTop + 6 }
    : { left: position.left, width: position.width, top: position.top };

  return createPortal(
    <div
      ref={panelRef}
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className={`${styles.panel} ${position.up ? styles.up : ''}`}
      style={style}
      onKeyDown={onKeyDown}
    >
      <p id={titleId} className={styles.title}>
        {title}
      </p>
      <p id={bodyId} className={styles.body}>
        {body}
      </p>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button ref={cancelRef} variant="quiet" onClick={cancel} disabled={busy}>
          Cancel
        </Button>
        <Button ref={confirmRef} variant="danger" busy={busy} onClick={() => void confirm()}>
          {busy ? busyLabel : error ? 'Try again' : confirmLabel}
        </Button>
      </div>
    </div>,
    document.body,
  );
}

export interface DeleteButtonProps extends Omit<ButtonProps, 'onClick' | 'title' | 'variant'> {
  /** The trigger's words. */
  label?: string;
  /** The confirm's title, as the action. */
  confirmTitle: string;
  confirmBody: ReactNode;
  confirmLabel?: string;
  busyLabel?: string;
  onConfirm: () => Promise<unknown> | void;
  /** Hover text on the trigger. */
  hint?: string;
}

/** The red-tinted trigger with its confirm attached. */
export function DeleteButton({
  label = 'Remove',
  confirmTitle,
  confirmBody,
  confirmLabel,
  busyLabel,
  onConfirm,
  hint,
  icon,
  ...rest
}: DeleteButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        ref={ref}
        variant="danger-soft"
        icon={icon ?? <TrashGlyph />}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={hint}
        onClick={() => setOpen((value) => !value)}
        {...rest}
      >
        {label}
      </Button>
      <ConfirmDelete
        anchorRef={ref}
        open={open}
        title={confirmTitle}
        body={confirmBody}
        confirmLabel={confirmLabel}
        busyLabel={busyLabel}
        onConfirm={onConfirm}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

/** A bin, drawn to the 12px row-action grid. */
export function TrashGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5" />
    </svg>
  );
}
