import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/context';
import { initial } from '../lib/format';
import { SignOutIcon } from '../components/icons';
import styles from './UserMenu.module.css';

/** The avatar chip at the far right, and the one thing behind it: sign out. */
export function UserMenu() {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!user) return null;

  return (
    <div className={styles.wrap} ref={container}>
      <button
        type="button"
        className={styles.avatar}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${user.email}`}
        onClick={() => setOpen((was) => !was)}
      >
        {initial(user.displayName, user.email)}
      </button>

      {open ? (
        <div className={styles.menu} role="menu">
          <div className={styles.identity}>
            <div className={styles.name}>{user.displayName ?? user.email}</div>
            {user.displayName ? <div className={styles.email}>{user.email}</div> : null}
            {user.role === 'admin' ? <div className={styles.role}>Administrator</div> : null}
          </div>
          <button type="button" role="menuitem" className={styles.item} onClick={() => void signOut()}>
            <SignOutIcon size={15} />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
