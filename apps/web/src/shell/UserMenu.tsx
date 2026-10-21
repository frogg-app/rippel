import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/context';
import { SettingsIcon, SignOutIcon, UserIcon } from '../components/icons';
import { SettingsModal } from '../settings/SettingsModal';
import styles from './UserMenu.module.css';

/** A settings shortcut for those allowed in, and the account button behind which is sign out. */
export function UserMenu({ placement = 'bar' }: { placement?: 'bar' | 'rail' }) {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
    <div className={placement === 'rail' ? `${styles.wrap} ${styles.rail}` : styles.wrap} ref={container}>
      {user.role === 'admin' || user.settingsAccess ? (
        <button
          type="button"
          className={styles.settingsButton}
          aria-label="Settings"
          title="Settings"
          aria-haspopup="dialog"
          aria-expanded={settingsOpen}
          onClick={() => { setOpen(false); setSettingsOpen(true); }}
        >
          <SettingsIcon size={20} />
        </button>
      ) : null}
      <button
        type="button"
        className={styles.accountButton}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${user.email}`}
        onClick={() => setOpen((was) => !was)}
      >
        <UserIcon size={19} />
      </button>

      {open ? (
        <div className={`${styles.menu} pop`} role="menu">
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

      {user.role === 'admin' || user.settingsAccess ? (
        <SettingsModal currentUser={user} open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      ) : null}
    </div>
  );
}
