import styles from './Splash.module.css';
import { Mark } from './Mark';

/**
 * Shown only while the session round trip is in flight. It is deliberately
 * almost nothing: a flash of the wordmark reads as loading, a flash of the
 * sign-in form reads as being signed out, which would be a lie.
 */
export function Splash() {
  return (
    <div className={styles.splash} role="status" aria-live="polite">
      <Mark size={34} />
      <span className={styles.text}>Studio</span>
    </div>
  );
}
