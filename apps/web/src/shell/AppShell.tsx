import { useLayoutEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Mark } from '../components/Mark';
import { CubeIcon, ImageIcon, SparkIcon } from '../components/icons';
import { BackendPill } from './BackendPill';
import { QueueChip } from './QueueChip';
import { UserMenu } from './UserMenu';
import { ModeToggle } from './ModeToggle';
import { primaryBackend, totalQueueDepth, useBackends } from './useBackends';
import styles from './AppShell.module.css';

/**
 * The chrome that is on every screen.
 *
 * A 64px rail on the left carries the mark, the three destinations and the
 * account; the content area to its right is a rounded plate floating on the
 * ambient ground. Status (backend, queue) is a glass cluster pinned top-right
 * of the plate, so it is on every screen without any screen owning it.
 *
 * The active-tab indicator is one element that *slides* between destinations
 * rather than three that switch, which is what makes navigation feel like one
 * continuous surface.
 */
const TABS = [
  { to: '/create', label: 'Create', Icon: SparkIcon },
  { to: '/library', label: 'Library', Icon: ImageIcon },
  { to: '/models', label: 'Models', Icon: CubeIcon },
] as const;

export function AppShell() {
  const { backends, loading, unreachable } = useBackends();
  const primary = primaryBackend(backends);
  const location = useLocation();
  const onCreate = location.pathname.startsWith('/create');

  // The sliding indicator: measured off the active link, so it is right at any
  // rail size and after any font swap.
  const navRef = useRef<HTMLElement>(null);
  const [indicator, setIndicator] = useState<{ top: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const active = nav.querySelector<HTMLElement>('[aria-current="page"]');
    if (!active) {
      setIndicator(null);
      return;
    }
    setIndicator({ top: active.offsetTop, height: active.offsetHeight });
  }, [location.pathname]);

  // Re-key the outlet on each top-level route so the plate content plays its
  // entrance again; sub-state within a screen never re-mounts.
  const section = location.pathname.split('/')[1] ?? '';

  return (
    <div className={styles.shell}>
      <aside className={styles.rail}>
        <NavLink to="/create" className={styles.brand} aria-label="rippel home">
          <Mark size={22} />
        </NavLink>

        <nav ref={navRef} className={styles.nav} aria-label="Primary">
          {indicator ? (
            <span
              className={styles.indicator}
              style={{ transform: `translateY(${indicator.top}px)`, height: indicator.height }}
              aria-hidden
            />
          ) : null}
          {TABS.map(({ to, label, Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => (isActive ? `${styles.tab} ${styles.tabActive}` : styles.tab)}
            >
              <Icon size={19} />
              <span className={styles.tabLabel}>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className={styles.railFoot}>
          <UserMenu placement="rail" />
        </div>
      </aside>

      <div className={styles.plateWrap}>
        <header className={styles.topbar}>
          <div className={styles.topLeading}>{onCreate ? <ModeToggle /> : null}</div>
          <div className={styles.status}>
            <QueueChip depth={totalQueueDepth(backends)} />
            <BackendPill
              backend={primary}
              loading={loading}
              unreachable={unreachable}
              extraCount={Math.max(0, backends.length - 1)}
            />
          </div>
        </header>

        <main className={styles.plate}>
          {/* Keyed per screen so the entrance plays on navigation only. */}
          <div key={section} className={styles.screen}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
