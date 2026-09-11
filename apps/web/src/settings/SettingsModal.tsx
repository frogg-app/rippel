import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from '../library/icons';
import { ServerIcon } from '../components/icons';
import { DeploymentsSection } from './DeploymentsSection';
import { Mark } from '../components/Mark';
import { deploymentsApi as defaultApi, type DeploymentsApi } from '../lib/api-deployments';
import styles from './SettingsModal.module.css';

type Section = 'backends' | 'about';

const SECTION_TITLE: Record<Section, string> = {
  backends: 'Backends',
  about: 'About',
};

export function SettingsModal({
  open,
  onClose,
  api = defaultApi,
  version = __APP_VERSION__,
}: {
  open: boolean;
  onClose: () => void;
  api?: DeploymentsApi;
  version?: string;
}) {
  const [section, setSection] = useState<Section>('backends');
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    // Focus lands inside the sheet, on the first section button.
    sheet.current?.querySelector<HTMLElement>('button')?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className={styles.backdrop} onClick={onClose}>
      <div
        ref={sheet}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(event) => event.stopPropagation()}
      >
        <aside className={styles.railCol}>
          <div className={styles.railHead}>Settings</div>
          <nav className={styles.sections} aria-label="Settings sections">
            <button
              type="button"
              className={section === 'backends' ? `${styles.sectionTab} ${styles.sectionOn}` : styles.sectionTab}
              aria-current={section === 'backends' ? 'page' : undefined}
              onClick={() => setSection('backends')}
            >
              <ServerIcon size={15} />
              Backends
            </button>
            <button
              type="button"
              className={section === 'about' ? `${styles.sectionTab} ${styles.sectionOn}` : styles.sectionTab}
              aria-current={section === 'about' ? 'page' : undefined}
              onClick={() => setSection('about')}
            >
              <Mark size={13} />
              About
            </button>
          </nav>
        </aside>

        <div className={styles.pane}>
          <header className={styles.paneHead}>
            <span className={styles.paneTitle}>{SECTION_TITLE[section]}</span>
            <button type="button" className={styles.close} onClick={onClose} aria-label="Close settings">
              <CloseIcon size={16} />
            </button>
          </header>
          <div className={styles.paneBody} key={section}>
            {section === 'backends' ? (
              <DeploymentsSection api={api} />
            ) : (
              <AboutSection version={version} />
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- about

function AboutSection({ version }: { version: string }) {
  return (
    <div className={styles.section}>
      <div className={styles.about}>
        <Mark size={40} ripple="hover" />
        <div>
          <div className={styles.aboutName}>rippel</div>
          <div className={`mono ${styles.aboutVersion}`}>version {version}</div>
        </div>
      </div>
      <p className={styles.blurb}>
        A generation studio in front of your own ComfyUI. Everything you make stays on machines you
        run.
      </p>
    </div>
  );
}
