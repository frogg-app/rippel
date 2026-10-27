/**
 * The app's button, for actions that are not part of a bespoke control.
 *
 * Most screens grew their own `.action`/`.rowAction` classes, which is why a
 * destructive action could ship as plain text in one place and as an outline
 * button in another. New actions, and every delete, use this so the variants
 * mean the same thing everywhere:
 *
 *   primary      the one thing the section is for (accent outline, filled on hover)
 *   secondary    an ordinary action
 *   quiet        the way out, such as Cancel
 *   danger       the confirming press of something that destroys data (solid red)
 *   danger-soft  the trigger that leads to a danger confirm (red-tinted)
 *
 * Sizes follow the two heights already in use: `sm` is the 28px row action on
 * cards and notices, `md` the 40px `--action-height` of settings and drawers.
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger' | 'danger-soft';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  /** Pill ends, to sit among the pill-shaped row actions on model cards. */
  pill?: boolean;
  /** Shows a spinner and blocks presses; the label stays, so nothing jumps. */
  busy?: boolean;
  icon?: ReactNode;
}

const VARIANT: Record<ButtonVariant, string | undefined> = {
  primary: styles.primary,
  secondary: styles.secondary,
  quiet: styles.quiet,
  danger: styles.danger,
  'danger-soft': styles.dangerSoft,
};

/** The same look for an <a>, which must stay a link to navigate. */
export function buttonClass(variant: ButtonVariant = 'secondary', size: 'sm' | 'md' = 'sm'): string {
  return [styles.button, VARIANT[variant], styles[size]].filter(Boolean).join(' ');
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'sm', pill = false, busy = false, icon, className, children, disabled, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={[styles.button, VARIANT[variant], styles[size], pill ? styles.pill : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      data-variant={variant}
      {...rest}
    >
      {busy ? <span className={styles.spinner} aria-hidden /> : icon ? <span className={styles.icon} aria-hidden>{icon}</span> : null}
      {children}
    </button>
  );
});
