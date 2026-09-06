import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Mark } from '../components/Mark';
import { BackendPill } from './BackendPill';
import { QueueChip } from './QueueChip';
import { UserMenu } from './UserMenu';
import { ModeToggle } from './ModeToggle';
import { primaryBackend, totalQueueDepth, useBackends } from './useBackends';
import styles from './AppShell.module.css';

/**
 * The chrome that is on every screen.
 *
 * The Main artboard draws the top bar as one 60px band split by the input
 * panel's hairline: the wordmark sits in the left 396px over the panel colour,
 * the nav and the status chips in the rest. That is reproduced here rather than
 * in the Create screen, because PLAN.md §6 makes the status pill and queue chip
 * global — Library and Models will hang off the same bar.
 */
export function AppShell() {
  const { backends, loading, unreachable } = useBackends();
  const primary = primaryBackend(backends);
  const location = useLocation();

  // The Image/Video toggle is a property of the creation surface, not of the
  // app, so it only occupies the leading segment while Create is showing.
  const onCreate = location.pathname.startsWith('/create');

  return (
    <div className={styles.shell}>
      <header className={styles.topbar}>
        <div className={styles.leading}>
          <Mark size={28} />
          <span className={`serif ${styles.wordmark}`}>Studio</span>
          <div className={styles.spacer} />
          {onCreate ? <ModeToggle /> : null}
        </div>

        <div className={styles.bar}>
          <nav className={styles.nav}>
            <NavLink
              to="/create"
              className={({ isActive }) => (isActive ? `${styles.tab} ${styles.tabActive}` : styles.tab)}
            >
              Create
            </NavLink>
            {/* Library and Models are later phases. Shown, because the design
                shows them and their absence would be more confusing than a
                disabled tab, but honestly marked as not yet built. */}
            <span className={`${styles.tab} ${styles.tabDisabled}`} aria-disabled title="Coming in a later phase">
              Library
            </span>
            <span className={`${styles.tab} ${styles.tabDisabled}`} aria-disabled title="Coming in a later phase">
              Models
            </span>
          </nav>

          <div className={styles.status}>
            <BackendPill
              backend={primary}
              loading={loading}
              unreachable={unreachable}
              extraCount={Math.max(0, backends.length - 1)}
            />
            <QueueChip depth={totalQueueDepth(backends)} />
            <UserMenu />
          </div>
        </div>
      </header>

      <main className={styles.body}>
        <Outlet />
      </main>
    </div>
  );
}
