import styles from './Splash.module.css';
import { Lockup } from './Mark';

/**
 * Shown only while the session round trip is in flight. It is deliberately
 * almost nothing: a flash of the lockup reads as loading, a flash of the
 * sign-in form reads as being signed out, which would be a lie.
 */
export function Splash() {
  return (
    <div className={styles.splash} role="status" aria-live="polite">
      <Lockup size={28} ripple="loop" />
    </div>
  );
}
